'use strict';
// CLI: データベースのバックアップを 1 フォルダに出力する
//   node backup.js                → ./backups/backup_YYYYMMDD_HHMMSS/
//   node backup.js <出力先ディレクトリ>
//   環境変数 RINGI_DB (DBパス), RINGI_BACKUP_DIR (既定の出力先)
const path = require('node:path');
const { open } = require('./lib/db');
const { createBackup } = require('./lib/backup');

const dbPath = process.env.RINGI_DB || path.join(__dirname, 'data', 'ringi.db');
const baseDir = process.argv[2] || process.env.RINGI_BACKUP_DIR || path.join(__dirname, 'backups');

const db = open(dbPath);
const m = createBackup(db, { baseDir });
db.close();

console.log(`バックアップを作成しました: ${m.dir}`);
for (const [k, t] of Object.entries(m.tables)) console.log(`  ${t.file.padEnd(30)} ${t.title} ${t.rows} 件`);
console.log(`  attachments/                   添付ファイル ${m.attachments} 件`);
console.log(`  ringi.db                       DB コピー ${(m.db_size / 1024).toFixed(1)} KB`);
console.log(`合計サイズ: ${(m.size / 1024).toFixed(1)} KB`);
