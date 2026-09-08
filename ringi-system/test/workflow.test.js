'use strict';
// ワークフローの結合テスト (node:test) — HTTP 経由で API を叩く
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

let server, base;
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ringi-test-backups-'));
before(async () => {
  ({ server } = createApp({ dbPath: ':memory:', backupDir }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(backupDir, { recursive: true, force: true }); });

// シード: 1=山田(申請者) 2=佐藤課長 3=鈴木部長 4=高橋経理課長 5=田中経理部長 6=社長 7=伊藤 8=管理者
// ログインID → パスワード (テスト内で追加したユーザーは CREDS に登録する)
const CREDS = { 1: ['yamada', 'password'], 2: ['sato', 'password'], 3: ['suzuki', 'password'], 4: ['takahashi', 'password'], 5: ['tanaka', 'password'], 6: ['watanabe', 'password'], 7: ['ito', 'password'], 8: ['admin', 'password'] };
const HDR = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };
const cookies = new Map();
async function rawLogin(login_id, password) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: HDR, body: JSON.stringify({ login_id, password }) });
  return { status: res.status, data: await res.json(), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
async function loginAs(userId) {
  const [login_id, password] = CREDS[userId];
  const r = await rawLogin(login_id, password);
  assert.equal(r.status, 200, `login ${login_id}: ${JSON.stringify(r.data)}`);
  cookies.set(userId, r.cookie);
  return r.cookie;
}
const cookieFor = async (userId) => cookies.get(userId) || loginAs(userId);
async function call(user, method, path, body) {
  const res = await fetch(base + path, { method, headers: { ...HDR, Cookie: await cookieFor(user) }, body: body && JSON.stringify(body) });
  const data = await res.json();
  return { status: res.status, data };
}
const ok = async (...a) => { const r = await call(...a); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
const fail = async (expected, ...a) => { const r = await call(...a); assert.equal(r.status, expected, JSON.stringify(r.data)); return r.data; };
const stepStatuses = (r) => r.steps.map((s) => s.status).join(',');

test('テンプレート: 金額条件でステップが解決される', async () => {
  const small = await ok(1, 'GET', '/api/templates/1/resolve?amount=50000');
  assert.deepEqual(small.map((s) => s.name), ['課長承認', '経理確認']);
  const big = await ok(1, 'GET', '/api/templates/1/resolve?amount=1500000');
  assert.deepEqual(big.map((s) => s.name), ['課長承認', '部長承認', '経理確認', '社長決裁']);
});

test('多段階承認: 課長→部長→経理 で承認済になる', async () => {
  let r = await ok(1, 'POST', '/api/ringi', { title: 'ノートPC購入', category: '購買', amount: 200000, body: '開発用', template_id: 1, submit: true });
  assert.equal(r.status, 'pending'); assert.equal(r.round, 1); assert.equal(r.current_seq, 1);
  assert.equal(stepStatuses(r), 'active,waiting,waiting');
  assert.match(r.number, /^R-\d{4}-\d{4}$/);

  // 承認者以外は承認できない
  await fail(403, 3, 'POST', `/api/ringi/${r.id}/approve`, {});
  // 承認待ち一覧に課長のみ出る
  assert.equal((await ok(2, 'GET', '/api/ringi?filter=inbox')).length, 1);
  assert.equal((await ok(3, 'GET', '/api/ringi?filter=inbox')).length, 0);

  r = await ok(2, 'POST', `/api/ringi/${r.id}/approve`, { comment: 'OK' });
  assert.equal(r.current_seq, 2); assert.equal(stepStatuses(r), 'approved,active,waiting');
  // 同じ人が二度承認はできない / 既に通過したステップの人も不可
  await fail(403, 2, 'POST', `/api/ringi/${r.id}/approve`, {});
  r = await ok(3, 'POST', `/api/ringi/${r.id}/approve`, {});
  assert.equal(r.current_seq, 3);
  // 経理は any モード: 高橋 or 田中 のどちらかで通る
  r = await ok(5, 'POST', `/api/ringi/${r.id}/approve`, {});
  assert.equal(r.status, 'approved'); assert.equal(r.current_seq, null); assert.ok(r.completed_at);
  assert.equal(stepStatuses(r), 'approved,approved,approved');
  assert.deepEqual(r.history.map((h) => h.action), ['create', 'submit', 'approve', 'approve', 'approve']);
  // 承認済みは編集・取下げ不可
  await fail(400, 1, 'PUT', `/api/ringi/${r.id}`, { title: 'x', template_id: 1 });
  await fail(400, 1, 'POST', `/api/ringi/${r.id}/withdraw`, {});
});

test('全員承認(all)モード: 全員が承認するまで進まない', async () => {
  let r = await ok(1, 'POST', '/api/ringi', { title: '業務委託契約', amount: 300000, template_id: 2, submit: true });
  r = await ok(2, 'POST', `/api/ringi/${r.id}/approve`, {});
  assert.equal(r.current_seq, 2);
  r = await ok(3, 'POST', `/api/ringi/${r.id}/approve`, {});
  assert.equal(r.current_seq, 2, '1人目だけではステップが完了しない');
  assert.equal(r.steps[1].status, 'active');
  await fail(400, 3, 'POST', `/api/ringi/${r.id}/approve`, {}); // 判断済み
  r = await ok(5, 'POST', `/api/ringi/${r.id}/approve`, {});
  assert.equal(r.current_seq, 3);
  r = await ok(6, 'POST', `/api/ringi/${r.id}/approve`, {});
  assert.equal(r.status, 'approved');
});

test('差戻し(申請者へ): 修正して再申請するとステップ1からやり直し', async () => {
  let r = await ok(1, 'POST', '/api/ringi', { title: '出張費', amount: 80000, template_id: 1, submit: true });
  r = await ok(2, 'POST', `/api/ringi/${r.id}/approve`, {});
  // 理由なしの差戻しは不可
  await fail(400, 4, 'POST', `/api/ringi/${r.id}/return`, { target_seq: 0, comment: '' });
  r = await ok(4, 'POST', `/api/ringi/${r.id}/return`, { target_seq: 0, comment: '領収書の内訳を追記してください' });
  assert.equal(r.status, 'returned'); assert.equal(r.current_seq, null);
  assert.equal(r.steps[1].status, 'returned');
  assert.equal(r.perms.can_approve, false);
  // 申請者視点: 編集・再申請できる
  const mine = await ok(1, 'GET', `/api/ringi/${r.id}`);
  assert.equal(mine.perms.can_edit, true); assert.equal(mine.perms.can_submit, true);
  // 他人は編集不可
  await fail(403, 7, 'GET', `/api/ringi/${r.id}`); // 関係者でないので閲覧不可
  await fail(403, 2, 'PUT', `/api/ringi/${r.id}`, { title: 'x', template_id: 1 });
  // 編集 + 再申請
  r = await ok(1, 'PUT', `/api/ringi/${r.id}`, { title: '出張費（内訳追記）', amount: 80000, body: '交通費 60,000 / 宿泊 20,000', template_id: 1, submit: true, comment: '修正しました' });
  assert.equal(r.status, 'pending'); assert.equal(r.round, 2); assert.equal(r.current_seq, 1);
  assert.equal(stepStatuses(r), 'active,waiting');
  assert.ok(r.steps.every((s) => s.approvers.every((a) => a.decision == null)), '判断はリセットされる');
  assert.deepEqual(r.history.map((h) => h.action), ['create', 'submit', 'approve', 'return', 'update', 'resubmit']);
  assert.equal(r.history[3].target_seq, 0);
  // 再度 課長→経理 で承認
  r = await ok(2, 'POST', `/api/ringi/${r.id}/approve`, {});
  r = await ok(4, 'POST', `/api/ringi/${r.id}/approve`, {});
  assert.equal(r.status, 'approved');
});

test('差戻し(前ステップへ): 指定ステップから再承認', async () => {
  let r = await ok(1, 'POST', '/api/ringi', { title: '大型設備', amount: 2000000, template_id: 1, submit: true });
  r = await ok(2, 'POST', `/api/ringi/${r.id}/approve`, {});
  r = await ok(3, 'POST', `/api/ringi/${r.id}/approve`, {});
  r = await ok(4, 'POST', `/api/ringi/${r.id}/approve`, {});
  assert.equal(r.current_seq, 4);
  // 社長視点の差戻し先候補: 申請者 + ステップ1..3
  const v = await ok(6, 'GET', `/api/ringi/${r.id}`);
  assert.deepEqual(v.perms.return_targets.map((t) => t.seq), [0, 1, 2, 3]);
  // 現在より後/同じステップには差し戻せない
  await fail(400, 6, 'POST', `/api/ringi/${r.id}/return`, { target_seq: 4, comment: 'x' });
  // ステップ2(部長)へ差戻し
  r = await ok(6, 'POST', `/api/ringi/${r.id}/return`, { target_seq: 2, comment: '部長、見積りの再確認を' });
  assert.equal(r.status, 'pending'); assert.equal(r.current_seq, 2);
  assert.equal(stepStatuses(r), 'approved,active,waiting,waiting');
  assert.equal(r.steps[2].approvers.find((a) => a.user_id === 4).decision, null, '経理の判断はクリアされる');
  assert.equal(r.steps[0].approvers[0].decision, 'approved', 'ステップ1の判断は保持');
  // 部長→経理→社長 で完了
  r = await ok(3, 'POST', `/api/ringi/${r.id}/approve`, { comment: '再確認済' });
  r = await ok(5, 'POST', `/api/ringi/${r.id}/approve`, {});
  r = await ok(6, 'POST', `/api/ringi/${r.id}/approve`, {});
  assert.equal(r.status, 'approved');
  assert.equal(r.history.filter((h) => h.action === 'approve').length, 6);
});

test('却下: 理由必須、却下後は操作不可', async () => {
  let r = await ok(1, 'POST', '/api/ringi', { title: '却下案件', amount: 10000, template_id: 3, submit: true });
  await fail(400, 2, 'POST', `/api/ringi/${r.id}/reject`, { comment: '' });
  r = await ok(2, 'POST', `/api/ringi/${r.id}/reject`, { comment: '予算超過' });
  assert.equal(r.status, 'rejected'); assert.equal(r.steps[0].status, 'rejected');
  await fail(400, 2, 'POST', `/api/ringi/${r.id}/approve`, {});
  await fail(400, 1, 'POST', `/api/ringi/${r.id}/submit`, {});
});

test('下書き・取下げ・個別ルート・コメント', async () => {
  // 下書き保存 → 削除
  let d = await ok(1, 'POST', '/api/ringi', { title: '下書き', template_id: 3 });
  assert.equal(d.status, 'draft');
  assert.equal((await ok(2, 'GET', '/api/ringi?filter=inbox')).some((x) => x.id === d.id), false);
  await ok(1, 'DELETE', `/api/ringi/${d.id}`);
  await fail(404, 1, 'GET', `/api/ringi/${d.id}`);

  // 個別ルート (伊藤 → 鈴木部長 + 社長(全員))
  let r = await ok(7, 'POST', '/api/ringi', { title: '個別ルート', amount: 0, steps: [{ name: '部長', mode: 'any', approver_ids: [3] }, { name: '役員合議', mode: 'all', approver_ids: [5, 6] }], submit: true });
  assert.equal(r.template, null); assert.equal(r.steps.length, 2);
  // 承認者不在のステップは弾く
  await fail(400, 7, 'POST', '/api/ringi', { title: 'x', steps: [{ name: 'a', approver_ids: [] }] });
  // コメント
  r = await ok(3, 'POST', `/api/ringi/${r.id}/comment`, { comment: '見積書を添付してください' });
  assert.equal(r.history.at(-1).action, 'comment');
  // 取下げ
  r = await ok(7, 'POST', `/api/ringi/${r.id}/withdraw`, { comment: '要件変更' });
  assert.equal(r.status, 'withdrawn'); assert.equal(r.perms.can_edit, false);
  await fail(400, 3, 'POST', `/api/ringi/${r.id}/approve`, {});
});

test('テンプレート管理は管理者のみ', async () => {
  await fail(403, 1, 'POST', '/api/templates', { name: 'x', steps: [{ name: 'a', approver_ids: [2] }] });
  const t = await ok(8, 'POST', '/api/templates', { name: 'テスト', description: 'd', steps: [{ name: 'A', mode: 'any', approver_ids: [2], min_amount: 0 }, { name: 'B', mode: 'all', approver_ids: [3, 5], min_amount: 500000 }] });
  assert.equal(t.steps.length, 2); assert.equal(t.steps[1].min_amount, 500000);
  const u = await ok(8, 'PUT', `/api/templates/${t.id}`, { name: 'テスト2', steps: [{ name: 'A', approver_ids: [2] }] });
  assert.equal(u.name, 'テスト2'); assert.equal(u.steps.length, 1);
  await ok(8, 'DELETE', `/api/templates/${t.id}`);
  await fail(404, 8, 'GET', `/api/templates/${t.id}`);
});

test('認証: 未ログインは 401 / ログイン・ログアウト / 失敗制限 / CSRF ヘッダ', async () => {
  assert.equal((await fetch(base + '/api/ringi')).status, 401);
  assert.equal((await fetch(base + '/api/me')).status, 401);
  // 不正なパスワード
  let r = await rawLogin('yamada', 'wrong'); assert.equal(r.status, 401);
  r = await rawLogin('nobody', 'password'); assert.equal(r.status, 401);
  // 正常ログイン → Cookie で /api/me が取れる (password_hash は返さない)
  r = await rawLogin('yamada', 'password'); assert.equal(r.status, 200); assert.equal(r.data.login_id, 'yamada'); assert.equal(r.data.password_hash, undefined);
  const me = await fetch(base + '/api/me', { headers: { Cookie: r.cookie } }).then((x) => x.json());
  assert.equal(me.id, 1); assert.equal(me.password_hash, undefined);
  // CSRF ヘッダなしの更新系は 403
  assert.equal((await fetch(base + '/api/ringi', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: r.cookie }, body: '{}' })).status, 403);
  // ログアウト → 同じ Cookie では 401
  assert.equal((await fetch(base + '/api/auth/logout', { method: 'POST', headers: { ...HDR, Cookie: r.cookie } })).status, 200);
  assert.equal((await fetch(base + '/api/me', { headers: { Cookie: r.cookie } })).status, 401);
  // 連続失敗でロック (5回目以降 429)、正しいパスワードでもロック中は不可
  for (let i = 0; i < 5; i++) assert.equal((await rawLogin('sato', 'bad-password')).status, 401);
  r = await rawLogin('sato', 'password'); assert.equal(r.status, 429, '正しいパスワードでもロック中は拒否');
});

