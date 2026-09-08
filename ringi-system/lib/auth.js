'use strict';
// 認証: パスワードハッシュ (scrypt) / セッション (Cookie) / ログイン試行制限
const crypto = require('node:crypto');

const SESSION_TTL_SEC = 7 * 24 * 60 * 60;   // セッション有効期間: 7日
const MAX_FAILS = 5;                         // 連続失敗回数の上限
const LOCK_SEC = 60;                         // ロック時間 (秒)
const PASSWORD_MIN = 8;

class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---- パスワード ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}
function validatePassword(pw) {
  const s = (pw ?? '').toString();
  if (s.length < PASSWORD_MIN) throw new AuthError(400, `パスワードは${PASSWORD_MIN}文字以上で設定してください`);
  if (s.length > 128) throw new AuthError(400, 'パスワードが長すぎます');
  return s;
}
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const publicUser = (u) => { if (!u) return null; const { password_hash, ...rest } = u; return rest; };

function createAuth(db) {
  const fails = new Map(); // login_id → { count, lockedUntil }

  function cleanupExpired() {
    db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now','localtime')`).run();
  }

  function login(loginId, password, userAgent = '') {
    loginId = (loginId ?? '').toString().trim();
    password = (password ?? '').toString();
    if (!loginId || !password) throw new AuthError(400, 'ログインIDとパスワードを入力してください');
    const f = fails.get(loginId);
    if (f && f.lockedUntil > Date.now()) throw new AuthError(429, `ログイン失敗が続いたため一時的にロックされています（約${Math.ceil((f.lockedUntil - Date.now()) / 1000)}秒後に再試行できます）`);
    const u = db.prepare('SELECT * FROM users WHERE login_id = ?').get(loginId);
    if (!u || !u.active || !verifyPassword(password, u.password_hash)) {
      const n = (f && f.lockedUntil && f.lockedUntil <= Date.now() ? 0 : (f?.count || 0)) + 1;
      fails.set(loginId, { count: n, lockedUntil: n >= MAX_FAILS ? Date.now() + LOCK_SEC * 1000 : 0 });
      throw new AuthError(401, 'ログインIDまたはパスワードが正しくありません');
    }
    fails.delete(loginId);
    cleanupExpired();
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, datetime('now','localtime', ?), ?)`)
      .run(tokenHash(token), u.id, `+${SESSION_TTL_SEC} seconds`, userAgent.slice(0, 200));
    return { token, user: publicUser(u) };
  }

  // Cookie のトークンからユーザーを解決 (期限切れ/無効ユーザーは null)
  function resolve(token) {
    if (!token) return null;
    const row = db.prepare(`SELECT s.id AS sid, u.* FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.id = ? AND s.expires_at >= datetime('now','localtime')`).get(tokenHash(token));
    if (!row || !row.active) return null;
    db.prepare(`UPDATE sessions SET last_seen_at = datetime('now','localtime') WHERE id = ?`).run(row.sid);
    const { sid, ...u } = row;
    return publicUser(u);
  }

  function logout(token) {
    if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenHash(token));
  }
  function logoutAll(userId) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  // 本人によるパスワード変更 (現在のパスワードが必要)
  function changePassword(userId, current, next, keepToken) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!u || !verifyPassword((current ?? '').toString(), u.password_hash)) throw new AuthError(400, '現在のパスワードが正しくありません');
    const pw = validatePassword(next);
    if (pw === current) throw new AuthError(400, '新しいパスワードは現在のものと異なる値にしてください');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), userId);
    // 他端末のセッションを無効化 (現在のセッションは維持)
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, keepToken ? tokenHash(keepToken) : '');
    return { ok: true };
  }

  return { login, logout, logoutAll, resolve, changePassword, SESSION_TTL_SEC };
}

module.exports = { createAuth, hashPassword, verifyPassword, validatePassword, publicUser, AuthError, PASSWORD_MIN };
