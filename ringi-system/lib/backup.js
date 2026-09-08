'use strict';
// バックアップ: 全データを 1 フォルダにまとめて出力 (CSV + 添付ファイル実体 + SQLite 完全コピー)
const fs = require('node:fs');
const path = require('node:path');
const { STATUS, STEP_STATUS, ACTION } = require('./workflow');

const BOM = '﻿';

// ---- CSV ----
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// columns: [{ key, label }]
function toCsv(rows, columns) {
  const lines = [columns.map((c) => csvCell(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

// ---- 出力対象テーブル定義 (キー = ファイル名) ----
function tableDefs(db) {
  const modeLabel = (m) => (m === 'all' ? '全員承認' : '1人承認');
  const decisionLabel = (d) => ({ approved: '承認', rejected: '却下', returned: '差戻し' }[d] || '');
  return {
    users: {
      title: 'ユーザー',
      rows: () => db.prepare('SELECT id, login_id, name, dept, title, role, is_approver, active FROM users ORDER BY id').all(),
      columns: [
        { key: 'id', label: 'ID' }, { key: 'login_id', label: 'ログインID' }, { key: 'name', label: '氏名' }, { key: 'dept', label: '部署' }, { key: 'title', label: '役職' },
        { key: 'role', label: '役割', get: (r) => (r.role === 'admin' ? '管理者' : '一般') }, { key: 'is_approver', label: '承認者', get: (r) => (r.is_approver ? '○' : '') }, { key: 'active', label: '有効', get: (r) => (r.active ? '○' : '無効') },
      ],
    },
    route_templates: {
      title: '承認ルートテンプレート',
      rows: () => db.prepare('SELECT * FROM route_templates ORDER BY id').all(),
      columns: [{ key: 'id', label: 'ID' }, { key: 'name', label: 'テンプレート名' }, { key: 'description', label: '説明' }, { key: 'created_at', label: '作成日時' }],
    },
    route_template_steps: {
      title: 'テンプレートのステップ',
      rows: () => db.prepare(`SELECT s.*, t.name AS template_name,
                                (SELECT group_concat(u.name, ' / ') FROM route_template_step_approvers a JOIN users u ON u.id = a.user_id WHERE a.step_id = s.id) AS approver_names,
                                (SELECT group_concat(a.user_id, ' / ') FROM route_template_step_approvers a WHERE a.step_id = s.id) AS approver_ids
                              FROM route_template_steps s JOIN route_templates t ON t.id = s.template_id ORDER BY s.template_id, s.seq`).all(),
      columns: [
        { key: 'id', label: 'ステップID' }, { key: 'template_id', label: 'テンプレートID' }, { key: 'template_name', label: 'テンプレート名' }, { key: 'seq', label: '順序' }, { key: 'name', label: 'ステップ名' },
        { key: 'mode', label: '承認方式', get: (r) => modeLabel(r.mode) }, { key: 'min_amount', label: '適用最低金額' }, { key: 'approver_ids', label: '承認者ID' }, { key: 'approver_names', label: '承認者' },
      ],
    },
    ringi: {
      title: '稟議',
      rows: () => db.prepare(`SELECT r.*, u.name AS applicant_name, u.dept AS applicant_dept, t.name AS template_name,
                                (SELECT COUNT(*) FROM attachments a WHERE a.ringi_id = r.id) AS attachment_count
                              FROM ringi r JOIN users u ON u.id = r.applicant_id LEFT JOIN route_templates t ON t.id = r.template_id ORDER BY r.id`).all(),
      columns: [
        { key: 'id', label: 'ID' }, { key: 'number', label: '稟議番号' }, { key: 'title', label: '件名' }, { key: 'category', label: '区分' }, { key: 'amount', label: '金額' },
        { key: 'status', label: 'ステータス', get: (r) => STATUS[r.status] || r.status }, { key: 'status_code', label: 'ステータスコード', get: (r) => r.status },
        { key: 'applicant_id', label: '申請者ID' }, { key: 'applicant_name', label: '申請者' }, { key: 'applicant_dept', label: '申請者部署' },
        { key: 'desired_date', label: '希望期日' }, { key: 'vendor', label: '支払先' }, { key: 'template_id', label: 'テンプレートID' }, { key: 'template_name', label: '承認ルート', get: (r) => r.template_name || '個別指定' },
        { key: 'current_seq', label: '現在ステップ' }, { key: 'round', label: '申請回数' }, { key: 'attachment_count', label: '添付数' },
        { key: 'created_at', label: '作成日時' }, { key: 'submitted_at', label: '申請日時' }, { key: 'completed_at', label: '完了日時' }, { key: 'updated_at', label: '更新日時' }, { key: 'body', label: '内容' },
      ],
    },
    ringi_items: {
      title: '稟議の明細',
      rows: () => {
        const out = [];
        for (const r of db.prepare('SELECT id, number, items_json FROM ringi ORDER BY id').all()) {
          let items = []; try { items = JSON.parse(r.items_json || '[]'); } catch { items = []; }
          items.forEach((it, i) => out.push({ ringi_id: r.id, number: r.number, line_no: i + 1, name: it.name, qty: it.qty, unit_price: it.unit_price, amount: (Number(it.qty) || 0) * (Number(it.unit_price) || 0), note: it.note || '' }));
        }
        return out;
      },
      columns: [{ key: 'ringi_id', label: '稟議ID' }, { key: 'number', label: '稟議番号' }, { key: 'line_no', label: '行' }, { key: 'name', label: '品目' }, { key: 'qty', label: '数量' }, { key: 'unit_price', label: '単価' }, { key: 'amount', label: '金額' }, { key: 'note', label: '備考' }],
    },
    ringi_steps: {
      title: '稟議の承認ステップ',
      rows: () => db.prepare('SELECT s.*, r.number FROM ringi_steps s JOIN ringi r ON r.id = s.ringi_id ORDER BY s.ringi_id, s.seq').all(),
      columns: [
        { key: 'id', label: 'ステップID' }, { key: 'ringi_id', label: '稟議ID' }, { key: 'number', label: '稟議番号' }, { key: 'seq', label: '順序' }, { key: 'name', label: 'ステップ名' },
        { key: 'mode', label: '承認方式', get: (r) => modeLabel(r.mode) }, { key: 'status', label: '状態', get: (r) => STEP_STATUS[r.status] || r.status }, { key: 'activated_at', label: '到達日時' }, { key: 'completed_at', label: '完了日時' },
      ],
    },
    ringi_step_approvers: {
      title: '承認者の判断',
      rows: () => db.prepare(`SELECT a.*, s.ringi_id, s.seq, s.name AS step_name, r.number, u.name AS user_name
                              FROM ringi_step_approvers a JOIN ringi_steps s ON s.id = a.step_id JOIN ringi r ON r.id = s.ringi_id JOIN users u ON u.id = a.user_id
                              ORDER BY s.ringi_id, s.seq, a.id`).all(),
      columns: [
        { key: 'id', label: 'ID' }, { key: 'ringi_id', label: '稟議ID' }, { key: 'number', label: '稟議番号' }, { key: 'seq', label: 'ステップ順序' }, { key: 'step_name', label: 'ステップ名' },
        { key: 'user_id', label: '承認者ID' }, { key: 'user_name', label: '承認者' }, { key: 'decision', label: '判断', get: (r) => decisionLabel(r.decision) }, { key: 'decided_at', label: '判断日時' }, { key: 'comment', label: 'コメント' },
      ],
    },
    history: {
      title: '操作履歴',
      rows: () => db.prepare('SELECT h.*, r.number, u.name AS actor_name FROM history h JOIN ringi r ON r.id = h.ringi_id JOIN users u ON u.id = h.actor_id ORDER BY h.id').all(),
      columns: [
        { key: 'id', label: 'ID' }, { key: 'ringi_id', label: '稟議ID' }, { key: 'number', label: '稟議番号' }, { key: 'created_at', label: '日時' }, { key: 'actor_id', label: '操作者ID' }, { key: 'actor_name', label: '操作者' },
        { key: 'action', label: '操作', get: (r) => ACTION[r.action] || r.action }, { key: 'from_status', label: '変更前', get: (r) => STATUS[r.from_status] || r.from_status || '' }, { key: 'to_status', label: '変更後', get: (r) => STATUS[r.to_status] || r.to_status || '' },
        { key: 'step_seq', label: 'ステップ' }, { key: 'step_name', label: 'ステップ名' }, { key: 'target_seq', label: '差戻し先', get: (r) => (r.action === 'return' ? (r.target_seq === 0 ? '申請者' : `ステップ${r.target_seq}`) : '') },
        { key: 'round', label: '申請回' }, { key: 'comment', label: 'コメント' },
      ],
    },
    attachments: {
      title: '添付ファイル一覧',
      rows: () => db.prepare(`SELECT a.id, a.ringi_id, r.number, a.filename, a.mime, a.size, a.uploaded_by, u.name AS uploaded_by_name, a.created_at
                              FROM attachments a JOIN ringi r ON r.id = a.ringi_id JOIN users u ON u.id = a.uploaded_by ORDER BY a.id`).all(),
      columns: [
        { key: 'id', label: 'ID' }, { key: 'ringi_id', label: '稟議ID' }, { key: 'number', label: '稟議番号' }, { key: 'filename', label: 'ファイル名' }, { key: 'mime', label: '種類' }, { key: 'size', label: 'サイズ(byte)' },
        { key: 'uploaded_by', label: '登録者ID' }, { key: 'uploaded_by_name', label: '登録者' }, { key: 'created_at', label: '登録日時' }, { key: 'saved_as', label: 'バックアップ内のファイル', get: (r) => `attachments/${attachmentFileName(r)}` },
      ],
    },
  };
}
const TABLE_KEYS = ['users', 'route_templates', 'route_template_steps', 'ringi', 'ringi_items', 'ringi_steps', 'ringi_step_approvers', 'history', 'attachments'];

const attachmentFileName = (a) => `${a.number}_${a.id}_${a.filename}`.replace(/[\\/:*?"<>|]/g, '_');

function exportCsv(db, key) {
  const defs = tableDefs(db);
  const d = defs[key];
  if (!d) throw new Error(`unknown table: ${key}`);
  const rows = d.rows();
  return { csv: toCsv(rows, d.columns), count: rows.length, title: d.title };
}

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// ---- バックアップ作成 ----
function createBackup(db, { baseDir, now = new Date() }) {
  fs.mkdirSync(baseDir, { recursive: true });
  let name = `backup_${stamp(now)}`;
  let dir = path.join(baseDir, name);
  for (let i = 2; fs.existsSync(dir); i++) { name = `backup_${stamp(now)}_${i}`; dir = path.join(baseDir, name); }
  fs.mkdirSync(dir);
  const manifest = { name, created_at: now.toISOString(), app: 'ringi-system', format: 1, tables: {}, files: [] };

  // 1) CSV
  for (const key of TABLE_KEYS) {
    const { csv, count, title } = exportCsv(db, key);
    const file = `${key}.csv`;
    fs.writeFileSync(path.join(dir, file), csv, 'utf8');
    manifest.tables[key] = { title, rows: count, file };
    manifest.files.push(file);
  }
  // 2) 添付ファイル実体
  const attDir = path.join(dir, 'attachments');
  fs.mkdirSync(attDir);
  const atts = db.prepare('SELECT a.id, a.filename, a.data, r.number FROM attachments a JOIN ringi r ON r.id = a.ringi_id ORDER BY a.id').all();
  for (const a of atts) fs.writeFileSync(path.join(attDir, attachmentFileName(a)), Buffer.from(a.data));
  manifest.attachments = atts.length;
  // 3) SQLite 完全コピー (整合性の取れたスナップショット)
  const dbCopy = path.join(dir, 'ringi.db');
  db.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
  manifest.files.push('ringi.db');
  manifest.db_size = fs.statSync(dbCopy).size;
  // 4) manifest / README
  fs.writeFileSync(path.join(dir, 'README.txt'), readmeText(manifest), 'utf8');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  manifest.dir = dir;
  manifest.size = dirSize(dir);
  return manifest;
}

function readmeText(m) {
  const lines = [
    '株式会社MANEXION 稟議システム バックアップ',
    `作成日時: ${m.created_at}`,
    '',
    '[内容]',
    ...TABLE_KEYS.map((k) => `  ${m.tables[k].file.padEnd(30)} ${m.tables[k].title} (${m.tables[k].rows} 件)`),
    `  attachments/                   添付ファイルの実体 (${m.attachments} 件) — ファイル名: <稟議番号>_<添付ID>_<元のファイル名>`,
    '  ringi.db                       SQLite データベースの完全コピー (復元用)',
    '  manifest.json                  このバックアップのメタ情報',
    '',
    '[CSV について]',
    '  UTF-8 (BOM 付き)・CRLF 改行。Excel でそのまま開けます。',
    '  ユーザー CSV にパスワードは含まれません (パスワードハッシュは ringi.db にのみ含まれます)。',
    '',
    '[復元方法]',
    '  サーバーを停止し、data/ringi.db をこのフォルダの ringi.db で置き換えてから再起動してください。',
    '',
  ];
  return BOM + lines.join('\r\n');
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

const BACKUP_NAME_RE = /^backup_\d{8}_\d{6}(_\d+)?$/;

function listBackups(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && BACKUP_NAME_RE.test(e.name))
    .map((e) => {
      const dir = path.join(baseDir, e.name);
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { /* 壊れている/作成途中 */ }
      return {
        name: e.name, dir, created_at: manifest?.created_at || fs.statSync(dir).mtime.toISOString(), size: dirSize(dir),
        tables: manifest?.tables || null, attachments: manifest?.attachments ?? null, complete: !!manifest,
      };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

function deleteBackup(baseDir, name) {
  if (!BACKUP_NAME_RE.test(name)) throw new Error('不正なバックアップ名です');
  const dir = path.join(baseDir, name);
  if (!fs.existsSync(dir)) throw new Error('バックアップが見つかりません');
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { createBackup, listBackups, deleteBackup, exportCsv, toCsv, TABLE_KEYS, tableDefs, BACKUP_NAME_RE };