test('認証: パスワード変更 (本人) と管理者による再設定', async () => {
  await loginAs(5); // 田中でログイン
  // 現在のパスワードが違う / 短すぎる
  assert.equal((await call(5, 'POST', '/api/auth/password', { current_password: 'x', new_password: 'NewPass123' })).status, 400);
  assert.equal((await call(5, 'POST', '/api/auth/password', { current_password: 'password', new_password: 'short' })).status, 400);
  await ok(5, 'POST', '/api/auth/password', { current_password: 'password', new_password: 'NewPass123' });
  // 旧パスワードは不可、新パスワードで可。現在のセッションは維持される
  assert.equal((await rawLogin('tanaka', 'password')).status, 401);
  assert.equal((await rawLogin('tanaka', 'NewPass123')).status, 200);
  await ok(5, 'GET', '/api/me');
  CREDS[5] = ['tanaka', 'NewPass123'];
  // 管理者がパスワード再設定 → 既存セッションは無効化される
  await ok(8, 'PUT', '/api/users/5', { password: 'ResetByAdmin1' });
  assert.equal((await fetch(base + '/api/me', { headers: { Cookie: cookies.get(5) } })).status, 401);
  cookies.delete(5); CREDS[5] = ['tanaka', 'ResetByAdmin1'];
  await ok(5, 'GET', '/api/me');
  // ログインID重複 / 形式不正
  await fail(400, 8, 'PUT', '/api/users/5', { login_id: 'sato' });
  await fail(400, 8, 'PUT', '/api/users/5', { login_id: 'ab' });
  await fail(400, 8, 'POST', '/api/users', { name: 'x', login_id: 'newuser', password: 'short' });
});

