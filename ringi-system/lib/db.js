'use strict';
// SQLite (Node.js 組み込み node:sqlite) によるデータ層
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { hashPassword } = require('./auth');

const DEFAULT_PASSWORD = 'password'; // 初期データ / 既存DBマイグレーション時の初期パスワード (要変更)

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  dept       TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin' (管理者: ユーザー/ルート管理が可能)
  is_approver INTEGER NOT NULL DEFAULT 0,     -- 承認者フラグ: 1 のユーザーのみ承認ルートの承認者に指定できる
  active      INTEGER NOT NULL DEFAULT 1,     -- 0 = 無効 (ログイン・新規指定不可)
  login_id      TEXT,                          -- ログインID (一意: idx_users_login)
  password_hash TEXT                           -- scrypt ハッシュ (lib/auth.js)
);

-- 承認ルートのテンプレート
CREATE TABLE IF NOT EXISTS route_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS route_template_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES route_templates(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'any',   -- 'any': 誰か1人承認で進む / 'all': 全員承認で進む
  min_amount  INTEGER,                        -- 金額がこの値未満なら当該ステップはスキップ (NULL=常に適用)
  UNIQUE(template_id, seq)
);
CREATE TABLE IF NOT EXISTS route_template_step_approvers (
  step_id  INTEGER NOT NULL REFERENCES route_template_steps(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (step_id, user_id)
);

-- 稟議本体
CREATE TABLE IF NOT EXISTS ringi (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  number          TEXT NOT NULL UNIQUE,      -- R-2026-0001
  title           TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT '',
  amount          INTEGER NOT NULL DEFAULT 0,
  body            TEXT NOT NULL DEFAULT '',
  applicant_id    INTEGER NOT NULL REFERENCES users(id),
  template_id     INTEGER REFERENCES route_templates(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'draft',
    -- draft(下書き) | pending(承認中) | approved(承認済) | rejected(却下) | returned(差戻し中) | withdrawn(取下げ)
  current_seq     INTEGER,                    -- 現在の承認ステップ (pending時のみ)
  round           INTEGER NOT NULL DEFAULT 0, -- 申請回数 (再申請で+1)
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  submitted_at    TEXT,
  completed_at    TEXT
);

-- 稟議ごとの承認ステップ (テンプレートのスナップショット or 個別指定)
CREATE TABLE IF NOT EXISTS ringi_steps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ringi_id     INTEGER NOT NULL REFERENCES ringi(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  name         TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'any',
  status       TEXT NOT NULL DEFAULT 'waiting',
    -- waiting(未到達) | active(承認待ち) | approved(承認済) | returned(差戻し) | rejected(却下)
  activated_at TEXT,
  completed_at TEXT,
  UNIQUE(ringi_id, seq)
);
CREATE TABLE IF NOT EXISTS ringi_step_approvers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id    INTEGER NOT NULL REFERENCES ringi_steps(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  decision   TEXT,                            -- NULL | approved | rejected | returned
  decided_at TEXT,
  comment    TEXT NOT NULL DEFAULT '',
  UNIQUE(step_id, user_id)
);

-- 監査ログ / タイムライン
CREATE TABLE IF NOT EXISTS history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ringi_id     INTEGER NOT NULL REFERENCES ringi(id) ON DELETE CASCADE,
  actor_id     INTEGER NOT NULL REFERENCES users(id),
  action       TEXT NOT NULL,
    -- create | update | submit | resubmit | approve | reject | return | withdraw | comment
  from_status  TEXT,
  to_status    TEXT,
  step_seq     INTEGER,
  step_name    TEXT,
  target_seq   INTEGER,                       -- return 時の差戻し先 (0 = 申請者)
  round        INTEGER NOT NULL DEFAULT 0,
  comment      TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_history_ringi ON history(ringi_id, id);
CREATE INDEX IF NOT EXISTS idx_ringi_status ON ringi(status);

-- 添付ファイル (デモ用に SQLite BLOB へ保存)
CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ringi_id    INTEGER NOT NULL REFERENCES ringi(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
  size        INTEGER NOT NULL,
  data        BLOB NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_ringi ON attachments(ringi_id);
`;

// カラム追加マイグレーション後に適用するスキーマ
const POST_SCHEMA = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login ON users(login_id);

-- ログインセッション (id = トークンの SHA-256)
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT,
  user_agent   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;

// 初期ユーザー (ログインIDは既存DBのマイグレーション時の推定にも使う)
const SEED_USERS = [
  { login_id: 'yamada',    name: '山田 太郎', dept: '営業部', title: '担当',           role: 'user',  is_approver: 0 }, // 1 申請者
  { login_id: 'sato',      name: '佐藤 花子', dept: '営業部', title: '課長',           role: 'user',  is_approver: 1 }, // 2 承認者
  { login_id: 'suzuki',    name: '鈴木 一郎', dept: '営業部', title: '部長',           role: 'user',  is_approver: 1 }, // 3 承認者
  { login_id: 'takahashi', name: '高橋 美咲', dept: '経理部', title: '課長',           role: 'user',  is_approver: 1 }, // 4 承認者
  { login_id: 'tanaka',    name: '田中 健',   dept: '経理部', title: '部長',           role: 'user',  is_approver: 1 }, // 5 承認者
  { login_id: 'watanabe',  name: '渡辺 社長', dept: '経営',   title: '代表取締役',     role: 'admin', is_approver: 1 }, // 6 承認者 + 管理者
  { login_id: 'ito',       name: '伊藤 次郎', dept: '開発部', title: '担当',           role: 'user',  is_approver: 0 }, // 7 申請者2
  { login_id: 'admin',     name: '中村 管理', dept: '総務部', title: 'システム管理者', role: 'admin', is_approver: 0 }, // 8 管理者
];

// 既存 DB への追加カラム (存在しなければ追加)
const MIGRATIONS = [
  ['ringi', 'desired_date', "TEXT NOT NULL DEFAULT ''"],   // 希望期日 (YYYY-MM-DD)
  ['ringi', 'vendor',       "TEXT NOT NULL DEFAULT ''"],   // 支払先 / 取引先
  ['ringi', 'items_json',   "TEXT NOT NULL DEFAULT '[]'"], // 明細行 [{name, qty, unit_price}]
  ['users', 'is_approver',  "INTEGER NOT NULL DEFAULT 0"], // 承認者フラグ
  ['users', 'login_id',     "TEXT"],                        // ログインID
  ['users', 'password_hash', "TEXT"],                       // パスワードハッシュ
];
function migrate(db) {
  for (const [table, col, def] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      // 既存DB: 既にルート上で承認者になっているユーザーへ承認者フラグを付与
      if (table === 'users' && col === 'is_approver') {
        db.exec(`UPDATE users SET is_approver = 1 WHERE id IN (
                   SELECT user_id FROM route_template_step_approvers UNION SELECT user_id FROM ringi_step_approvers)`);
      }
    }
  }
  // 既存DB: ログインID / パスワード未設定のユーザーに付与 (初期データと同じ並びなら同じID、それ以外は user<ID>)
  const missing = db.prepare('SELECT id, name FROM users WHERE login_id IS NULL OR password_hash IS NULL').all();
  if (missing.length) {
    const taken = new Set(db.prepare('SELECT login_id FROM users WHERE login_id IS NOT NULL').all().map((r) => r.login_id));
    const upd = db.prepare('UPDATE users SET login_id = COALESCE(login_id, ?), password_hash = COALESCE(password_hash, ?) WHERE id = ?');
    const defaultHash = hashPassword(DEFAULT_PASSWORD);
    for (const u of missing) {
      const seed = SEED_USERS[u.id - 1];
      let login = seed && seed.name === u.name ? seed.login_id : `user${u.id}`;
      if (taken.has(login)) login = `user${u.id}`;
      taken.add(login);
      upd.run(login, defaultHash, u.id);
    }
  }
  db.exec(POST_SCHEMA);
}

function open(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  migrate(db);
  seedIfEmpty(db);
  return db;
}

function seedIfEmpty(db) {
  const n = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (n > 0) return;

  const insUser = db.prepare('INSERT INTO users (name, dept, title, role, is_approver, login_id, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const pw = hashPassword(DEFAULT_PASSWORD);
  for (const u of SEED_USERS) insUser.run(u.name, u.dept, u.title, u.role, u.is_approver, u.login_id, pw);

  const insT = db.prepare('INSERT INTO route_templates (name, description) VALUES (?, ?)');
  const insS = db.prepare('INSERT INTO route_template_steps (template_id, seq, name, mode, min_amount) VALUES (?, ?, ?, ?, ?)');
  const insA = db.prepare('INSERT INTO route_template_step_approvers (step_id, user_id) VALUES (?, ?)');

  // テンプレート1: 一般経費 (金額条件付き)
  let t = insT.run('一般経費申請', '課長 → 部長(10万円以上) → 経理 → 社長(100万円以上)').lastInsertRowid;
  let s;
  s = insS.run(t, 1, '課長承認', 'any', null).lastInsertRowid;     insA.run(s, 2);
  s = insS.run(t, 2, '部長承認', 'any', 100000).lastInsertRowid;   insA.run(s, 3);
  s = insS.run(t, 3, '経理確認', 'any', null).lastInsertRowid;     insA.run(s, 4); insA.run(s, 5);
  s = insS.run(t, 4, '社長決裁', 'any', 1000000).lastInsertRowid;  insA.run(s, 6);

  // テンプレート2: 契約締結 (全員承認ステップあり)
  t = insT.run('契約締結', '課長 → 営業部長+経理部長(全員) → 社長').lastInsertRowid;
  s = insS.run(t, 1, '課長承認', 'any', null).lastInsertRowid;     insA.run(s, 2);
  s = insS.run(t, 2, '部長合議', 'all', null).lastInsertRowid;     insA.run(s, 3); insA.run(s, 5);
  s = insS.run(t, 3, '社長決裁', 'any', null).lastInsertRowid;     insA.run(s, 6);

  // テンプレート3: 簡易 (1段階)
  t = insT.run('簡易承認 (課長のみ)', '少額・軽微な申請向け').lastInsertRowid;
  s = insS.run(t, 1, '課長承認', 'any', null).lastInsertRowid;     insA.run(s, 2);
}

module.exports = { open, SEED_USERS, DEFAULT_PASSWORD };
