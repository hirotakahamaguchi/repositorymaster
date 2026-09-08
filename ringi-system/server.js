'use strict';
// 株式会社MANEXION 稟議システム HTTP サーバー (依存パッケージなし: node:http + node:sqlite)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('./lib/db');
const { createService, ApiError } = require('./lib/workflow');
const { createAuth, AuthError } = require('./lib/auth');
const { createBackup, listBackups, deleteBackup, exportCsv, tableDefs, TABLE_KEYS } = require('./lib/backup');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function createApp({ dbPath = path.join(__dirname, 'data', 'ringi.db'), backupDir = process.env.RINGI_BACKUP_DIR || path.join(__dirname, 'backups') } = {}) {
  const db = open(dbPath);
  const svc = createService(db);
  const auth = createAuth(db);

  // ---- ルーティング ----
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, public: !!opts.public });

  // ---- 認証 ----
  const COOKIE = 'sid';
  const cookieAttrs = (req) => `Path=/; HttpOnly; SameSite=Lax${(process.env.RINGI_SECURE_COOKIE === '1' || req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : ''}`;
  route('POST',   '/api/auth/login',         ({ body, req }) => {
    const { token, user } = auth.login(body.login_id, body.password, req.headers['user-agent'] || '');
    return { __cookie: `${COOKIE}=${token}; Max-Age=${auth.SESSION_TTL_SEC}; ${cookieAttrs(req)}`, __body: user };
  }, { public: true });
  route('POST',   '/api/auth/logout',        ({ token, req }) => { auth.logout(token); return { __cookie: `${COOKIE}=; Max-Age=0; ${cookieAttrs(req)}`, __body: { ok: true } }; }, { public: true });
  route('POST',   '/api/auth/password',      ({ user, body, token }) => auth.changePassword(user.id, body.current_password, body.new_password, token));
  route('GET',    '/api/me',                 ({ user }) => user);
  route('GET',    '/api/users',              ({ user, query }) => (query.get('all') ? svc.users.listAll(user) : svc.users.list()));
  route('POST',   '/api/users',              ({ user, body }) => svc.users.create(user, body));
  route('PUT',    '/api/users/:id',          ({ user, params, body }) => svc.users.update(user, +params.id, body));
  route('GET',    '/api/constants',          () => svc.constants);

  route('GET',    '/api/templates',          () => svc.templates.list());
  route('POST',   '/api/templates',          ({ user, body }) => svc.templates.create(user, body));
  route('GET',    '/api/templates/:id',      ({ params }) => svc.templates.get(+params.id));
  route('GET',    '/api/templates/:id/resolve', ({ params, query }) => svc.templates.resolve(+params.id, Number(query.get('amount') || 0)));
  route('PUT',    '/api/templates/:id',      ({ user, params, body }) => svc.templates.update(user, +params.id, body));
  route('DELETE', '/api/templates/:id',      ({ user, params }) => svc.templates.remove(user, +params.id));

  route('GET',    '/api/ringi',              ({ user, query }) => svc.ringi.list(user, { filter: query.get('filter') || 'all', status: query.get('status') || '', q: query.get('q') || '' }));
  route('GET',    '/api/ringi/counts',       ({ user }) => svc.ringi.counts(user));
  route('POST',   '/api/ringi',              ({ user, body }) => svc.ringi.create(user, body));
  route('GET',    '/api/ringi/:id',          ({ user, params }) => svc.ringi.detail(user, +params.id));
  route('PUT',    '/api/ringi/:id',          ({ user, params, body }) => svc.ringi.update(user, +params.id, body));
  route('DELETE', '/api/ringi/:id',          ({ user, params }) => svc.ringi.remove(user, +params.id));
  route('POST',   '/api/ringi/:id/submit',   ({ user, params, body }) => svc.ringi.submit(user, +params.id, body.comment));
  route('POST',   '/api/ringi/:id/approve',  ({ user, params, body }) => svc.ringi.approve(user, +params.id, body.comment));
  route('POST',   '/api/ringi/:id/reject',   ({ user, params, body }) => svc.ringi.reject(user, +params.id, body.comment));
  route('POST',   '/api/ringi/:id/return',   ({ user, params, body }) => svc.ringi.sendBack(user, +params.id, body));
  route('POST',   '/api/ringi/:id/withdraw', ({ user, params, body }) => svc.ringi.withdraw(user, +params.id, body.comment));
  route('POST',   '/api/ringi/:id/comment',  ({ user, params, body }) => svc.ringi.comment(user, +params.id, body.comment));
  // ---- バックアップ (管理者のみ): 全データを 1 フォルダに出力 / 一覧 / 削除 / CSV 個別ダウンロード ----
  const requireAdmin = (user) => { if (user.role !== 'admin') throw new ApiError(403, '管理者のみ実行できます'); };
  route('GET',    '/api/admin/backups',      ({ user }) => { requireAdmin(user); const defs = tableDefs(db); return { dir: backupDir, tables: TABLE_KEYS.map((k) => ({ key: k, title: defs[k].title })), backups: listBackups(backupDir) }; });
  route('POST',   '/api/admin/backups',      ({ user }) => { requireAdmin(user); return createBackup(db, { baseDir: backupDir }); });
  route('DELETE', '/api/admin/backups/:name', ({ user, params }) => { requireAdmin(user); try { deleteBackup(backupDir, params.name); } catch (e) { throw new ApiError(400, e.message); } return { ok: true }; });
  route('GET',    '/api/admin/export/:table', ({ user, params }) => {
    requireAdmin(user);
    const key = params.table.replace(/\.csv$/, '');
    if (!TABLE_KEYS.includes(key)) throw new ApiError(404, '不明なテーブルです');
    const body = Buffer.from(exportCsv(db, key).csv, 'utf8');
    return { __raw: { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': body.length, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(key + '.csv')}` }, body } };
  });
  // 添付ファイルのダウンロード (バイナリ応答)
  route('GET',    '/api/ringi/:id/attachments/:aid', ({ user, params }) => {
    const a = svc.ringi.attachment(user, +params.id, +params.aid);
    return { __raw: { headers: { 'Content-Type': a.mime, 'Content-Length': a.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}` }, body: Buffer.from(a.data) } };
  });

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 80_000_000) throw new ApiError(413, 'リクエストが大きすぎます'); chunks.push(c); }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ApiError(400, 'JSON の形式が不正です'); }
  }

  function parseCookies(header) {
    const out = {};
    for (const part of (header || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  const sendJson = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  function serveStatic(req, res, pathname) {
    let p = pathname === '/' ? '/index.html' : pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { // SPA フォールバック
        if (!path.extname(p)) return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => { if (e2) { res.writeHead(404); return res.end('Not Found'); } res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(d2); });
        res.writeHead(404); return res.end('Not Found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    try {
      const m = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!m) throw new ApiError(404, 'API が見つかりません');
      // CSRF 対策: 更新系は fetch からのカスタムヘッダを必須にする (SameSite=Lax Cookie と併用)
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') throw new ApiError(403, '不正なリクエストです (X-Requested-With ヘッダがありません)');
      // 認証: Cookie のセッショントークンからユーザーを解決
      const token = parseCookies(req.headers.cookie)[COOKIE] || '';
      const user = auth.resolve(token);
      if (!user && !m.public) throw new ApiError(401, 'ログインが必要です');
      const params = url.pathname.match(m.re).groups || {};
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const result = await m.handler({ user, token, params, query: url.searchParams, body, req });
      if (result && result.__raw) { res.writeHead(200, result.__raw.headers); return res.end(result.__raw.body); }
      if (result && result.__cookie) { res.setHeader('Set-Cookie', result.__cookie); return sendJson(res, 200, result.__body); }
      sendJson(res, 200, result);
    } catch (e) {
      if (e instanceof ApiError || e instanceof AuthError) return sendJson(res, e.status, { error: e.message });
      console.error(e);
      sendJson(res, 500, { error: 'サーバーエラーが発生しました' });
    }
  });

  return { server, db, svc, auth };
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createApp({ dbPath: process.env.RINGI_DB || path.join(__dirname, 'data', 'ringi.db') });
  server.listen(port, () => console.log(`株式会社MANEXION 稟議システム起動: http://localhost:${port}`));
}