test('申請フォーム項目: 明細合計・希望期日・支払先・添付の保存と取得', async () => {
  const pdf = Buffer.from('%PDF-1.4 dummy').toString('base64');
  let r = await ok(1, 'POST', '/api/ringi', {
    title: '開発用PC購入', category: '購買', desired_date: '2026-09-30', vendor: '株式会社テスト商会',
    items: [{ name: 'ノートPC', qty: 5, unit_price: 240000 }, { name: 'ドッキングステーション', qty: 5, unit_price: 20000, note: '在庫確認済' }, { name: '', qty: '', unit_price: '' }],
    attachments: [{ filename: '見積書.pdf', mime: 'application/pdf', data: pdf }],
    template_id: 1,
  });
  assert.equal(r.amount, 1300000, '明細合計が申請金額になる');
  assert.equal(r.items.length, 2, '空行は除去される');
  assert.equal(r.desired_date, '2026-09-30'); assert.equal(r.vendor, '株式会社テスト商会');
  assert.equal(r.attachments.length, 1); assert.equal(r.attachments[0].filename, '見積書.pdf'); assert.equal(r.attachments[0].size, 14);
  assert.deepEqual(r.steps.map((s) => s.name), ['課長承認', '部長承認', '経理確認', '社長決裁'], '合計130万円なので全ステップ適用');
  // ダウンロード (申請者OK / 無関係ユーザーNG)
  const dl = await fetch(`${base}/api/ringi/${r.id}/attachments/${r.attachments[0].id}`, { headers: { Cookie: await cookieFor(1) } });
  assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), '%PDF-1.4 dummy');
  assert.equal((await fetch(`${base}/api/ringi/${r.id}/attachments/${r.attachments[0].id}`, { headers: { Cookie: await cookieFor(7) } })).status, 403);
  // 編集: 添付の削除 + 追加、明細変更で金額再計算
  r = await ok(1, 'PUT', `/api/ringi/${r.id}`, {
    title: '開発用PC購入', template_id: 1, items: [{ name: 'ノートPC', qty: 3, unit_price: 240000 }],
    remove_attachment_ids: [r.attachments[0].id], attachments: [{ filename: '仕様書.txt', mime: 'text/plain', data: Buffer.from('spec').toString('base64') }],
  });
  assert.equal(r.amount, 720000); assert.equal(r.attachments.length, 1); assert.equal(r.attachments[0].filename, '仕様書.txt');
  // 添付は最大5件 (6件目は 400、5件ちょうどは OK、既存+追加の合計でも判定)
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ filename: `f${i}.txt`, mime: 'text/plain', data: Buffer.from('x').toString('base64') }));
  await fail(400, 1, 'POST', '/api/ringi', { title: 'x', template_id: 3, attachments: mk(6) });
  const five = await ok(1, 'POST', '/api/ringi', { title: '添付5件', template_id: 3, attachments: mk(5) });
  assert.equal(five.attachments.length, 5);
  await fail(400, 1, 'PUT', `/api/ringi/${five.id}`, { title: '添付5件', template_id: 3, attachments: mk(1) });
  const swapped = await ok(1, 'PUT', `/api/ringi/${five.id}`, { title: '添付5件', template_id: 3, remove_attachment_ids: [five.attachments[0].id], attachments: mk(1) });
  assert.equal(swapped.attachments.length, 5);
  // バリデーション
  await fail(400, 1, 'POST', '/api/ringi', { title: 'x', template_id: 3, desired_date: '2026/09/30' });
  await fail(400, 1, 'POST', '/api/ringi', { title: 'x', template_id: 3, items: [{ name: '', qty: 1, unit_price: 100 }] });
  await fail(400, 1, 'POST', '/api/ringi', { title: 'x', template_id: 3, items: [{ name: 'a', qty: -1, unit_price: 100 }] });
  await fail(400, 1, 'POST', '/api/ringi', { title: 'x', template_id: 3, attachments: [{ filename: 'a.bin', data: '' }] });
});

