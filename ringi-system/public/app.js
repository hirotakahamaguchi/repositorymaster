/* 株式会社MANEXION 稟議システム フロントエンド (バニラ JS / ハッシュルーティング) */
(() => {
  'use strict';

  // ---------- 状態 / ユーティリティ ----------
  const state = { user: null, users: [], templates: [], constants: null };
  const $ = (sel, el = document) => el.querySelector(sel);
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = (n) => '¥' + Number(n || 0).toLocaleString('ja-JP');
  const dt = (s) => (s ? s.replace(/:\d\d$/, '') : '—');
  const CATEGORIES = ['経費', '購買', '契約', '人事', 'IT・設備', 'その他'];

  let toastTimer;
  function toast(msg, type = '') {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast ' + type; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.user && !path.startsWith('/api/auth/')) {
      // セッション切れ → ログイン画面へ
      state.user = null; showLogin('セッションの有効期限が切れました。再度ログインしてください。');
    }
    if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
    return data;
  }
  const userLabel = (u) => `${u.name}（${u.dept} ${u.title}）`;
  const userById = (id) => state.users.find((u) => u.id === id);

  // ---------- 認証 (ログイン / ログアウト / セッション) ----------
  function setLoggedIn(on) {
    document.body.classList.toggle('logged-out', !on);
    $('#userbox').hidden = !on; $('.nav').hidden = !on;
    if (on) $('#me-name').textContent = `${userLabel(state.user)}${state.user.is_approver ? ' [承認者]' : ''}${state.user.role === 'admin' ? ' [管理者]' : ''}`;
  }
  async function reloadUsers() { state.users = await api('GET', '/api/users'); }
  async function afterLogin() {
    setLoggedIn(true);
    if (!state.constants) state.constants = await api('GET', '/api/constants');
    await reloadUsers();
    await refreshChrome();
    const target = (!location.hash || location.hash === '#/login') ? '#/inbox' : location.hash;
    if (location.hash !== target) location.hash = target; else await render();
  }
  function showLogin(message = '') {
    setNav(null); setLoggedIn(false);
    app.innerHTML = `
      <div class="login-wrap">
        <form class="card login-card" id="login-form">
          <div class="login-logo">📋</div>
          <div class="login-company">株式会社MANEXION</div>
          <h1 class="login-title">稟議システム</h1>
          <p class="muted small login-sub">ログインIDとパスワードを入力してください</p>
          ${message ? `<div class="alert info small">${esc(message)}</div>` : ''}
          <div id="login-error" class="alert danger small" hidden></div>
          <label class="field"><span>ログインID</span><input type="text" name="login_id" autocomplete="username" required autofocus autocapitalize="off" spellcheck="false"></label>
          <label class="field"><span>パスワード</span><input type="password" name="password" autocomplete="current-password" required></label>
          <button type="submit" class="btn-primary login-btn" id="login-btn">ログイン</button>
          <details class="login-demo">
            <summary>デモアカウント（初期パスワードはすべて <code>password</code>）</summary>
            <table>
              <tr><td><code>yamada</code></td><td>山田 太郎（申請者）</td></tr>
              <tr><td><code>sato</code></td><td>佐藤 花子（課長・承認者）</td></tr>
              <tr><td><code>suzuki</code></td><td>鈴木 一郎（部長・承認者）</td></tr>
              <tr><td><code>takahashi</code> / <code>tanaka</code></td><td>経理（承認者）</td></tr>
              <tr><td><code>watanabe</code></td><td>渡辺 社長（承認者・管理者）</td></tr>
              <tr><td><code>admin</code></td><td>中村 管理（管理者）</td></tr>
            </table>
          </details>
        </form>
      </div>`;
    const form = $('#login-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('#login-btn'); btn.disabled = true; $('#login-error').hidden = true;
      try {
        state.user = await api('POST', '/api/auth/login', { login_id: form.login_id.value.trim(), password: form.password.value });
        await afterLogin();
      } catch (err) {
        $('#login-error').textContent = err.message; $('#login-error').hidden = false;
        btn.disabled = false; form.password.value = ''; form.password.focus();
      }
    };
  }
  async function logout() {
    try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
    state.user = null;
    history.replaceState(null, '', location.pathname);
    showLogin('ログアウトしました');
  }
  $('#btn-logout').onclick = logout;

  // ---------- パスワード変更 (本人) ----------
  function renderPassword() {
    setNav(null);
    app.innerHTML = `
      <div class="page-head"><h1>パスワード変更</h1></div>
      <form class="card" id="pw-form" style="max-width:480px">
        <p class="muted small">変更すると、他の端末・ブラウザのログインは無効になります（この画面のログインは維持されます）。</p>
        <label class="field"><span class="req">現在のパスワード</span><input type="password" name="current" autocomplete="current-password" required></label>
        <label class="field"><span class="req">新しいパスワード（8文字以上）</span><input type="password" name="next" autocomplete="new-password" minlength="8" required></label>
        <label class="field"><span class="req">新しいパスワード（確認）</span><input type="password" name="confirm" autocomplete="new-password" required></label>
        <div class="actions"><button type="submit" class="btn-primary">変更する</button><a class="btn" href="#/inbox">キャンセル</a></div>
      </form>`;
    const f = $('#pw-form');
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (f.next.value !== f.confirm.value) return toast('新しいパスワードが一致しません', 'error');
      try {
        await api('POST', '/api/auth/password', { current_password: f.current.value, new_password: f.next.value });
        toast('パスワードを変更しました', 'ok'); location.hash = '#/inbox';
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  async function refreshChrome() {
    $('#nav-templates').hidden = state.user.role !== 'admin';
    $('#nav-users').hidden = state.user.role !== 'admin';
    $('#nav-backup').hidden = state.user.role !== 'admin';
    try {
      const c = await api('GET', '/api/ringi/counts');
      const b1 = $('#badge-inbox'); b1.textContent = c.inbox; b1.hidden = !c.inbox;
      const b2 = $('#badge-returned'); b2.textContent = c.mine_returned; b2.hidden = !c.mine_returned;
    } catch { /* ignore */ }
  }
  function setNav(key) { document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === key)); }

  // ---------- ルーター ----------
  const routes = [
    [/^#\/(inbox|mine|all)$/, (m) => renderList(m[1])],
    [/^#\/new$/, () => renderForm(null)],
    [/^#\/edit\/(\d+)$/, (m) => renderForm(Number(m[1]))],
    [/^#\/ringi\/(\d+)$/, (m) => renderDetail(Number(m[1]))],
    [/^#\/templates$/, () => renderTemplates()],
    [/^#\/templates\/new$/, () => renderTemplateForm(null)],
    [/^#\/templates\/(\d+)$/, (m) => renderTemplateForm(Number(m[1]))],
    [/^#\/users$/, () => renderUsers()],
    [/^#\/password$/, () => renderPassword()],
    [/^#\/backup$/, () => renderBackup()],
  ];
  async function render() {
    if (!state.user) { if (!$('#login-form')) showLogin(); return; }   // 未ログインはログイン画面のみ
    const hash = location.hash || '#/inbox';
    for (const [re, fn] of routes) {
      const m = hash.match(re);
      if (m) { try { await fn(m); } catch (e) { app.innerHTML = `<div class="alert danger">${esc(e.message)}</div>`; } return; }
    }
    location.hash = '#/inbox';
  }
  window.addEventListener('hashchange', render);

  // ---------- 一覧 ----------
  const listState = { status: '', q: '' };
  async function renderList(filter) {
    setNav(filter);
    const titles = { inbox: '承認待ち（あなたの判断が必要な稟議）', mine: '自分の申請', all: '稟議一覧' };
    const S = state.constants.STATUS;
    app.innerHTML = `
      <div class="page-head"><h1>${titles[filter]}</h1></div>
      <div class="toolbar">
        <select id="f-status" style="width:auto">
          <option value="">すべてのステータス</option>
          ${Object.entries(S).map(([k, v]) => `<option value="${k}" ${listState.status === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <input type="search" id="f-q" placeholder="件名・番号・申請者で検索" value="${esc(listState.q)}">
      </div>
      <div id="list-body"><p class="muted">読み込み中…</p></div>`;
    const load = async () => {
      const params = new URLSearchParams({ filter, status: listState.status, q: listState.q });
      const rows = await api('GET', `/api/ringi?${params}`);
      $('#list-body').innerHTML = rows.length ? `
        <table class="list">
          <thead><tr><th>番号</th><th>件名</th><th>申請者</th><th style="text-align:right">金額</th><th>ステータス</th><th>現在のステップ</th><th>更新日時</th></tr></thead>
          <tbody>${rows.map((r) => `
            <tr data-id="${r.id}">
              <td class="num">${esc(r.number)}</td>
              <td><b>${esc(r.title)}</b>${r.category ? `<br><span class="small muted">${esc(r.category)}</span>` : ''}</td>
              <td>${esc(r.applicant_name)}<br><span class="small muted">${esc(r.applicant_dept)}</span></td>
              <td class="amount">${yen(r.amount)}</td>
              <td><span class="tag ${r.status}">${r.status_label}</span>${r.my_turn ? ' <span class="tag my-turn">要対応</span>' : ''}${r.round > 1 ? `<br><span class="small muted">再申請 ${r.round}回目</span>` : ''}</td>
              <td>${r.current_step ? `${r.step_done + 1}/${r.step_total} ${esc(r.current_step.name)}<br><span class="small muted">待ち: ${esc(r.current_step.pending_approvers.join('、'))}</span>` : `<span class="muted">${r.status === 'approved' ? `${r.step_total}/${r.step_total} 完了` : '—'}</span>`}</td>
              <td class="num small">${dt(r.updated_at)}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : `<div class="empty">該当する稟議はありません${filter === 'mine' ? '。<a href="#/new">新規申請</a>から作成できます' : ''}</div>`;
      document.querySelectorAll('tr[data-id]').forEach((tr) => (tr.onclick = () => (location.hash = `#/ringi/${tr.dataset.id}`)));
    };
    $('#f-status').onchange = (e) => { listState.status = e.target.value; load(); };
    let t; $('#f-q').oninput = (e) => { listState.q = e.target.value; clearTimeout(t); t = setTimeout(load, 250); };
    await load();
  }

  // ---------- ステップエディタ (個別ルート / テンプレート共用) ----------
  function stepEditor(container, steps, { withMinAmount = false } = {}) {
    const data = steps.length ? steps.map((s) => ({ name: s.name, mode: s.mode, approver_ids: [...(s.approver_ids || s.approvers?.map((a) => a.id) || [])], min_amount: s.min_amount ?? '' })) : [{ name: '', mode: 'any', approver_ids: [], min_amount: '' }];
    const draw = () => {
      container.innerHTML = `<div class="step-editor">${data.map((s, i) => `
        <div class="step-row" data-i="${i}">
          <div class="step-row-head">
            <span class="seq">${i + 1}</span>
            <input type="text" data-f="name" placeholder="ステップ名（例: 課長承認）" value="${esc(s.name)}">
            <select data-f="mode"><option value="any" ${s.mode === 'any' ? 'selected' : ''}>誰か1人が承認</option><option value="all" ${s.mode === 'all' ? 'selected' : ''}>全員が承認</option></select>
            ${withMinAmount ? `<input type="number" data-f="min_amount" min="0" placeholder="適用最低金額(任意)" value="${esc(s.min_amount)}" title="金額がこの値未満のときはこのステップをスキップ">` : ''}
            <button type="button" class="btn-sm" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="btn-sm" data-act="down" ${i === data.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" class="btn-sm" data-act="del" ${data.length === 1 ? 'disabled' : ''}>削除</button>
          </div>
          <div class="field-label">承認者 <span class="muted">(複数可)</span></div>
          <div class="checks">${state.users.filter((u) => u.is_approver || s.approver_ids.includes(u.id)).map((u) => `<label class="inline-check"><input type="checkbox" data-f="ap" value="${u.id}" ${s.approver_ids.includes(u.id) ? 'checked' : ''}> ${esc(u.name)} <span class="muted small">${esc(u.dept)} ${esc(u.title)}${u.is_approver ? '' : '（承認者権限なし）'}</span></label>`).join('') || '<span class="muted small">承認者権限を持つユーザーがいません。管理者が「ユーザー管理」で設定してください。</span>'}</div>
        </div>`).join('')}
        <button type="button" class="btn-sm" data-act="add">＋ ステップを追加</button>
      </div>`;
      container.querySelectorAll('.step-row').forEach((row) => {
        const i = Number(row.dataset.i);
        row.querySelector('[data-f=name]').oninput = (e) => (data[i].name = e.target.value);
        row.querySelector('[data-f=mode]').onchange = (e) => (data[i].mode = e.target.value);
        const ma = row.querySelector('[data-f=min_amount]'); if (ma) ma.oninput = (e) => (data[i].min_amount = e.target.value);
        row.querySelectorAll('[data-f=ap]').forEach((cb) => (cb.onchange = () => { const id = Number(cb.value); data[i].approver_ids = cb.checked ? [...data[i].approver_ids, id] : data[i].approver_ids.filter((x) => x !== id); }));
        row.querySelector('[data-act=up]').onclick = () => { [data[i - 1], data[i]] = [data[i], data[i - 1]]; draw(); };
        row.querySelector('[data-act=down]').onclick = () => { [data[i + 1], data[i]] = [data[i], data[i + 1]]; draw(); };
        row.querySelector('[data-act=del]').onclick = () => { data.splice(i, 1); draw(); };
      });
      container.querySelector('[data-act=add]').onclick = () => { data.push({ name: '', mode: 'any', approver_ids: [], min_amount: '' }); draw(); };
    };
    draw();
    return () => data.map((s) => ({ name: s.name, mode: s.mode, approver_ids: s.approver_ids, min_amount: withMinAmount ? (s.min_amount === '' ? null : Number(s.min_amount)) : undefined }));
  }

  // ---------- 申請フォーム (新規 / 編集) ----------
  const MAX_ATTACH = 5, MAX_ATTACH_BYTES = 5 * 1024 * 1024; // 添付: 最大5件・1件5MB (サーバー側と同じ値)
  const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  // 認証 Cookie 付きでファイルをダウンロード (添付 / CSV)
  async function downloadFile(url, filename) {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'ダウンロードに失敗しました');
      const blob = await res.blob(); const href = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = href; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10000);
    } catch (err) { toast(err.message, 'error'); }
  }
  const readFileB64 = (file) => new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result.split(',')[1]); fr.onerror = reject; fr.readAsDataURL(file); });

  // 明細エディタ: 品目 / 数量 / 単価 → 金額自動計算。戻り値は getter
  function itemsEditor(container, items, onChange) {
    const data = items.length ? items.map((it) => ({ name: it.name, qty: it.qty, unit_price: it.unit_price, note: it.note || '' })) : [];
    const total = () => data.reduce((a, it) => a + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
    const draw = () => {
      container.innerHTML = `
        <table class="items">
          <thead><tr><th style="width:36%">品目</th><th>数量</th><th>単価（円）</th><th>金額</th><th>備考</th><th></th></tr></thead>
          <tbody>${data.map((it, i) => `
            <tr data-i="${i}">
              <td><input type="text" data-f="name" value="${esc(it.name)}" placeholder="品目・内容"></td>
              <td><input type="number" data-f="qty" min="0" step="any" value="${esc(it.qty)}"></td>
              <td><input type="number" data-f="unit_price" min="0" step="1" value="${esc(it.unit_price)}"></td>
              <td class="amount">${yen((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</td>
              <td><input type="text" data-f="note" value="${esc(it.note)}" placeholder="任意"></td>
              <td><button type="button" class="btn-sm" data-act="del" title="行を削除">✕</button></td>
            </tr>`).join('')}
            ${data.length ? '' : '<tr><td colspan="6" class="muted" style="text-align:center">明細なし（金額欄に直接入力できます）</td></tr>'}
          </tbody>
          <tfoot><tr><td colspan="3" style="text-align:right"><b>合計</b></td><td class="amount"><b>${yen(total())}</b></td><td colspan="2"><button type="button" class="btn-sm" data-act="add">＋ 行を追加</button></td></tr></tfoot>
        </table>`;
      container.querySelectorAll('tr[data-i]').forEach((row) => {
        const i = Number(row.dataset.i);
        row.querySelectorAll('input').forEach((inp) => (inp.oninput = () => {
          data[i][inp.dataset.f] = inp.value;
          row.querySelector('td.amount').textContent = yen((Number(data[i].qty) || 0) * (Number(data[i].unit_price) || 0));
          container.querySelector('tfoot td.amount b').textContent = yen(total());
          onChange(total(), data.length > 0);
        }));
        row.querySelector('[data-act=del]').onclick = () => { data.splice(i, 1); draw(); onChange(total(), data.length > 0); };
      });
      container.querySelector('[data-act=add]').onclick = () => { data.push({ name: '', qty: 1, unit_price: '', note: '' }); draw(); container.querySelector('tr[data-i]:last-of-type input').focus(); onChange(total(), true); };
    };
    draw();
    return () => data.map((it) => ({ name: it.name, qty: it.qty, unit_price: it.unit_price, note: it.note }));
  }

  async function renderForm(id) {
    setNav(id ? null : 'new');
    state.templates = await api('GET', '/api/templates');
    let r = null;
    if (id) {
      r = await api('GET', `/api/ringi/${id}`);
      if (!r.perms.can_edit) { app.innerHTML = `<div class="alert warn">この稟議は現在編集できません（${esc(r.status_label)}）。<a href="#/ringi/${id}">詳細へ戻る</a></div>`; return; }
    }
    const useTemplate = r ? !!r.template_id : true;
    const existingAtt = r ? [...r.attachments] : [];   // 既存添付 (編集時)
    const newFiles = [];                                // 追加する添付 {file, b64}
    const removeIds = new Set();
    const lastReturn = r && r.status === 'returned' ? [...r.history].reverse().find((h) => h.action === 'return') : null;

    app.innerHTML = `
      <div class="page-head">
        <div><h1 style="margin:0">${r ? `稟議の編集` : '新規稟議申請'}</h1>${r ? `<div class="muted small">${esc(r.number)}${r.round ? ` ・ これまで ${r.round} 回申請` : ''}</div>` : '<div class="muted small">申請者: ' + esc(userLabel(state.user)) + '</div>'}</div>
      </div>
      ${lastReturn ? `<div class="alert warn"><b>差戻し中</b> — ${esc(lastReturn.actor_name)} から差し戻されています。指摘内容を反映して再申請してください。<div class="cm" style="margin-top:6px;white-space:pre-wrap">「${esc(lastReturn.comment)}」</div></div>` : ''}
      <form id="ringi-form" novalidate>
        <div class="card">
          <h2>1. 基本情報</h2>
          <label class="field"><span class="req">件名</span><input type="text" name="title" required maxlength="200" placeholder="例: 開発用ノートPC 5台の購入" value="${esc(r?.title)}"></label>
          <div class="row">
            <label class="field"><span>区分</span><select name="category">${CATEGORIES.map((c) => `<option ${(r?.category || '経費') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
            <label class="field"><span>希望期日</span><input type="date" name="desired_date" value="${esc(r?.desired_date)}"></label>
            <label class="field"><span>支払先 / 取引先</span><input type="text" name="vendor" maxlength="100" placeholder="例: 株式会社○○" value="${esc(r?.vendor)}"></label>
          </div>
          <label class="field"><span>内容・理由</span><textarea name="body" placeholder="目的、背景、選定理由、期待効果など。承認者が判断できるように具体的に。">${esc(r?.body)}</textarea></label>
        </div>

        <div class="card">
          <h2>2. 金額・明細</h2>
          <div id="items-editor"></div>
          <div class="row" style="margin-top:12px;align-items:flex-end">
            <label class="field" style="max-width:280px"><span class="req">申請金額（円）</span><input type="number" name="amount" min="0" step="1" value="${r ? r.amount : 0}"><span class="small muted" id="amount-note"></span></label>
          </div>
        </div>

        <div class="card">
          <h2>3. 添付ファイル <span class="muted small">（見積書・仕様書など。1件5MBまで、<b>最大${MAX_ATTACH}件</b>）</span> <span class="tag mode" id="att-count">0 / ${MAX_ATTACH}</span></h2>
          <div id="att-list" class="att-list"></div>
          <label class="btn" id="att-pick" style="display:inline-flex;cursor:pointer">📎 ファイルを選択 <input type="file" id="att-input" multiple hidden></label>
          <span class="muted small" id="att-hint"></span>
        </div>

        <div class="card">
          <h2>4. 承認ルート</h2>
          <div class="actions" style="margin-bottom:12px">
            <label class="inline-check"><input type="radio" name="route_kind" value="template" ${useTemplate ? 'checked' : ''}> テンプレートから選ぶ</label>
            <label class="inline-check"><input type="radio" name="route_kind" value="custom" ${!useTemplate ? 'checked' : ''}> 個別にルートを指定する</label>
          </div>
          <div id="route-template">
            <label class="field"><span>テンプレート</span><select name="template_id">${state.templates.map((t) => `<option value="${t.id}" ${r?.template_id === t.id ? 'selected' : ''}>${esc(t.name)}${t.description ? ` — ${esc(t.description)}` : ''}</option>`).join('')}</select></label>
            <div class="field-label">この金額で適用されるステップ <span class="muted">(金額条件で自動スキップ — 薄い表示はスキップ)</span></div>
            <div id="route-preview" class="route-preview"></div>
          </div>
          <div id="route-custom" hidden></div>
        </div>

        <div class="card">
          <label class="field"><span>承認者へのコメント（任意）</span><input type="text" name="comment" maxlength="2000" placeholder="例: 至急のため早めのご確認をお願いします"></label>
          <div class="actions">
            <button type="button" class="btn-primary" id="btn-confirm">${r && r.status === 'returned' ? '内容を確認して再申請 →' : '内容を確認して申請 →'}</button>
            <button type="button" id="btn-draft">下書き保存</button>
            <a class="btn" href="${r ? `#/ringi/${r.id}` : '#/mine'}">キャンセル</a>
          </div>
        </div>
      </form>
      <dialog id="confirm-dialog" class="confirm"></dialog>`;

    const form = $('#ringi-form');

    // --- 明細 ⇔ 金額 ---
    const amountNote = $('#amount-note');
    const getItems = itemsEditor($('#items-editor'), r ? r.items : [], (total, hasItems) => {
      if (hasItems) { form.amount.value = total; form.amount.readOnly = true; amountNote.textContent = '明細の合計が自動で入ります'; }
      else { form.amount.readOnly = false; amountNote.textContent = ''; }
      preview();
    });
    if (r && r.items.length) { form.amount.readOnly = true; amountNote.textContent = '明細の合計が自動で入ります'; }

    // --- 添付 ---
    const drawAtt = () => {
      const rows = [
        ...existingAtt.filter((a) => !removeIds.has(a.id)).map((a) => `<div class="att"><span>📄 ${esc(a.filename)} <span class="muted small">${fmtBytes(a.size)}</span></span><button type="button" class="btn-link" data-rm-existing="${a.id}">削除</button></div>`),
        ...newFiles.map((f, i) => `<div class="att new"><span>📄 ${esc(f.file.name)} <span class="muted small">${fmtBytes(f.file.size)} ・ 新規</span></span><button type="button" class="btn-link" data-rm-new="${i}">取消</button></div>`),
      ];
      $('#att-list').innerHTML = rows.join('') || '<div class="muted small">添付ファイルはありません</div>';
      const count = existingAtt.length - removeIds.size + newFiles.length;
      $('#att-count').textContent = `${count} / ${MAX_ATTACH}`;
      const full = count >= MAX_ATTACH;
      $('#att-input').disabled = full; $('#att-pick').classList.toggle('disabled', full);
      $('#att-hint').textContent = full ? `上限の${MAX_ATTACH}件に達しています。追加するには既存の添付を削除してください。` : `あと${MAX_ATTACH - count}件追加できます`;
      $('#att-list').querySelectorAll('[data-rm-existing]').forEach((b) => (b.onclick = () => { removeIds.add(Number(b.dataset.rmExisting)); drawAtt(); }));
      $('#att-list').querySelectorAll('[data-rm-new]').forEach((b) => (b.onclick = () => { newFiles.splice(Number(b.dataset.rmNew), 1); drawAtt(); }));
    };
    drawAtt();
    $('#att-input').onchange = async (e) => {
      const files = [...e.target.files];
      let skipped = 0;
      for (const file of files) {
        if (file.size > MAX_ATTACH_BYTES) { toast(`${file.name} は5MBを超えています`, 'error'); continue; }
        if (existingAtt.length - removeIds.size + newFiles.length >= MAX_ATTACH) { skipped++; continue; }
        newFiles.push({ file, b64: await readFileB64(file) });
      }
      if (skipped) toast(`添付は最大${MAX_ATTACH}件までです（${skipped}件は追加されませんでした）`, 'error');
      e.target.value = ''; drawAtt();
    };

    // --- ルート ---
    const getSteps = stepEditor($('#route-custom'), r && !r.template_id ? r.steps : []);
    const syncKind = () => { const k = form.route_kind.value; $('#route-template').hidden = k !== 'template'; $('#route-custom').hidden = k !== 'custom'; };
    form.querySelectorAll('[name=route_kind]').forEach((x) => (x.onchange = syncKind)); syncKind();
    function resolvedTemplateSteps() {
      const t = state.templates.find((x) => x.id === Number(form.template_id.value)); if (!t) return [];
      const amount = Number(form.amount.value || 0);
      return t.steps.map((s) => ({ ...s, skipped: s.min_amount != null && amount < s.min_amount }));
    }
    function preview() {
      if (!$('#route-preview')) return;
      $('#route-preview').innerHTML = resolvedTemplateSteps().map((s) => `<span class="chip ${s.skipped ? 'skipped' : ''}" title="${s.skipped ? `${yen(s.min_amount)}未満のためスキップ` : ''}"><b>${esc(s.name)}</b> ${esc(s.approvers.map((a) => a.name).join(' / '))} <span class="muted">(${s.mode === 'all' ? '全員' : '1人'})</span></span>`).join('<span class="arrow">→</span>');
    }
    form.template_id.onchange = preview; form.amount.oninput = preview; preview();

    // --- payload / 送信 ---
    const buildPayload = (submit) => {
      const p = {
        title: form.title.value, category: form.category.value, amount: Number(form.amount.value || 0), body: form.body.value,
        desired_date: form.desired_date.value, vendor: form.vendor.value, items: getItems(),
        attachments: newFiles.map((f) => ({ filename: f.file.name, mime: f.file.type || 'application/octet-stream', data: f.b64 })),
        remove_attachment_ids: [...removeIds],
        comment: form.comment.value, submit,
      };
      if (form.route_kind.value === 'template') p.template_id = Number(form.template_id.value); else p.steps = getSteps();
      return p;
    };
    const clientValidate = (p) => {
      if (!p.title.trim()) { form.title.focus(); throw new Error('件名を入力してください'); }
      if (p.steps && p.steps.some((s) => !s.name.trim() || !s.approver_ids.length)) throw new Error('個別ルートの各ステップに名称と承認者を設定してください');
    };
    let sending = false;
    const send = async (p, btn) => {
      if (sending) return; sending = true; if (btn) btn.disabled = true;
      try {
        const res = r ? await api('PUT', `/api/ringi/${r.id}`, p) : await api('POST', '/api/ringi', p);
        toast(p.submit ? (r && r.status === 'returned' ? '再申請しました' : '申請しました') : '下書きを保存しました', 'ok');
        refreshChrome(); location.hash = `#/ringi/${res.id}`;
      } catch (err) { toast(err.message, 'error'); sending = false; if (btn) btn.disabled = false; }
    };
    $('#btn-draft').onclick = (e) => { try { const p = buildPayload(false); clientValidate(p); send(p, e.target); } catch (err) { toast(err.message, 'error'); } };

    // --- 確認ダイアログ ---
    $('#btn-confirm').onclick = () => {
      let p; try { p = buildPayload(true); clientValidate(p); } catch (err) { return toast(err.message, 'error'); }
      const steps = p.template_id
        ? resolvedTemplateSteps().filter((s) => !s.skipped).map((s) => ({ name: s.name, mode: s.mode, names: s.approvers.map((a) => a.name) }))
        : p.steps.map((s) => ({ name: s.name, mode: s.mode, names: s.approver_ids.map((id) => userById(id)?.name || id) }));
      const items = p.items.filter((it) => it.name || it.qty !== '' || it.unit_price !== '');
      const attCount = existingAtt.length - removeIds.size + newFiles.length;
      const dlg = $('#confirm-dialog');
      dlg.innerHTML = `
        <h2>申請内容の確認</h2>
        <p class="muted small">以下の内容で${r && r.status === 'returned' ? '再申請' : '申請'}します。承認ルートの最初のステップの承認者に通知されます。</p>
        <dl class="meta">
          <dt>件名</dt><dd><b>${esc(p.title)}</b></dd>
          <dt>区分</dt><dd>${esc(p.category)}</dd>
          <dt>申請金額</dt><dd><b>${yen(p.amount)}</b>${items.length ? ` <span class="muted small">（明細 ${items.length} 行）</span>` : ''}</dd>
          <dt>希望期日</dt><dd>${esc(p.desired_date) || '—'}</dd>
          <dt>支払先</dt><dd>${esc(p.vendor) || '—'}</dd>
          <dt>添付</dt><dd>${attCount ? `${attCount} 件` : 'なし'}</dd>
          <dt>承認ルート</dt><dd><div class="route-preview">${steps.map((s) => `<span class="chip"><b>${esc(s.name)}</b> ${esc(s.names.join(' / '))} <span class="muted">(${s.mode === 'all' ? '全員' : '1人'})</span></span>`).join('<span class="arrow">→</span>') || '<span class="muted">（なし）</span>'}</div></dd>
          ${p.comment ? `<dt>コメント</dt><dd>${esc(p.comment)}</dd>` : ''}
        </dl>
        ${p.body ? `<div class="field-label">内容・理由</div><div class="body-text small" style="max-height:160px;overflow:auto">${esc(p.body)}</div>` : '<div class="alert warn small">内容・理由が未入力です。承認者の判断材料として記入を推奨します。</div>'}
        <div class="actions" style="margin-top:16px;justify-content:flex-end">
          <button type="button" id="cf-back">← 修正する</button>
          <button type="button" class="btn-primary" id="cf-ok">${r && r.status === 'returned' ? 'この内容で再申請する' : 'この内容で申請する'}</button>
        </div>`;
      dlg.showModal();
      $('#cf-back').onclick = () => dlg.close();
      $('#cf-ok').onclick = (e) => { send(p, e.target).then(() => dlg.close()); };
    };
  }

  // ---------- 詳細 ----------
  async function renderDetail(id) {
    setNav(null);
    const r = await api('GET', `/api/ringi/${id}`);
    const A = state.constants.ACTION, me = state.user.id;
    const statusAlert = {
      pending: r.current_step ? `<div class="alert info">承認中 — 現在「${esc(r.current_step.name)}」（${r.current_step.mode === 'all' ? '全員承認' : '1人承認'}）で ${esc(r.current_step.approvers.filter((a) => !a.decision).map((a) => a.user_name).join('、'))} の判断待ち</div>` : '',
      returned: `<div class="alert warn">差戻し中 — 申請者が内容を修正して再申請する必要があります</div>`,
      approved: `<div class="alert ok">承認済 — すべての承認ステップが完了しました（${dt(r.completed_at)}）</div>`,
      rejected: `<div class="alert danger">却下 — この稟議は却下されました（${dt(r.completed_at)}）</div>`,
      withdrawn: `<div class="alert">取下げ — 申請者により取り下げられました</div>`,
      draft: `<div class="alert">下書き — まだ申請されていません</div>`,
    }[r.status] || '';

    app.innerHTML = `
      <div class="page-head">
        <div><div class="muted small">${esc(r.number)}${r.round > 1 ? ` ・ 再申請 ${r.round}回目` : ''}</div><h1 style="margin:0">${esc(r.title)} <span class="tag ${r.status}">${r.status_label}</span></h1></div>
        <div class="actions">${r.perms.can_edit ? `<a class="btn" href="#/edit/${r.id}">編集</a>` : ''}<a class="btn" href="#/inbox">← 一覧へ</a></div>
      </div>
      ${statusAlert}
      <div class="grid2">
        <div>
          <div class="card">
            <dl class="meta">
              <dt>申請者</dt><dd>${esc(userLabel(r.applicant))}</dd>
              <dt>区分</dt><dd>${esc(r.category || '—')}</dd>
              <dt>金額</dt><dd><b>${yen(r.amount)}</b></dd>
              <dt>希望期日</dt><dd>${esc(r.desired_date) || '—'}</dd>
              <dt>支払先</dt><dd>${esc(r.vendor) || '—'}</dd>
              <dt>ルート</dt><dd>${r.template ? esc(r.template.name) : '個別指定'}</dd>
              <dt>作成</dt><dd>${dt(r.created_at)}</dd>
              <dt>申請日時</dt><dd>${dt(r.submitted_at)}</dd>
            </dl>
            <hr>
            <h3>内容</h3>
            <div class="body-text">${esc(r.body) || '<span class="muted">（内容なし）</span>'}</div>
            ${r.items.length ? `<hr><h3>明細</h3>
            <table class="items view"><thead><tr><th>品目</th><th>数量</th><th>単価</th><th>金額</th><th>備考</th></tr></thead>
              <tbody>${r.items.map((it) => `<tr><td>${esc(it.name)}</td><td class="amount">${esc(it.qty)}</td><td class="amount">${yen(it.unit_price)}</td><td class="amount">${yen(it.qty * it.unit_price)}</td><td class="small">${esc(it.note)}</td></tr>`).join('')}</tbody>
              <tfoot><tr><td colspan="3" style="text-align:right"><b>合計</b></td><td class="amount"><b>${yen(r.items.reduce((a, it) => a + it.qty * it.unit_price, 0))}</b></td><td></td></tr></tfoot></table>` : ''}
            <hr><h3>添付ファイル</h3>
            ${r.attachments.length ? `<div class="att-list">${r.attachments.map((a) => `<div class="att"><a href="#" data-dl="${a.id}">📄 ${esc(a.filename)}</a> <span class="muted small">${fmtBytes(a.size)} ・ ${esc(a.uploaded_by_name)} ・ ${dt(a.created_at)}</span></div>`).join('')}</div>` : '<div class="muted small">添付ファイルはありません</div>'}
          </div>
          <div class="card">
            <h2>承認ステップ</h2>
            <div class="stepper">${r.steps.map((s) => `
              <div class="step ${s.status}">
                <div class="dot">${s.status === 'approved' ? '✓' : s.status === 'rejected' ? '✕' : s.status === 'returned' ? '↩' : s.seq}</div>
                <div>
                  <div class="step-title">${esc(s.name)} <span class="tag mode">${s.mode === 'all' ? '全員承認' : '1人承認'}</span> <span class="small muted">${state.constants.STEP_STATUS[s.status]}</span></div>
                  ${s.approvers.map((a) => `<div class="approver">👤 ${esc(a.user_name)} <span class="muted small">${esc(a.user_dept)} ${esc(a.user_title)}</span>
                    ${a.decision ? `<span class="dec ${a.decision}">${A[{ approved: 'approve', rejected: 'reject', returned: 'return' }[a.decision]]} ${dt(a.decided_at)}</span>` : s.status === 'active' ? `<span class="dec ${a.user_id === me ? 'me' : ''}">${a.user_id === me ? 'あなたの判断待ち' : '判断待ち'}</span>` : ''}
                    ${a.comment ? `<span class="cm">「${esc(a.comment)}」</span>` : ''}</div>`).join('')}
                </div>
              </div>`).join('')}
            </div>
          </div>
          <div class="card">
            <h2>タイムライン</h2>
            <ul class="timeline">${r.history.map((h) => `
              <li><div class="when">${dt(h.created_at)}</div>
                <div class="what"><span class="act ${h.action}">${A[h.action] || h.action}</span>${esc(h.actor_name)}
                  ${h.step_name ? `<span class="muted small"> — ${esc(h.step_name)}</span>` : ''}
                  ${h.action === 'return' ? `<span class="small"> → 差戻し先: <b>${h.target_seq === 0 ? '申請者' : `ステップ${h.target_seq}「${esc(r.steps.find((s) => s.seq === h.target_seq)?.name || '')}」`}</b></span>` : ''}
                  ${h.round ? `<span class="round">#${h.round}</span>` : ''}
                  ${h.comment ? `<div class="cm">${esc(h.comment)}</div>` : ''}</div></li>`).join('')}
            </ul>
          </div>
        </div>
        <div class="action-panel">${actionPanel(r)}</div>
      </div>`;
    bindActions(r);
    app.querySelectorAll('[data-dl]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); downloadFile(`/api/ringi/${r.id}/attachments/${a.dataset.dl}`, a.textContent.replace(/^📄 /, '')); }));
  }

  function actionPanel(r) {
    const p = r.perms;
    const decide = p.can_approve || p.can_reject || p.can_return;
    const parts = [];
    if (decide) parts.push(`
      <div class="card">
        <h2>承認判断</h2>
        <p class="small muted">ステップ「${esc(r.current_step.name)}」の承認者として判断してください。差戻し・却下の場合はコメントが必須です。</p>
        <label class="field"><span>コメント</span><textarea id="dec-comment" placeholder="承認時は任意、差戻し・却下時は必須"></textarea></label>
        <div class="actions" style="margin-bottom:12px"><button class="btn-ok" data-act="approve">✓ 承認する</button><button class="btn-danger" data-act="reject">✕ 却下する</button></div>
        <details>
          <summary style="cursor:pointer;color:var(--warn);font-weight:600">↩ 差し戻す（任意）</summary>
          <label class="field" style="margin-top:8px"><span>差戻し先</span><select id="return-target">${p.return_targets.map((t) => `<option value="${t.seq}">${t.seq === 0 ? '申請者（内容の修正・再申請を依頼）' : `ステップ${t.seq}「${esc(t.name)}」に戻す（再承認を依頼）`}</option>`).join('')}</select></label>
          <button class="btn-warn" data-act="return">↩ 差し戻す</button>
        </details>
      </div>`);
    if (p.can_submit || p.can_withdraw || p.can_delete) parts.push(`
      <div class="card">
        <h2>申請者の操作</h2>
        ${p.can_submit ? `<p class="small muted">${r.status === 'returned' ? '修正が不要ならそのまま再申請できます。' : '内容を確認して申請してください。'}</p><label class="field"><span>コメント（任意）</span><input type="text" id="sub-comment"></label><div class="actions"><button class="btn-primary" data-act="submit">${r.status === 'returned' ? '再申請する' : '申請する'}</button>${p.can_edit ? `<a class="btn" href="#/edit/${r.id}">編集する</a>` : ''}${p.can_delete ? `<button class="btn-danger" data-act="delete">下書きを削除</button>` : ''}</div>` : ''}
        ${p.can_withdraw ? `<label class="field"><span>取下げ理由（任意）</span><input type="text" id="wd-comment"></label><div class="actions"><button data-act="withdraw">申請を取り下げる</button></div>` : ''}
      </div>`);
    parts.push(`
      <div class="card">
        <h2>コメント</h2>
        <label class="field"><textarea id="cm-comment" placeholder="関係者へのコメント・質問"></textarea></label>
        <div class="actions"><button data-act="comment">コメントを投稿</button></div>
      </div>`);
    return parts.join('');
  }

  function bindActions(r) {
    const run = async (btn, fn, okMsg) => {
      btn.disabled = true;
      try { await fn(); toast(okMsg, 'ok'); refreshChrome(); await renderDetail(r.id); }
      catch (e) { toast(e.message, 'error'); btn.disabled = false; }
    };
    app.querySelectorAll('[data-act]').forEach((btn) => {
      const act = btn.dataset.act;
      btn.onclick = () => {
        const dec = () => $('#dec-comment')?.value || '';
        if (act === 'approve') return run(btn, () => api('POST', `/api/ringi/${r.id}/approve`, { comment: dec() }), '承認しました');
        if (act === 'reject') { if (!dec().trim()) return toast('却下理由を入力してください', 'error'); if (!confirm('この稟議を却下します。よろしいですか？')) return; return run(btn, () => api('POST', `/api/ringi/${r.id}/reject`, { comment: dec() }), '却下しました'); }
        if (act === 'return') { if (!dec().trim()) return toast('差戻し理由を入力してください', 'error'); return run(btn, () => api('POST', `/api/ringi/${r.id}/return`, { comment: dec(), target_seq: Number($('#return-target').value) }), '差し戻しました'); }
        if (act === 'submit') return run(btn, () => api('POST', `/api/ringi/${r.id}/submit`, { comment: $('#sub-comment').value }), '申請しました');
        if (act === 'withdraw') { if (!confirm('申請を取り下げます。よろしいですか？')) return; return run(btn, () => api('POST', `/api/ringi/${r.id}/withdraw`, { comment: $('#wd-comment').value }), '取り下げました'); }
        if (act === 'comment') return run(btn, () => api('POST', `/api/ringi/${r.id}/comment`, { comment: $('#cm-comment').value }), 'コメントを投稿しました');
        if (act === 'delete') { if (!confirm('下書きを削除します。よろしいですか？')) return; btn.disabled = true; api('DELETE', `/api/ringi/${r.id}`).then(() => { toast('削除しました', 'ok'); location.hash = '#/mine'; }).catch((e) => { toast(e.message, 'error'); btn.disabled = false; }); }
      };
    });
  }

  // ---------- ルートテンプレート管理 (管理者) ----------
  async function renderTemplates() {
    setNav('templates');
    const ts = await api('GET', '/api/templates');
    const admin = state.user.role === 'admin';
    app.innerHTML = `
      <div class="page-head"><h1>承認ルートテンプレート</h1>${admin ? `<a class="btn btn-primary" href="#/templates/new">＋ 新規テンプレート</a>` : ''}</div>
      ${admin ? '' : '<div class="alert warn">テンプレートの編集は管理者のみ可能です（閲覧のみ）</div>'}
      ${ts.map((t) => `
        <div class="card">
          <div class="page-head" style="margin-bottom:8px"><div><h2 style="margin:0">${esc(t.name)}</h2><div class="muted small">${esc(t.description)}</div></div>
            ${admin ? `<div class="actions"><a class="btn btn-sm" href="#/templates/${t.id}">編集</a><button class="btn-sm btn-danger" data-del="${t.id}">削除</button></div>` : ''}</div>
          <div class="route-preview">${t.steps.map((s) => `<span class="chip"><b>${esc(s.name)}</b> ${esc(s.approvers.map((a) => a.name).join(' / '))} <span class="muted">(${s.mode === 'all' ? '全員' : '1人'}${s.min_amount != null ? `・${yen(s.min_amount)}以上` : ''})</span></span>`).join('<span class="arrow">→</span>')}</div>
        </div>`).join('')}`;
    app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!confirm('このテンプレートを削除しますか？（既存の稟議には影響しません）')) return;
      try { await api('DELETE', `/api/templates/${b.dataset.del}`); toast('削除しました', 'ok'); renderTemplates(); } catch (e) { toast(e.message, 'error'); }
    }));
  }

  async function renderTemplateForm(id) {
    setNav('templates');
    const t = id ? await api('GET', `/api/templates/${id}`) : null;
    app.innerHTML = `
      <div class="page-head"><h1>${t ? 'テンプレートの編集' : '新規テンプレート'}</h1></div>
      <form id="tpl-form" class="card">
        <label class="field"><span class="req">テンプレート名</span><input type="text" name="name" required value="${esc(t?.name)}"></label>
        <label class="field"><span>説明</span><input type="text" name="description" value="${esc(t?.description)}"></label>
        <h3>承認ステップ <span class="muted small">（「適用最低金額」を設定すると、金額がそれ未満の申請ではそのステップが自動的にスキップされます）</span></h3>
        <div id="tpl-steps"></div>
        <hr>
        <div class="actions"><button type="submit" class="btn-primary">保存</button><a class="btn" href="#/templates">キャンセル</a></div>
      </form>`;
    const getSteps = stepEditor($('#tpl-steps'), t ? t.steps : [], { withMinAmount: true });
    const form = $('#tpl-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const payload = { name: form.name.value, description: form.description.value, steps: getSteps() };
      try { t ? await api('PUT', `/api/templates/${t.id}`, payload) : await api('POST', '/api/templates', payload); toast('保存しました', 'ok'); location.hash = '#/templates'; }
      catch (err) { toast(err.message, 'error'); }
    };
  }


  // ---------- ユーザー管理 (管理者のみ: 管理者 / 承認者 の権限設定) ----------
  async function renderUsers() {
    setNav('users');
    if (state.user.role !== 'admin') {
      app.innerHTML = `<div class="alert danger"><b>アクセスできません</b> — この画面は管理者のみ閲覧できます。</div><a class="btn" href="#/inbox">← 承認待ちへ戻る</a>`;
      return;
    }
    let list;
    try { list = await api('GET', '/api/users?all=1'); }
    catch (e) { app.innerHTML = `<div class="alert danger">${esc(e.message)}</div>`; return; }
    const admins = list.filter((u) => u.role === 'admin' && u.active).length, approvers = list.filter((u) => u.is_approver && u.active).length;

    app.innerHTML = `
      <div class="page-head">
        <div><h1 style="margin:0">ユーザー管理</h1><div class="muted small">管理者権限・承認者権限の設定（管理者のみ）　有効ユーザー ${list.filter((u) => u.active).length} 名 ／ 管理者 ${admins} 名 ／ 承認者 ${approvers} 名</div></div>
        <button class="btn-primary" id="btn-new-user">＋ ユーザーを追加</button>
      </div>
      <div class="alert info small">
        <b>管理者</b>: ユーザー管理・承認ルートテンプレートの編集ができます。　<b>承認者</b>: 承認ルートの承認者として指定できるようになります（承認者でないユーザーは申請のみ）。<br>
        権限の変更は即時反映されます。自分自身の管理者権限の解除・無効化、および最後の管理者の解除はできません。無効化・パスワード再設定・管理者権限の解除を行うと、そのユーザーは再ログインが必要になります。
      </div>
      <table class="list users">
        <thead><tr><th>ID</th><th>氏名</th><th>ログインID</th><th>部署</th><th>役職</th><th style="text-align:center">管理者</th><th style="text-align:center">承認者</th><th style="text-align:center">有効</th><th></th></tr></thead>
        <tbody>${list.map((u) => `
          <tr data-id="${u.id}" class="${u.active ? '' : 'inactive'}">
            <td class="num muted">${u.id}</td>
            <td><b>${esc(u.name)}</b>${u.id === state.user.id ? ' <span class="tag my-turn">あなた</span>' : ''}</td>
            <td><code>${esc(u.login_id)}</code></td>
            <td>${esc(u.dept)}</td>
            <td>${esc(u.title)}</td>
            <td style="text-align:center"><label class="switch"><input type="checkbox" data-f="role" ${u.role === 'admin' ? 'checked' : ''} ${u.id === state.user.id ? 'disabled title="自分自身の管理者権限は解除できません"' : ''}><span></span></label></td>
            <td style="text-align:center"><label class="switch"><input type="checkbox" data-f="is_approver" ${u.is_approver ? 'checked' : ''}><span></span></label></td>
            <td style="text-align:center"><label class="switch"><input type="checkbox" data-f="active" ${u.active ? 'checked' : ''} ${u.id === state.user.id ? 'disabled title="自分自身は無効化できません"' : ''}><span></span></label></td>
            <td><button class="btn-sm" data-edit="${u.id}">編集</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
      <dialog id="user-dialog" class="confirm"></dialog>`;

    // トグル (即時保存)
    app.querySelectorAll('tr[data-id] input[type=checkbox]').forEach((cb) => (cb.onchange = async () => {
      const id = Number(cb.closest('tr').dataset.id), f = cb.dataset.f;
      const body = f === 'role' ? { role: cb.checked ? 'admin' : 'user' } : { [f]: cb.checked };
      cb.disabled = true;
      try { await api('PUT', `/api/users/${id}`, body); toast('保存しました', 'ok'); await reloadUsers(); await renderUsers(); }
      catch (e) { toast(e.message, 'error'); cb.checked = !cb.checked; cb.disabled = false; }
    }));
    const openDialog = (u) => {
      const dlg = $('#user-dialog');
      dlg.innerHTML = `
        <h2>${u ? 'ユーザーの編集' : 'ユーザーの追加'}</h2>
        <form id="user-form">
          <label class="field"><span class="req">氏名</span><input type="text" name="name" required maxlength="50" value="${esc(u?.name)}"></label>
          <div class="row">
            <label class="field"><span class="req">ログインID</span><input type="text" name="login_id" required maxlength="50" pattern="[A-Za-z0-9._@-]{3,50}" title="3〜50文字の半角英数字と . _ @ -" autocomplete="off" value="${esc(u?.login_id)}"></label>
            <label class="field"><span class="${u ? '' : 'req'}">${u ? 'パスワード再設定（変更する場合のみ）' : '初期パスワード（8文字以上）'}</span><input type="password" name="password" autocomplete="new-password" minlength="8" ${u ? '' : 'required'} placeholder="${u ? '変更しない場合は空欄' : ''}"></label>
          </div>
          <div class="row">
            <label class="field"><span>部署</span><input type="text" name="dept" maxlength="50" value="${esc(u?.dept)}"></label>
            <label class="field"><span>役職</span><input type="text" name="title" maxlength="50" value="${esc(u?.title)}"></label>
          </div>
          <div class="field-label">権限</div>
          <label class="inline-check"><input type="checkbox" name="is_admin" ${u?.role === 'admin' ? 'checked' : ''} ${u && u.id === state.user.id ? 'disabled' : ''}> 管理者（ユーザー管理・ルート管理）</label><br>
          <label class="inline-check"><input type="checkbox" name="is_approver" ${u?.is_approver ? 'checked' : ''}> 承認者（承認ルートに指定可能）</label><br>
          <label class="inline-check"><input type="checkbox" name="active" ${!u || u.active ? 'checked' : ''} ${u && u.id === state.user.id ? 'disabled' : ''}> 有効（無効にするとログイン・新規指定不可）</label>
          <div class="actions" style="margin-top:16px;justify-content:flex-end"><button type="button" id="ud-cancel">キャンセル</button><button type="submit" class="btn-primary">保存</button></div>
        </form>`;
      dlg.showModal();
      $('#ud-cancel').onclick = () => dlg.close();
      $('#user-form').onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        const body = { name: f.name.value, login_id: f.login_id.value.trim(), dept: f.dept.value, title: f.title.value, role: f.is_admin.checked ? 'admin' : 'user', is_approver: f.is_approver.checked, active: f.active.checked };
        if (f.password.value) body.password = f.password.value;
        if (u && u.id === state.user.id) { body.role = 'admin'; body.active = true; }
        try { u ? await api('PUT', `/api/users/${u.id}`, body) : await api('POST', '/api/users', body); toast('保存しました', 'ok'); dlg.close(); await reloadUsers(); await renderUsers(); }
        catch (err) { toast(err.message, 'error'); }
      };
    };
    $('#btn-new-user').onclick = () => openDialog(null);
    app.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openDialog(list.find((u) => u.id === Number(b.dataset.edit)))));
  }

  // ---------- バックアップ (管理者のみ) ----------
  async function renderBackup() {
    setNav('backup');
    if (state.user.role !== 'admin') {
      app.innerHTML = `<div class="alert danger"><b>アクセスできません</b> — この画面は管理者のみ閲覧できます。</div><a class="btn" href="#/inbox">← 承認待ちへ戻る</a>`;
      return;
    }
    const info = await api('GET', '/api/admin/backups');
    const fmtDT = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return isNaN(d) ? esc(iso) : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
    app.innerHTML = `
      <div class="page-head">
        <div><h1 style="margin:0">バックアップ</h1><div class="muted small">全データを1つのフォルダにまとめて出力します（CSV・添付ファイルの実体・DBの完全コピー）</div></div>
        <button class="btn-primary" id="btn-backup">💾 今すぐバックアップを作成</button>
      </div>
      <div class="alert info small">
        出力先フォルダ: <code>${esc(info.dir)}</code><br>
        1回のバックアップごとに <b>backup_日時/</b> フォルダが作られ、中に <b>各テーブルのCSV</b>（UTF-8 BOM付き・Excelでそのまま開けます）、<b>attachments/</b>（添付ファイルの実体）、<b>ringi.db</b>（復元用のDB完全コピー）、manifest.json、README.txt が入ります。<br>
        復元するときはサーバーを停止し、<code>data/ringi.db</code> をバックアップ内の <code>ringi.db</code> で置き換えて再起動してください。コマンドラインからは <code>npm run backup</code> でも作成できます（定期実行はタスクスケジューラ等で）。
      </div>
      <div id="backup-result"></div>
      <div class="card">
        <h2>バックアップ一覧 <span class="muted small">（${info.backups.length} 件）</span></h2>
        ${info.backups.length ? `<table class="list backups"><thead><tr><th>フォルダ名</th><th>作成日時</th><th style="text-align:right">稟議</th><th style="text-align:right">履歴</th><th style="text-align:right">添付</th><th style="text-align:right">サイズ</th><th></th></tr></thead><tbody>
          ${info.backups.map((b) => `<tr><td><code>${esc(b.name)}</code>${b.complete ? '' : ' <span class="tag rejected">不完全</span>'}</td><td class="num small">${fmtDT(b.created_at)}</td><td class="amount">${b.tables?.ringi?.rows ?? '—'}</td><td class="amount">${b.tables?.history?.rows ?? '—'}</td><td class="amount">${b.attachments ?? '—'}</td><td class="amount">${fmtBytes(b.size)}</td><td><button class="btn-sm btn-danger" data-del="${esc(b.name)}">削除</button></td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">バックアップはまだありません</div>'}
      </div>
      <div class="card">
        <h2>CSV を個別にダウンロード</h2>
        <p class="muted small">フォルダを作らずに、テーブルごとのCSVだけをブラウザで保存します（内容はバックアップ内のCSVと同じ）。</p>
        <div class="actions">${info.tables.map((t) => `<button class="btn-sm" data-csv="${esc(t.key)}">⬇ ${esc(t.title)}</button>`).join('')}</div>
      </div>`;
    $('#btn-backup').onclick = async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = '作成中…';
      try {
        const m = await api('POST', '/api/admin/backups');
        toast('バックアップを作成しました', 'ok');
        await renderBackup();
        $('#backup-result').innerHTML = `<div class="alert ok"><b>作成しました:</b> <code>${esc(m.dir)}</code><br><span class="small">${Object.values(m.tables).map((t) => `${esc(t.title)} ${t.rows}件`).join(' ／ ')} ／ 添付ファイル ${m.attachments}件 ／ 合計 ${fmtBytes(m.size)}</span></div>`;
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = '💾 今すぐバックアップを作成'; }
    };
    app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!confirm(`バックアップ「${b.dataset.del}」をフォルダごと削除します。よろしいですか？`)) return;
      try { await api('DELETE', `/api/admin/backups/${encodeURIComponent(b.dataset.del)}`); toast('削除しました', 'ok'); renderBackup(); } catch (err) { toast(err.message, 'error'); }
    }));
    app.querySelectorAll('[data-csv]').forEach((b) => (b.onclick = () => downloadFile(`/api/admin/export/${b.dataset.csv}.csv`, `${b.dataset.csv}.csv`)));
  }

  // ---------- 起動 ----------
  (async () => {
    try {
      try { state.user = await api('GET', '/api/me'); } catch { state.user = null; }
      if (!state.user) return showLogin();
      await afterLogin();
    } catch (e) { app.innerHTML = `<div class="alert danger">初期化に失敗しました: ${esc(e.message)}</div>`; }
  })();
})();
