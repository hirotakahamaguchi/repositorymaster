'use strict';
const path = require('node:path');
const { hashPassword, validatePassword, publicUser } = require('./auth');
// 稟議ワークフローのビジネスロジック (状態遷移・権限・監査ログ)

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new ApiError(400, m);
const forbidden = (m) => new ApiError(403, m);
const notFound = (m) => new ApiError(404, m);

const STATUS = {
  draft: '下書き', pending: '承認中', approved: '承認済', rejected: '却下', returned: '差戻し中', withdrawn: '取下げ',
};
const STEP_STATUS = { waiting: '未到達', active: '承認待ち', approved: '承認済', returned: '差戻し', rejected: '却下' };
const ACTION = {
  create: '作成', update: '編集', submit: '申請', resubmit: '再申請', approve: '承認', reject: '却下',
  return: '差戻し', withdraw: '取下げ', comment: 'コメント',
};

function createService(db) {
  // ---------- 共通ヘルパ ----------
  const q = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    users: db.prepare('SELECT * FROM users WHERE active = 1 ORDER BY id'),
  };

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  const isAdmin = (u) => u.role === 'admin';
  const requireStr = (v, label, { max = 200, required = true } = {}) => {
    const s = (v ?? '').toString().trim();
    if (required && !s) throw bad(`${label}は必須です`);
    if (s.length > max) throw bad(`${label}は${max}文字以内で入力してください`);
    return s;
  };
  const toAmount = (v) => {
    if (v === '' || v === null || v === undefined) return 0;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw bad('金額は0以上の整数で入力してください');
    return n;
  };

  const validateDate = (v) => {
    const s = (v ?? '').toString().trim();
    if (!s) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw bad('希望期日は YYYY-MM-DD 形式で入力してください');
    return s;
  };
  // 明細行 [{name, qty, unit_price}] の検証 (空行は除去)
  const validateItems = (raw) => {
    if (raw == null) return [];
    if (!Array.isArray(raw)) throw bad('明細の形式が不正です');
    if (raw.length > 50) throw bad('明細は50行までです');
    const out = [];
    raw.forEach((it, i) => {
      const name = (it.name ?? '').toString().trim();
      const qtyRaw = it.qty ?? '', priceRaw = it.unit_price ?? '';
      if (!name && qtyRaw === '' && priceRaw === '') return; // 空行
      if (!name) throw bad(`明細${i + 1}行目: 品目を入力してください`);
      if (name.length > 100) throw bad(`明細${i + 1}行目: 品目は100文字以内です`);
      const qty = Number(qtyRaw === '' ? 1 : qtyRaw), unit_price = Number(priceRaw === '' ? 0 : priceRaw);
      if (!Number.isFinite(qty) || qty <= 0) throw bad(`明細${i + 1}行目: 数量は正の数で入力してください`);
      if (!Number.isInteger(unit_price) || unit_price < 0) throw bad(`明細${i + 1}行目: 単価は0以上の整数で入力してください`);
      out.push({ name, qty, unit_price, note: (it.note ?? '').toString().trim().slice(0, 200) });
    });
    return out;
  };
  const ATTACH_MAX_BYTES = 5 * 1024 * 1024, ATTACH_MAX_COUNT = 5; // 添付: 1件5MBまで・最大5件
  const validateAttachmentsInput = (raw) => {
    if (raw == null) return [];
    if (!Array.isArray(raw)) throw bad('添付の形式が不正です');
    return raw.map((a, i) => {
      const filename = path.win32.basename(requireStr(a.filename, `添付${i + 1}のファイル名`, { max: 255 })).replace(/[:*?"<>|]/g, '_');
      const mime = (a.mime || 'application/octet-stream').toString().slice(0, 100);
      let buf;
      try { buf = Buffer.from(String(a.data || ''), 'base64'); } catch { throw bad(`添付「${filename}」のデータが不正です`); }
      if (!buf.length) throw bad(`添付「${filename}」が空です`);
      if (buf.length > ATTACH_MAX_BYTES) throw bad(`添付「${filename}」は5MBを超えています`);
      return { filename, mime, buf };
    });
  };

  // ---------- ユーザー ----------
  const users = {
    list() { return q.users.all().map(publicUser); },       // 有効ユーザーのみ (承認者選択用)
    listAll(actor) {                                        // 管理画面用: 無効ユーザーも含む
      if (!isAdmin(actor)) throw forbidden('管理者のみ閲覧できます');
      return db.prepare('SELECT * FROM users ORDER BY active DESC, id').all().map(publicUser);
    },
    get(id) { return q.userById.get(id) || null; },        // 内部用 (password_hash を含む)
    create(actor, data) {
      if (!isAdmin(actor)) throw forbidden('管理者のみ実行できます');
      const f = validateUser(data);
      ensureLoginIdFree(f.login_id, null);
      const pw = validatePassword(data.password);
      const r = db.prepare('INSERT INTO users (name, dept, title, role, is_approver, active, login_id, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(f.name, f.dept, f.title, f.role, f.is_approver, f.active, f.login_id, hashPassword(pw));
      return publicUser(users.get(r.lastInsertRowid));
    },
    update(actor, id, data) {
      if (!isAdmin(actor)) throw forbidden('管理者のみ実行できます');
      const cur = users.get(id);
      if (!cur) throw notFound('ユーザーが見つかりません');
      const f = validateUser({ ...cur, ...data });        // 部分更新可
      ensureLoginIdFree(f.login_id, id);
      const newHash = data.password !== undefined && data.password !== '' && data.password !== null ? hashPassword(validatePassword(data.password)) : null;
      // ロックアウト防止: 自分自身の管理者権限は外せない / 自分を無効化できない
      if (id === actor.id && f.role !== 'admin') throw bad('自分自身の管理者権限は解除できません');
      if (id === actor.id && !f.active) throw bad('自分自身を無効化することはできません');
      // 有効な管理者が0人になる変更は不可
      if (cur.role === 'admin' && cur.active && (f.role !== 'admin' || !f.active)) {
        const n = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id <> ?`).get(id).c;
        if (n === 0) throw bad('有効な管理者が1人もいなくなるため変更できません');
      }
      db.prepare('UPDATE users SET name = ?, dept = ?, title = ?, role = ?, is_approver = ?, active = ?, login_id = ?, password_hash = COALESCE(?, password_hash) WHERE id = ?')
        .run(f.name, f.dept, f.title, f.role, f.is_approver, f.active, f.login_id, newHash, id);
      // 無効化 / パスワード再設定 / 管理者権限剥奪 時は既存セッションを破棄 (再ログインさせる)
      if (!f.active || newHash || (cur.role === 'admin' && f.role !== 'admin')) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      return publicUser(users.get(id));
    },
  };
  function ensureLoginIdFree(loginId, selfId) {
    const dup = db.prepare('SELECT id FROM users WHERE login_id = ? AND id IS NOT ?').get(loginId, selfId);
    if (dup) throw bad('このログインIDは既に使用されています');
  }
  function validateUser(d) {
    const toFlag = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
    const login_id = (d.login_id ?? '').toString().trim();
    if (!/^[A-Za-z0-9._@-]{3,50}$/.test(login_id)) throw bad('ログインIDは3〜50文字の半角英数字と . _ @ - で入力してください');
    return {
      login_id,
      name: requireStr(d.name, '氏名', { max: 50 }),
      dept: requireStr(d.dept, '部署', { required: false, max: 50 }),
      title: requireStr(d.title, '役職', { required: false, max: 50 }),
      role: d.role === 'admin' ? 'admin' : 'user',
      is_approver: toFlag(d.is_approver),
      active: d.active === undefined ? 1 : toFlag(d.active),
    };
  }

  // ---------- 承認ルートテンプレート ----------
  const templates = {
    list() {
      return db.prepare('SELECT * FROM route_templates ORDER BY id').all().map((t) => ({ ...t, steps: templates.steps(t.id) }));
    },
    get(id) {
      const t = db.prepare('SELECT * FROM route_templates WHERE id = ?').get(id);
      if (!t) throw notFound('ルートテンプレートが見つかりません');
      return { ...t, steps: templates.steps(id) };
    },
    steps(templateId) {
      const steps = db.prepare('SELECT * FROM route_template_steps WHERE template_id = ? ORDER BY seq').all(templateId);
      const ap = db.prepare(`SELECT a.step_id, u.id, u.name, u.dept, u.title FROM route_template_step_approvers a
                             JOIN users u ON u.id = a.user_id WHERE a.step_id = ? ORDER BY u.id`);
      return steps.map((s) => ({ ...s, approvers: ap.all(s.id) }));
    },
    // 金額条件を適用して、実際に適用されるステップ列を返す
    resolve(templateId, amount) {
      const t = templates.get(templateId);
      return t.steps
        .filter((s) => s.min_amount == null || amount >= s.min_amount)
        .map((s, i) => ({ seq: i + 1, name: s.name, mode: s.mode, approver_ids: s.approvers.map((a) => a.id), template_seq: s.seq }));
    },
    create(actor, data) {
      if (!isAdmin(actor)) throw forbidden('管理者のみ実行できます');
      const { name, description, steps } = validateTemplate(data);
      return tx(() => {
        const id = db.prepare('INSERT INTO route_templates (name, description) VALUES (?, ?)').run(name, description).lastInsertRowid;
        writeTemplateSteps(id, steps);
        return templates.get(id);
      });
    },
    update(actor, id, data) {
      if (!isAdmin(actor)) throw forbidden('管理者のみ実行できます');
      templates.get(id);
      const { name, description, steps } = validateTemplate(data);
      return tx(() => {
        db.prepare('UPDATE route_templates SET name = ?, description = ? WHERE id = ?').run(name, description, id);
        db.prepare('DELETE FROM route_template_steps WHERE template_id = ?').run(id);
        writeTemplateSteps(id, steps);
        return templates.get(id);
      });
    },
    remove(actor, id) {
      if (!isAdmin(actor)) throw forbidden('管理者のみ実行できます');
      templates.get(id);
      db.prepare('DELETE FROM route_templates WHERE id = ?').run(id);
      return { ok: true };
    },
  };
  function validateTemplate(data) {
    const name = requireStr(data.name, 'テンプレート名', { max: 100 });
    const description = requireStr(data.description, '説明', { required: false, max: 500 });
    const steps = validateSteps(data.steps, { allowMinAmount: true });
    return { name, description, steps };
  }
  function writeTemplateSteps(templateId, steps) {
    const insS = db.prepare('INSERT INTO route_template_steps (template_id, seq, name, mode, min_amount) VALUES (?, ?, ?, ?, ?)');
    const insA = db.prepare('INSERT INTO route_template_step_approvers (step_id, user_id) VALUES (?, ?)');
    steps.forEach((s, i) => {
      const sid = insS.run(templateId, i + 1, s.name, s.mode, s.min_amount).lastInsertRowid;
      for (const uid of s.approver_ids) insA.run(sid, uid);
    });
  }
  // ステップ定義 [{name, mode, approver_ids, min_amount?}] の検証
  function validateSteps(raw, { allowMinAmount = false } = {}) {
    if (!Array.isArray(raw) || raw.length === 0) throw bad('承認ステップを1つ以上設定してください');
    if (raw.length > 20) throw bad('承認ステップは20個までです');
    return raw.map((s, i) => {
      const name = requireStr(s.name, `ステップ${i + 1}の名称`, { max: 50 });
      const mode = s.mode === 'all' ? 'all' : 'any';
      const ids = [...new Set((s.approver_ids || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length === 0) throw bad(`ステップ${i + 1}「${name}」の承認者を1人以上選択してください`);
      for (const id of ids) {
        const u = users.get(id);
        if (!u) throw bad(`ステップ${i + 1}: 存在しないユーザー(ID ${id})が指定されています`);
        if (!u.active) throw bad(`ステップ${i + 1}: 「${u.name}」は無効なユーザーのため承認者に指定できません`);
        if (!u.is_approver) throw bad(`ステップ${i + 1}: 「${u.name}」には承認者権限がありません（ユーザー管理で設定してください）`);
      }
      let min_amount = null;
      if (allowMinAmount && s.min_amount !== '' && s.min_amount != null) {
        min_amount = Number(s.min_amount);
        if (!Number.isInteger(min_amount) || min_amount < 0) throw bad(`ステップ${i + 1}: 適用最低金額は0以上の整数で入力してください`);
      }
      return { name, mode, approver_ids: ids, min_amount };
    });
  }

  // ---------- 稟議 ----------
  const rq = {
    byId: db.prepare('SELECT * FROM ringi WHERE id = ?'),
    steps: db.prepare('SELECT * FROM ringi_steps WHERE ringi_id = ? ORDER BY seq'),
    stepApprovers: db.prepare(`SELECT a.*, u.name AS user_name, u.dept AS user_dept, u.title AS user_title
                               FROM ringi_step_approvers a JOIN users u ON u.id = a.user_id WHERE a.step_id = ? ORDER BY a.id`),
    history: db.prepare(`SELECT h.*, u.name AS actor_name, u.dept AS actor_dept, u.title AS actor_title
                         FROM history h JOIN users u ON u.id = h.actor_id WHERE h.ringi_id = ? ORDER BY h.id`),
    insHistory: db.prepare(`INSERT INTO history (ringi_id, actor_id, action, from_status, to_status, step_seq, step_name, target_seq, round, comment)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    touch: db.prepare(`UPDATE ringi SET updated_at = datetime('now','localtime') WHERE id = ?`),
    attachments: db.prepare(`SELECT a.id, a.filename, a.mime, a.size, a.created_at, a.uploaded_by, u.name AS uploaded_by_name
                             FROM attachments a JOIN users u ON u.id = a.uploaded_by WHERE a.ringi_id = ? ORDER BY a.id`),
  };

  // 添付の追加 (data.attachments: [{filename, mime, data(base64)}]) / 削除 (data.remove_attachment_ids)
  function applyAttachments(user, ringiId, data) {
    const removeIds = Array.isArray(data.remove_attachment_ids) ? data.remove_attachment_ids.map(Number) : [];
    for (const aid of removeIds) db.prepare('DELETE FROM attachments WHERE id = ? AND ringi_id = ?').run(aid, ringiId);
    const adds = validateAttachmentsInput(data.attachments);
    const existing = db.prepare('SELECT COUNT(*) AS c FROM attachments WHERE ringi_id = ?').get(ringiId).c;
    if (existing + adds.length > ATTACH_MAX_COUNT) throw bad(`添付ファイルは${ATTACH_MAX_COUNT}件までです`);
    const ins = db.prepare('INSERT INTO attachments (ringi_id, filename, mime, size, data, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)');
    for (const a of adds) ins.run(ringiId, a.filename, a.mime, a.buf.length, a.buf, user.id);
  }

  function log(ringiId, actor, action, { from = null, to = null, stepSeq = null, stepName = null, targetSeq = null, round = 0, comment = '' } = {}) {
    rq.insHistory.run(ringiId, actor.id, action, from, to, stepSeq, stepName, targetSeq, round, comment);
    rq.touch.run(ringiId);
  }

  function nextNumber() {
    const year = new Date().getFullYear();
    const prefix = `R-${year}-`;
    const row = db.prepare('SELECT number FROM ringi WHERE number LIKE ? ORDER BY number DESC LIMIT 1').get(prefix + '%');
    const n = row ? Number(row.number.slice(prefix.length)) + 1 : 1;
    return prefix + String(n).padStart(4, '0');
  }

  function loadSteps(ringiId) {
    return rq.steps.all(ringiId).map((s) => ({ ...s, approvers: rq.stepApprovers.all(s.id) }));
  }

  // 権限: 閲覧できるのは 申請者 / ルート上の承認者 / 管理者
  function canView(user, r, steps) {
    if (isAdmin(user) || r.applicant_id === user.id) return true;
    return steps.some((s) => s.approvers.some((a) => a.user_id === user.id));
  }

  function getRaw(id) {
    const r = rq.byId.get(id);
    if (!r) throw notFound('稟議が見つかりません');
    return r;
  }

  // ステップ定義を稟議に書き込む (既存は削除して作り直す)
  function writeRingiSteps(ringiId, steps) {
    db.prepare('DELETE FROM ringi_steps WHERE ringi_id = ?').run(ringiId);
    const insS = db.prepare('INSERT INTO ringi_steps (ringi_id, seq, name, mode) VALUES (?, ?, ?, ?)');
    const insA = db.prepare('INSERT INTO ringi_step_approvers (step_id, user_id) VALUES (?, ?)');
    steps.forEach((s, i) => {
      const sid = insS.run(ringiId, i + 1, s.name, s.mode).lastInsertRowid;
      for (const uid of s.approver_ids) insA.run(sid, uid);
    });
  }

  // 入力 data から {fields, steps} を組み立てる
  function buildRingiInput(data) {
    const fields = {
      title: requireStr(data.title, '件名', { max: 200 }),
      category: requireStr(data.category, '区分', { required: false, max: 50 }),
      amount: toAmount(data.amount),
      body: requireStr(data.body, '内容', { required: false, max: 20000 }),
      desired_date: validateDate(data.desired_date),
      vendor: requireStr(data.vendor, '支払先', { required: false, max: 100 }),
      items: validateItems(data.items),
      template_id: null,
    };
    // 明細がある場合は合計を申請金額とする
    if (fields.items.length) fields.amount = fields.items.reduce((a, it) => a + it.qty * it.unit_price, 0);
    let steps;
    if (data.template_id) {
      fields.template_id = Number(data.template_id);
      steps = templates.resolve(fields.template_id, fields.amount);
      if (steps.length === 0) throw bad('金額条件により適用される承認ステップがありません。ルートを見直してください');
    } else {
      steps = validateSteps(data.steps);
    }
    return { fields, steps };
  }

  // 申請者に許可されるアクション等を付与した詳細を返す
  function detail(user, id) {
    const r = getRaw(id);
    const steps = loadSteps(id);
    if (!canView(user, r, steps)) throw forbidden('この稟議を閲覧する権限がありません');
    const applicant = users.get(r.applicant_id);
    const history = rq.history.all(id);
    const current = steps.find((s) => s.seq === r.current_seq) || null;
    const myApproval = current ? current.approvers.find((a) => a.user_id === user.id) : null;
    const isApplicant = r.applicant_id === user.id;
    const canDecide = r.status === 'pending' && !!myApproval && myApproval.decision == null;
    const perms = {
      can_edit: isApplicant && (r.status === 'draft' || r.status === 'returned'),
      can_submit: isApplicant && (r.status === 'draft' || r.status === 'returned'),
      can_delete: isApplicant && r.status === 'draft',
      can_withdraw: isApplicant && r.status === 'pending',
      can_approve: canDecide,
      can_reject: canDecide,
      can_return: canDecide,
      can_comment: true,
      // 差戻し先候補: 申請者(0) と、現在より前の承認済みステップ
      return_targets: canDecide
        ? [{ seq: 0, name: '申請者' }, ...steps.filter((s) => s.seq < r.current_seq && s.status === 'approved').map((s) => ({ seq: s.seq, name: s.name }))]
        : [],
    };
    const template = r.template_id ? db.prepare('SELECT id, name FROM route_templates WHERE id = ?').get(r.template_id) : null;
    let items = [];
    try { items = JSON.parse(r.items_json || '[]'); } catch { items = []; }
    const attachments = rq.attachments.all(id);
    return { ...r, items_json: undefined, items, attachments, status_label: STATUS[r.status], applicant, template, steps, history, current_step: current, perms };
  }

  const ringi = {
    detail,

    list(user, { filter = 'all', status = '', q: keyword = '' } = {}) {
      const rows = db.prepare(`
        SELECT r.*, u.name AS applicant_name, u.dept AS applicant_dept
        FROM ringi r JOIN users u ON u.id = r.applicant_id
        ORDER BY r.updated_at DESC, r.id DESC`).all();
      const out = [];
      for (const r of rows) {
        const steps = loadSteps(r.id);
        const current = steps.find((s) => s.seq === r.current_seq) || null;
        const myTurn = !!(r.status === 'pending' && current && current.approvers.some((a) => a.user_id === user.id && a.decision == null));
        const involved = canView(user, r, steps);
        if (filter === 'inbox' && !myTurn) continue;
        if (filter === 'mine' && r.applicant_id !== user.id) continue;
        if (filter === 'all' && !involved) continue;
        if (status && r.status !== status) continue;
        if (keyword && !(r.title.includes(keyword) || r.number.includes(keyword) || r.applicant_name.includes(keyword))) continue;
        out.push({
          id: r.id, number: r.number, title: r.title, category: r.category, amount: r.amount, status: r.status,
          status_label: STATUS[r.status], applicant_id: r.applicant_id, applicant_name: r.applicant_name, applicant_dept: r.applicant_dept,
          round: r.round, created_at: r.created_at, updated_at: r.updated_at, submitted_at: r.submitted_at, completed_at: r.completed_at,
          current_step: current ? {
            seq: current.seq, name: current.name, mode: current.mode,
            pending_approvers: current.approvers.filter((a) => a.decision == null).map((a) => a.user_name),
          } : null,
          my_turn: myTurn,
          step_total: steps.length,
          step_done: steps.filter((s) => s.status === 'approved').length,
        });
      }
      return out;
    },

    counts(user) {
      const all = ringi.list(user, { filter: 'all' });
      return {
        inbox: all.filter((r) => r.my_turn).length,
        mine_active: all.filter((r) => r.applicant_id === user.id && ['draft', 'pending', 'returned'].includes(r.status)).length,
        mine_returned: all.filter((r) => r.applicant_id === user.id && r.status === 'returned').length,
      };
    },

    create(user, data) {
      const { fields, steps } = buildRingiInput(data);
      return tx(() => {
        const id = db.prepare(`INSERT INTO ringi (number, title, category, amount, body, desired_date, vendor, items_json, applicant_id, template_id, status)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`)
          .run(nextNumber(), fields.title, fields.category, fields.amount, fields.body, fields.desired_date, fields.vendor, JSON.stringify(fields.items), user.id, fields.template_id).lastInsertRowid;
        writeRingiSteps(id, steps);
        applyAttachments(user, id, data);
        log(id, user, 'create', { to: 'draft' });
        if (data.submit) doSubmit(user, id, data.comment || '');
        return detail(user, id);
      });
    },

    update(user, id, data) {
      const r = getRaw(id);
      if (r.applicant_id !== user.id) throw forbidden('申請者のみ編集できます');
      if (!['draft', 'returned'].includes(r.status)) throw bad(`ステータスが「${STATUS[r.status]}」のため編集できません`);
      const { fields, steps } = buildRingiInput(data);
      return tx(() => {
        db.prepare('UPDATE ringi SET title = ?, category = ?, amount = ?, body = ?, desired_date = ?, vendor = ?, items_json = ?, template_id = ? WHERE id = ?')
          .run(fields.title, fields.category, fields.amount, fields.body, fields.desired_date, fields.vendor, JSON.stringify(fields.items), fields.template_id, id);
        writeRingiSteps(id, steps);
        applyAttachments(user, id, data);
        log(id, user, 'update', { from: r.status, to: r.status, round: r.round, comment: data.comment || '' });
        if (data.submit) doSubmit(user, id, data.comment || '');
        return detail(user, id);
      });
    },

    remove(user, id) {
      const r = getRaw(id);
      if (r.applicant_id !== user.id && !isAdmin(user)) throw forbidden('申請者のみ削除できます');
      if (r.status !== 'draft') throw bad('下書きのみ削除できます');
      db.prepare('DELETE FROM ringi WHERE id = ?').run(id);
      return { ok: true };
    },

    submit(user, id, comment = '') {
      return tx(() => { doSubmit(user, id, comment); return detail(user, id); });
    },

    approve(user, id, comment = '') {
      return tx(() => {
        const { r, step, ap } = requireDecisionContext(user, id);
        comment = requireStr(comment, 'コメント', { required: false, max: 2000 });
        db.prepare(`UPDATE ringi_step_approvers SET decision = 'approved', decided_at = datetime('now','localtime'), comment = ? WHERE id = ?`).run(comment, ap.id);
        const approvers = rq.stepApprovers.all(step.id);
        const stepDone = step.mode === 'any' || approvers.every((a) => a.decision === 'approved');
        let to = 'pending';
        if (stepDone) {
          db.prepare(`UPDATE ringi_steps SET status = 'approved', completed_at = datetime('now','localtime') WHERE id = ?`).run(step.id);
          const next = db.prepare(`SELECT * FROM ringi_steps WHERE ringi_id = ? AND seq > ? ORDER BY seq LIMIT 1`).get(id, step.seq);
          if (next) {
            activateStep(next.id);
            db.prepare('UPDATE ringi SET current_seq = ? WHERE id = ?').run(next.seq, id);
          } else {
            to = 'approved';
            db.prepare(`UPDATE ringi SET status = 'approved', current_seq = NULL, completed_at = datetime('now','localtime') WHERE id = ?`).run(id);
          }
        }
        log(id, user, 'approve', { from: 'pending', to, stepSeq: step.seq, stepName: step.name, round: r.round, comment });
        return detail(user, id);
      });
    },

    reject(user, id, comment = '') {
      return tx(() => {
        const { r, step, ap } = requireDecisionContext(user, id);
        comment = requireStr(comment, '却下理由', { max: 2000 });
        db.prepare(`UPDATE ringi_step_approvers SET decision = 'rejected', decided_at = datetime('now','localtime'), comment = ? WHERE id = ?`).run(comment, ap.id);
        db.prepare(`UPDATE ringi_steps SET status = 'rejected', completed_at = datetime('now','localtime') WHERE id = ?`).run(step.id);
        db.prepare(`UPDATE ringi SET status = 'rejected', current_seq = NULL, completed_at = datetime('now','localtime') WHERE id = ?`).run(id);
        log(id, user, 'reject', { from: 'pending', to: 'rejected', stepSeq: step.seq, stepName: step.name, round: r.round, comment });
        return detail(user, id);
      });
    },

    // 差戻し: target_seq = 0 → 申請者へ / n → 承認済みの前ステップ n へ
    sendBack(user, id, { target_seq = 0, comment = '' } = {}) {
      return tx(() => {
        const { r, step, ap } = requireDecisionContext(user, id);
        comment = requireStr(comment, '差戻し理由', { max: 2000 });
        const target = Number(target_seq);
        if (!Number.isInteger(target) || target < 0 || target >= step.seq) throw bad('差戻し先が不正です');
        db.prepare(`UPDATE ringi_step_approvers SET decision = 'returned', decided_at = datetime('now','localtime'), comment = ? WHERE id = ?`).run(comment, ap.id);
        db.prepare(`UPDATE ringi_steps SET status = 'returned', completed_at = datetime('now','localtime') WHERE id = ?`).run(step.id);
        let to;
        if (target === 0) {
          to = 'returned';
          db.prepare(`UPDATE ringi SET status = 'returned', current_seq = NULL WHERE id = ?`).run(id);
        } else {
          const tstep = db.prepare('SELECT * FROM ringi_steps WHERE ringi_id = ? AND seq = ?').get(id, target);
          if (!tstep || tstep.status !== 'approved') throw bad('差戻し先は承認済みの前ステップのみ指定できます');
          // target..current のステップを未到達に戻し、判断をクリア
          const between = db.prepare('SELECT id FROM ringi_steps WHERE ringi_id = ? AND seq >= ? AND seq <= ?').all(id, target, step.seq);
          for (const s of between) resetStep(s.id);
          activateStep(tstep.id);
          db.prepare('UPDATE ringi SET current_seq = ? WHERE id = ?').run(target, id);
          to = 'pending';
        }
        log(id, user, 'return', { from: 'pending', to, stepSeq: step.seq, stepName: step.name, targetSeq: target, round: r.round, comment });
        return detail(user, id);
      });
    },

    withdraw(user, id, comment = '') {
      return tx(() => {
        const r = getRaw(id);
        if (r.applicant_id !== user.id) throw forbidden('申請者のみ取り下げできます');
        if (r.status !== 'pending') throw bad('承認中の稟議のみ取り下げできます');
        comment = requireStr(comment, 'コメント', { required: false, max: 2000 });
        const cur = db.prepare('SELECT * FROM ringi_steps WHERE ringi_id = ? AND seq = ?').get(id, r.current_seq);
        if (cur) resetStep(cur.id);
        db.prepare(`UPDATE ringi SET status = 'withdrawn', current_seq = NULL, completed_at = datetime('now','localtime') WHERE id = ?`).run(id);
        log(id, user, 'withdraw', { from: 'pending', to: 'withdrawn', stepSeq: cur ? cur.seq : null, stepName: cur ? cur.name : null, round: r.round, comment });
        return detail(user, id);
      });
    },

    comment(user, id, comment = '') {
      const r = getRaw(id);
      if (!canView(user, r, loadSteps(id))) throw forbidden('この稟議にコメントする権限がありません');
      comment = requireStr(comment, 'コメント', { max: 2000 });
      log(id, user, 'comment', { from: r.status, to: r.status, round: r.round, comment });
      return detail(user, id);
    },
  };

  // 添付ファイルの取得 (ダウンロード用) — 閲覧権限が必要
  ringi.attachment = function (user, id, attachmentId) {
    const r = getRaw(id);
    if (!canView(user, r, loadSteps(id))) throw forbidden('この稟議を閲覧する権限がありません');
    const a = db.prepare('SELECT * FROM attachments WHERE id = ? AND ringi_id = ?').get(attachmentId, id);
    if (!a) throw notFound('添付ファイルが見つかりません');
    return a;
  };

  function activateStep(stepId) {
    db.prepare(`UPDATE ringi_steps SET status = 'active', activated_at = datetime('now','localtime'), completed_at = NULL WHERE id = ?`).run(stepId);
  }
  function resetStep(stepId) {
    db.prepare(`UPDATE ringi_steps SET status = 'waiting', activated_at = NULL, completed_at = NULL WHERE id = ?`).run(stepId);
    db.prepare(`UPDATE ringi_step_approvers SET decision = NULL, decided_at = NULL, comment = '' WHERE step_id = ?`).run(stepId);
  }

  function doSubmit(user, id, comment) {
    const r = getRaw(id);
    if (r.applicant_id !== user.id) throw forbidden('申請者のみ申請できます');
    if (!['draft', 'returned'].includes(r.status)) throw bad(`ステータスが「${STATUS[r.status]}」のため申請できません`);
    comment = requireStr(comment, 'コメント', { required: false, max: 2000 });
    const steps = loadSteps(id);
    if (steps.length === 0) throw bad('承認ルートが設定されていません');
    for (const s of steps) if (s.approvers.length === 0) throw bad(`ステップ「${s.name}」に承認者がいません`);
    for (const s of steps) resetStep(s.id);
    activateStep(steps[0].id);
    const round = r.round + 1;
    db.prepare(`UPDATE ringi SET status = 'pending', current_seq = ?, round = ?, submitted_at = datetime('now','localtime'), completed_at = NULL WHERE id = ?`)
      .run(steps[0].seq, round, id);
    log(id, user, round === 1 ? 'submit' : 'resubmit', { from: r.status, to: 'pending', stepSeq: steps[0].seq, stepName: steps[0].name, round, comment });
  }

  // 承認/却下/差戻しの前提条件チェック → {r, step, ap}
  function requireDecisionContext(user, id) {
    const r = getRaw(id);
    if (r.status !== 'pending') throw bad(`ステータスが「${STATUS[r.status]}」のため処理できません`);
    const step = db.prepare('SELECT * FROM ringi_steps WHERE ringi_id = ? AND seq = ?').get(id, r.current_seq);
    if (!step || step.status !== 'active') throw bad('承認待ちのステップがありません');
    const ap = db.prepare('SELECT * FROM ringi_step_approvers WHERE step_id = ? AND user_id = ?').get(step.id, user.id);
    if (!ap) throw forbidden('あなたは現在のステップの承認者ではありません');
    if (ap.decision) throw bad('このステップでは既に判断済みです');
    return { r, step, ap };
  }

  return { users, templates, ringi, constants: { STATUS, STEP_STATUS, ACTION } };
}

module.exports = { createService, ApiError, STATUS, STEP_STATUS, ACTION };