test('ユーザー管理: 管理者のみ閲覧・変更でき、承認者フラグがルート指定に効く', async () => {
  // 一般ユーザーは一覧(全件)・作成・更新とも 403
  await fail(403, 1, 'GET', '/api/users?all=1');
  await fail(403, 1, 'POST', '/api/users', { name: 'x' });
  await fail(403, 1, 'PUT', '/api/users/2', { is_approver: false });
  // 管理者は全件取得できる (無効ユーザー含む)
  const all = await ok(8, 'GET', '/api/users?all=1');
  assert.ok(all.length >= 8); assert.ok('is_approver' in all[0]);
  // 承認者権限のないユーザー(山田=1)を承認者にしたルートは弾かれる
  await fail(400, 7, 'POST', '/api/ringi', { title: 'x', steps: [{ name: 'a', approver_ids: [1] }] });
  await fail(400, 8, 'POST', '/api/templates', { name: 't', steps: [{ name: 'a', approver_ids: [1] }] });
  // 管理者が山田に承認者権限を付与 → 指定可能になる
  let u = await ok(8, 'PUT', '/api/users/1', { is_approver: true });
  assert.equal(u.is_approver, 1); assert.equal(u.role, 'user');
  const r = await ok(7, 'POST', '/api/ringi', { title: '山田承認', steps: [{ name: '担当確認', approver_ids: [1] }], submit: true });
  assert.equal(r.steps[0].approvers[0].user_id, 1);
  // 管理者権限の付与/剥奪
  u = await ok(8, 'PUT', '/api/users/7', { role: 'admin' }); assert.equal(u.role, 'admin');
  await ok(7, 'GET', '/api/users?all=1');                       // 付与直後から管理画面が見える
  u = await ok(8, 'PUT', '/api/users/7', { role: 'user' }); assert.equal(u.role, 'user');
  assert.equal((await fetch(base + '/api/me', { headers: { Cookie: cookies.get(7) } })).status, 401, '管理者権限剥奪でセッション破棄');
  cookies.delete(7);
  await fail(403, 7, 'GET', '/api/users?all=1');   // 再ログイン後は一般ユーザーとして 403
  // ロックアウト防止: 自分の管理者権限は外せない / 自分を無効化できない
  await fail(400, 8, 'PUT', '/api/users/8', { role: 'user' });
  await fail(400, 8, 'PUT', '/api/users/8', { active: false });
  // 最後の有効管理者は外せない (6 と 8 が管理者 → 6 を外すのはOK、その後 8 は外せない)
  await ok(8, 'PUT', '/api/users/6', { role: 'user' });
  await fail(400, 8, 'PUT', '/api/users/8', { role: 'user' });
  await ok(8, 'PUT', '/api/users/6', { role: 'admin' });
  // ユーザー追加 → 無効化するとログイン不可 & 承認者指定不可
  const nu = await ok(8, 'POST', '/api/users', { name: '新人 花子', dept: '営業部', title: '担当', is_approver: true, login_id: 'hanako', password: 'Hanako2026!' });
  assert.equal(nu.is_approver, 1); assert.equal(nu.active, 1); assert.equal(nu.login_id, 'hanako'); assert.equal(nu.password_hash, undefined);
  CREDS[nu.id] = ['hanako', 'Hanako2026!'];
  await ok(nu.id, 'GET', '/api/me');
  await ok(8, 'PUT', `/api/users/${nu.id}`, { active: false });
  assert.equal((await call(nu.id, 'GET', '/api/me')).status, 401);
  await fail(400, 7, 'POST', '/api/ringi', { title: 'x', steps: [{ name: 'a', approver_ids: [nu.id] }] });
  assert.equal((await ok(1, 'GET', '/api/users')).some((x) => x.id === nu.id), false, '有効ユーザー一覧には出ない');
  // バリデーション
  await fail(400, 8, 'POST', '/api/users', { name: '', login_id: 'abc', password: 'Password1' });
  await fail(400, 8, 'POST', '/api/users', { name: 'x', login_id: 'abc' }); // パスワード必須
  await fail(404, 8, 'PUT', '/api/users/9999', { name: 'x' });
});

test('バックアップ: 管理者のみ。1フォルダに CSV + 添付ファイル + DB コピーが出力される', async () => {
  await fail(403, 1, 'GET', '/api/admin/backups');
  await fail(403, 1, 'POST', '/api/admin/backups');
  const m = await ok(8, 'POST', '/api/admin/backups');
  assert.match(m.name, /^backup_\d{8}_\d{6}/);
  assert.equal(path.dirname(m.dir), backupDir);
  for (const f of ['users.csv', 'route_templates.csv', 'route_template_steps.csv', 'ringi.csv', 'ringi_items.csv', 'ringi_steps.csv', 'ringi_step_approvers.csv', 'history.csv', 'attachments.csv', 'ringi.db', 'manifest.json', 'README.txt']) {
    assert.ok(fs.existsSync(path.join(m.dir, f)), `${f} がある`);
  }
  // CSV: BOM 付き・日本語ヘッダ・行数一致・パスワードハッシュを含まない
  const usersCsv = fs.readFileSync(path.join(m.dir, 'users.csv'), 'utf8');
  assert.ok(usersCsv.startsWith('\uFEFF'), 'BOM');
  assert.match(usersCsv.split('\r\n')[0], /^\uFEFFID,ログインID,氏名,部署,役職,役割,承認者,有効$/);
  assert.equal(usersCsv.trim().split('\r\n').length - 1, m.tables.users.rows);
  assert.ok(!usersCsv.includes('scrypt$'));
  const ringiCsv = fs.readFileSync(path.join(m.dir, 'ringi.csv'), 'utf8');
  assert.ok(ringiCsv.includes('承認済') || ringiCsv.includes('承認中'), 'ステータスは日本語');
  assert.ok(m.tables.ringi.rows > 0 && m.tables.history.rows > 0 && m.tables.ringi_items.rows > 0);
  // 添付ファイルの実体
  const attFiles = fs.readdirSync(path.join(m.dir, 'attachments'));
  assert.ok(m.attachments > 0); assert.equal(attFiles.length, m.attachments);
  assert.ok(attFiles.some((f) => f.endsWith('_仕様書.txt')));
  // DB コピーを開いて件数が一致
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(path.join(m.dir, 'ringi.db'), { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS c FROM ringi').get().c, m.tables.ringi.rows);
  assert.equal(copy.prepare('SELECT COUNT(*) AS c FROM attachments').get().c, m.attachments);
  copy.close();
  // manifest
  const manifest = JSON.parse(fs.readFileSync(path.join(m.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, m.name); assert.equal(manifest.tables.users.rows, m.tables.users.rows);
  // 一覧 / 個別 CSV ダウンロード / 削除
  const list = await ok(8, 'GET', '/api/admin/backups');
  assert.ok(list.backups.some((b) => b.name === m.name && b.complete));
  assert.ok(list.tables.some((t) => t.key === 'ringi'));
  const csv = await fetch(base + '/api/admin/export/ringi.csv', { headers: { Cookie: await cookieFor(8) } });
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/);
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM 付き');
  assert.ok(bytes.toString('utf8').slice(1).startsWith('ID,稟議番号,件名'));
  assert.equal((await fetch(base + '/api/admin/export/ringi.csv', { headers: { Cookie: await cookieFor(1) } })).status, 403);
  await fail(404, 8, 'GET', '/api/admin/export/sessions.csv');
  await fail(400, 8, 'DELETE', '/api/admin/backups/not-a-backup');
  await ok(8, 'DELETE', `/api/admin/backups/${m.name}`);
  assert.ok(!fs.existsSync(m.dir));
});
