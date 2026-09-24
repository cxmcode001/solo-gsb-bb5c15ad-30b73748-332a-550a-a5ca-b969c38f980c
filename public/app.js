'use strict';

/* ================= 基础工具 ================= */

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `请求失败（${res.status}）`);
  }
  return data;
}

let toastTimer = null;
function toast(msg, isErr) {
  toastEl.textContent = msg;
  toastEl.className = isErr ? 'toast err' : 'toast';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 3200);
}

const TYPE_LABEL = { light: '灯光', sound: '音效' };

/* ================= 简易 hash 路由 ================= */

const routes = [];
function route(pattern, handler) {
  // 支持 :param
  const names = [];
  const re = new RegExp(
    '^#' +
      pattern.replace(/:[^/]+/g, (m) => {
        names.push(m.slice(1));
        return '([^/]+)';
      }) +
      '$'
  );
  routes.push({ re, names, handler });
}

async function render() {
  const hash = location.hash || '#/';
  for (const r of routes) {
    const m = hash.match(r.re);
    if (m) {
      const params = {};
      r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      app.innerHTML = '<p class="loading">加载中…</p>';
      try {
        await r.handler(params);
      } catch (err) {
        app.innerHTML = `<div class="empty"><p>😵 ${esc(err.message)}</p><p><a href="#/">返回首页</a></p></div>`;
      }
      return;
    }
  }
  app.innerHTML = '<div class="empty"><p>页面不存在</p><p><a href="#/">返回首页</a></p></div>';
}

window.addEventListener('hashchange', render);

/* ================= 首页：剧本列表 ================= */

route('/', async () => {
  const scripts = await api('GET', '/api/scripts');
  app.innerHTML = `
    <div class="toolbar">
      <h1 style="margin:0;flex:1">我的剧本</h1>
      <a class="btn" href="#/new">＋ 新建剧本</a>
    </div>
    ${
      scripts.length === 0
        ? '<div class="empty">还没有剧本。<br/>点击右上角「新建剧本」，把分场剧本粘贴进来吧。</div>'
        : scripts
            .map(
              (s) => `
      <a class="card script-item" href="#/script/${s.id}">
        <div>
          <div class="title">${esc(s.title)}</div>
          <div class="meta">第 ${s.version_no} 版 · 更新于 ${esc(s.updated_at)}</div>
        </div>
        <div class="stat-row">
          <span class="badge badge-dim">提示 ${s.cue_total}</span>
          ${
            s.cue_pending > 0
              ? `<span class="badge badge-warn">待确认 ${s.cue_pending}</span>`
              : s.cue_total > 0
                ? '<span class="badge badge-ok">全部就位</span>'
                : ''
          }
        </div>
      </a>`
            )
            .join('')
    }`;
});

/* ================= 新建剧本 ================= */

route('/new', async () => {
  app.innerHTML = `
    <h1>新建剧本</h1>
    <div class="card">
      <label for="f-title">剧本标题 *</label>
      <input id="f-title" type="text" placeholder="例如：《雨夜候车室》" />
      <label for="f-note">版本备注（可选）</label>
      <input id="f-note" type="text" placeholder="例如：初版 / 第三次联排版" style="min-height:auto" />
      <label for="f-content">分场剧本正文 *（按行粘贴；空行会被忽略，场景标题会自动高亮）</label>
      <textarea id="f-content" placeholder="第一场 雨夜&#10;林夏：（推门）有人吗？&#10;雷声从远处滚过。&#10;周野：灯，把灯打开。"></textarea>
      <div class="toolbar" style="margin-bottom:0">
        <button id="f-submit">创建并进入排戏单</button>
        <a class="btn ghost" href="#/">取消</a>
      </div>
      <div id="f-err"></div>
    </div>`;

  document.getElementById('f-submit').addEventListener('click', async () => {
    const errEl = document.getElementById('f-err');
    errEl.innerHTML = '';
    try {
      const created = await api('POST', '/api/scripts', {
        title: document.getElementById('f-title').value,
        note: document.getElementById('f-note').value,
        content: document.getElementById('f-content').value,
      });
      location.hash = `#/script/${created.id}`;
    } catch (err) {
      errEl.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
    }
  });
});

/* ================= 剧本编辑页（最新版本） ================= */

// 当前剧本数据缓存（行内表单状态）
let editor = null;

const SCENE_RE = /^(第[0-9一二三四五六七八九十百零]+[场幕]|场景\s*[0-9一二三四五六七八九十]*|幕间|序场|尾声|楔子)/;

route('/script/:id', async (params) => {
  editor = { id: Number(params.id), form: null, editMode: false, editContent: '' };
  await loadAndRenderEditor();
});

async function loadAndRenderEditor(keepScroll) {
  const scrollY = window.scrollY;
  const data = await api('GET', `/api/scripts/${editor.id}`);
  editor.data = data;
  renderEditor();
  if (keepScroll) window.scrollTo(0, scrollY);
}

function cuesByLine(data) {
  const map = new Map();
  for (const c of data.cues) {
    if (c.status === 'bound' && c.lineIndex != null) {
      if (!map.has(c.lineIndex)) map.set(c.lineIndex, []);
      map.get(c.lineIndex).push(c);
    }
  }
  return map;
}

function renderEditor() {
  const data = editor.data;
  const pending = data.cues.filter((c) => c.status === 'pending');
  const bound = data.cues.length - pending.length;
  const lineMap = cuesByLine(data);

  app.innerHTML = `
    <div class="toolbar">
      <a class="btn ghost sm" href="#/">← 剧本列表</a>
      <h1 style="margin:0;flex:1">${esc(data.title)}</h1>
      <a class="btn ghost sm" href="#/script/${data.id}/history">历史版本</a>
      <button id="btn-edit-mode" class="sm">${editor.editMode ? '收起编辑' : '✎ 编辑剧本 / 存新版'}</button>
    </div>

    <div class="card" style="padding:12px 18px">
      <div class="stat-row">
        <span class="badge badge-dim">当前第 ${data.latestVersion.versionNo} 版${
          data.latestVersion.note ? ' · ' + esc(data.latestVersion.note) : ''
        }</span>
        <span class="badge badge-dim">共 ${data.lines.length} 行台词</span>
        <span class="badge badge-dim">提示 ${data.cues.length} 条</span>
        <span class="badge badge-ok">已就位 ${bound}</span>
        ${pending.length > 0 ? `<span class="badge badge-warn">待确认 ${pending.length}</span>` : ''}
      </div>
    </div>

    ${editor.editMode ? renderEditPanel() : ''}
    ${pending.length > 0 ? renderPendingPanel(pending) : ''}

    <div class="script-lines">
      ${
        data.lines.length === 0
          ? '<div class="empty">当前版本没有台词行</div>'
          : data.lines
              .map((line, i) => renderLineRow(i, line, lineMap.get(i) || []))
              .join('')
      }
    </div>`;

  bindEditorEvents();
}

function renderEditPanel() {
  const d = editor;
  return `
  <div class="card" id="edit-panel">
    <h2 style="margin-top:0">保存新版本</h2>
    <p class="muted">保存后，系统会按“提示所在台词 + 上下相邻行”在新文本中重新定位全部提示。
      找不到唯一句子时，提示会进入下方「待确认」，<b>不会被悄悄挂到其他台词上</b>。</p>
    <label for="e-title">剧本标题</label>
    <input id="e-title" type="text" value="${esc(d.data.title)}" />
    <label for="e-note">版本备注（可选）</label>
    <input id="e-note" type="text" placeholder="例如：加了第三场、删了两句重复台词" style="min-height:auto" />
    <label for="e-content">剧本正文（已填入当前版本全文，可直接修改）</label>
    <textarea id="e-content" style="min-height:340px">${esc(d.editContent)}</textarea>
    <div class="toolbar" style="margin-bottom:0">
      <button id="btn-save-version">保存为第 ${d.data.latestVersion.versionNo + 1} 版并重新定位提示</button>
      <button id="btn-cancel-edit" class="ghost">取消</button>
    </div>
    <div id="e-err"></div>
  </div>`;
}

function candidatePercent(c) {
  const pct = Math.round((c.score || 0) * 100);
  return c.score >= 0.99 ? '台词一致' : `相似 ${pct}%`;
}

function renderPendingPanel(pending) {
  const lines = editor.data.lines;
  return `
  <div class="pending-panel">
    <h2 style="margin-top:0">⚠️ 待人工确认的提示（${pending.length}）</h2>
    <p class="muted" style="margin-top:0">这些提示在最新版本中无法唯一定位，请确认它们应该挂在哪句台词上：</p>
    ${pending
      .map((c) => {
        const opts = lines
          .map(
            (l, i) =>
              `<option value="${i}">[${i + 1}] ${esc(l.length > 40 ? l.slice(0, 40) + '…' : l)}</option>`
          )
          .join('');
        return `
        <div class="pending-item" data-cue="${c.id}">
          <div class="stat-row">
            <span class="badge ${c.type === 'light' ? 'badge-light' : 'badge-sound'}">${
              TYPE_LABEL[c.type]
            }</span>
            <strong>${esc(c.label)}</strong>
          </div>
          <div class="reason">原因：${esc(c.pendingReason || '无法定位')}</div>
          <div class="anchor">原锚点台词：${esc(c.anchor.text)}
            ${c.anchor.prev ? `<br/>上一行：${esc(c.anchor.prev)}` : ''}
            ${c.anchor.next ? `<br/>下一行：${esc(c.anchor.next)}` : ''}
          </div>
          ${
            c.candidates.length > 0
              ? `<div class="muted">系统找到的候选行：</div>
                 <div class="candidate-list">
                   ${c.candidates
                     .map(
                       (cd) => `
                     <div class="candidate">
                       <span class="cand-text" title="${esc(cd.text)}">[${
                         cd.lineIndex + 1
                       }] ${esc(cd.text)}</span>
                       <span class="cand-meta">${candidatePercent(cd)}</span>
                       <button class="btn sm" data-act="rebind-candidate" data-cue="${
                         c.id
                       }" data-line="${cd.lineIndex}">挂到此处</button>
                     </div>`
                     )
                     .join('')}
                 </div>`
              : '<div class="muted">没有找到相近的台词行。</div>'
          }
          <div class="manual-pick">
            <select data-role="manual-line" aria-label="选择台词行">${opts}</select>
            <button class="btn ghost sm" data-act="rebind-manual" data-cue="${c.id}">绑定到所选行</button>
          </div>
          <div class="toolbar" style="margin:6px 0 0">
            <button class="btn danger sm" data-act="delete-cue" data-cue="${c.id}">删除此提示</button>
          </div>
        </div>`;
      })
      .join('')}
  </div>`;
}

function renderLineRow(i, line, cues) {
  const isScene = SCENE_RE.test(line);
  const f = editor.form;
  let formHtml = '';
  if (f && f.kind === 'add' && f.lineIndex === i) {
    formHtml = renderCueForm({ kind: 'add', lineIndex: i, type: f.type || 'light' });
  }

  return `
  <div class="line-row" id="line-${i}">
    <div class="line-idx">${i + 1}</div>
    <div class="line-body">
      <div class="line-text ${isScene ? 'scene-head' : ''}">${esc(line)}</div>
      ${
        cues.length > 0
          ? `<div class="cues-on-line">
               ${cues.map(renderCueChip).join('')}
             </div>`
          : ''
      }
      ${formHtml}
      ${
        !formHtml
          ? `<button class="icon-btn add-cue-btn" data-act="open-add" data-line="${i}"
               title="在这句台词旁添加灯光/音效提示">＋ 提示</button>`
          : ''
      }
    </div>
  </div>`;
}

function renderCueChip(c) {
  const f = editor.form;
  if (f && f.kind === 'edit' && f.cueId === c.id) {
    return `<div class="inline-form">${renderCueForm({
      kind: 'edit',
      cue: c,
      lineIndex: c.lineIndex,
      type: f.type || c.type,
    })}</div>`;
  }
  return `
  <div class="cue-chip ${c.type}">
    <span class="badge ${c.type === 'light' ? 'badge-light' : 'badge-sound'}">${
      TYPE_LABEL[c.type]
    }</span>
    <span class="cue-label">${esc(c.label)}</span>
    ${c.autoMatched ? '<span class="auto-tag" title="保存新版本时由系统依据上下文自动重新定位">自动重定位</span>' : ''}
    <span class="cue-actions">
      <button class="icon-btn" data-act="open-edit" data-cue="${c.id}" title="编辑">✎</button>
      <button class="icon-btn" data-act="delete-cue" data-cue="${c.id}" title="删除">🗑</button>
    </span>
  </div>`;
}

function renderCueForm({ kind, cue, lineIndex, type }) {
  return `
    <div class="seg">
      <button data-act="pick-type" data-type="light" class="${type === 'light' ? 'on' : ''}">💡 灯光</button>
      <button data-act="pick-type" data-type="sound" class="${type === 'sound' ? 'on' : ''}">🔊 音效</button>
    </div>
    <input type="text" data-role="cue-label" placeholder="提示内容，如：暖黄顶光渐亮 / 雨声起"
      value="${cue ? esc(cue.label) : ''}" />
    <div class="actions">
      <button class="btn sm" data-act="${kind === 'add' ? 'save-add' : 'save-edit'}"
        data-line="${lineIndex}" ${cue ? `data-cue="${cue.id}"` : ''}>保存</button>
      <button class="btn ghost sm" data-act="cancel-form">取消</button>
    </div>`;
}

/* ================= 编辑页事件（全局只绑定一次） ================= */

// 离开编辑路由时，click 处理器内通过 editor.data 判断是否处于编辑页
app.addEventListener('click', (ev) => {
  if (!editor || !editor.data) return;
  if (!(location.hash === `#/script/${editor.id}`)) return;
  editorClickHandler(ev);
});

function bindEditorEvents() {
  // 面板内的专属控件（按钮随每次渲染重建，直接绑定）
  if (editor.editMode) {
    document.getElementById('btn-edit-mode').addEventListener('click', async () => {
      editor.editMode = false;
      renderEditor();
    });
    document.getElementById('btn-cancel-edit').addEventListener('click', () => {
      editor.editMode = false;
      renderEditor();
    });
    document.getElementById('btn-save-version').addEventListener('click', async () => {
      const btn = document.getElementById('btn-save-version');
      const errEl = document.getElementById('e-err');
      errEl.innerHTML = '';
      btn.disabled = true;
      try {
        const payload = await api('PUT', `/api/scripts/${editor.id}`, {
          title: document.getElementById('e-title').value,
          note: document.getElementById('e-note').value,
          content: document.getElementById('e-content').value,
        });
        editor.data = payload;
        editor.editMode = false;
        editor.form = null;
        renderEditor();
        const pendingN = payload.cues.filter((c) => c.status === 'pending').length;
        toast(
          pendingN > 0
            ? `已保存第 ${payload.relocated.versionNo} 版，${pendingN} 条提示待人工确认`
            : `已保存第 ${payload.relocated.versionNo} 版，全部提示重新定位成功`
        );
        if (pendingN > 0) {
          document.querySelector('.pending-panel')?.scrollIntoView({ behavior: 'smooth' });
        }
      } catch (err) {
        errEl.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
      } finally {
        btn.disabled = false;
      }
    });
  } else {
    document.getElementById('btn-edit-mode').addEventListener('click', async () => {
      // 进入编辑模式时取当前版本原始文本
      const v = editor.data.latestVersion;
      const detail = await api(
        'GET',
        `/api/scripts/${editor.id}/versions/${v.id}`
      );
      editor.editContent = detail.content;
      editor.editMode = true;
      renderEditor();
      document.getElementById('edit-panel').scrollIntoView({ behavior: 'smooth' });
    });
  }
}

async function editorClickHandler(ev) {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const data = editor.data;

  try {
    switch (act) {
      case 'open-add':
        editor.form = { kind: 'add', lineIndex: Number(btn.dataset.line), type: 'light' };
        renderEditor();
        focusCueLabel();
        break;

      case 'open-edit': {
        const cue = data.cues.find((c) => c.id === Number(btn.dataset.cue));
        if (cue.status !== 'bound') {
          toast('待确认提示请先在上方完成绑定', true);
          return;
        }
        editor.form = { kind: 'edit', cueId: cue.id, type: cue.type };
        renderEditor();
        focusCueLabel();
        break;
      }

      case 'cancel-form':
        editor.form = null;
        renderEditor();
        break;

      case 'pick-type':
        if (editor.form) {
          editor.form.type = btn.dataset.type;
          renderEditor();
          focusCueLabel();
        }
        break;

      case 'save-add':
      case 'save-edit': {
        const labelEl = app.querySelector('[data-role="cue-label"]');
        const label = labelEl.value.trim();
        if (!label) {
          toast('请填写提示内容', true);
          labelEl.focus();
          return;
        }
        const type = editor.form.type;
        if (act === 'save-add') {
          await api('POST', `/api/scripts/${editor.id}/cues`, {
            type,
            label,
            lineIndex: Number(btn.dataset.line),
          });
          toast('提示已添加');
        } else {
          await api('PUT', `/api/scripts/${editor.id}/cues/${btn.dataset.cue}`, {
            type,
            label,
          });
          toast('提示已保存');
        }
        editor.form = null;
        await loadAndRenderEditor(true);
        break;
      }

      case 'delete-cue': {
        const cueId = Number(btn.dataset.cue);
        const cue = data.cues.find((c) => c.id === cueId);
        if (!confirm(`确定删除提示「${cue.label}」吗？`)) return;
        await api('DELETE', `/api/scripts/${editor.id}/cues/${cueId}`);
        editor.form = null;
        await loadAndRenderEditor(true);
        toast('提示已删除');
        break;
      }

      case 'rebind-candidate': {
        await api(
          'POST',
          `/api/scripts/${editor.id}/cues/${btn.dataset.cue}/rebind`,
          { lineIndex: Number(btn.dataset.line) }
        );
        await loadAndRenderEditor(true);
        toast('已绑定，锚点已更新');
        break;
      }

      case 'rebind-manual': {
        const item = btn.closest('.pending-item');
        const sel = item.querySelector('[data-role="manual-line"]');
        await api(
          'POST',
          `/api/scripts/${editor.id}/cues/${btn.dataset.cue}/rebind`,
          { lineIndex: Number(sel.value) }
        );
        await loadAndRenderEditor(true);
        toast('已绑定到所选台词');
        break;
      }
    }
  } catch (err) {
    toast(err.message, true);
  }
}

function focusCueLabel() {
  const el = app.querySelector('[data-role="cue-label"]');
  if (el) {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }
}

/* ================= 历史版本 ================= */

route('/script/:id/history', async (params) => {
  const id = Number(params.id);
  const [script, versions] = await Promise.all([
    api('GET', `/api/scripts/${id}`),
    api('GET', `/api/scripts/${id}/versions`),
  ]);
  app.innerHTML = `
    <div class="toolbar">
      <a class="btn ghost sm" href="#/script/${id}">← 返回排戏单</a>
      <h1 style="margin:0;flex:1">${esc(script.title)} · 历史版本</h1>
    </div>
    <div class="card" style="padding:6px 8px">
      <table>
        <thead><tr><th>版本</th><th>备注</th><th>行数规模</th><th>保存时间</th><th></th></tr></thead>
        <tbody>
          ${versions
            .map(
              (v) => `
            <tr>
              <td>第 ${v.version_no} 版${
                v.id === script.latestVersion.id ? ' <span class="badge badge-ok">当前</span>' : ''
              }</td>
              <td>${esc(v.note || '—')}</td>
              <td class="muted">${v.content_length} 字符</td>
              <td class="muted">${esc(v.created_at)}</td>
              <td><a class="btn ghost sm" href="#/script/${id}/versions/${v.id}">查看</a></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
});

route('/script/:id/versions/:vid', async (params) => {
  const id = Number(params.id);
  const vid = Number(params.vid);
  const [script, version] = await Promise.all([
    api('GET', `/api/scripts/${id}`),
    api('GET', `/api/scripts/${id}/versions/${vid}`),
  ]);
  const isLatest = script.latestVersion.id === version.id;
  app.innerHTML = `
    <div class="toolbar">
      <a class="btn ghost sm" href="#/script/${id}/history">← 历史版本</a>
      <h1 style="margin:0;flex:1">${esc(script.title)} · 第 ${version.versionNo} 版</h1>
      ${
        isLatest
          ? `<a class="btn sm" href="#/script/${id}">回到当前排戏单</a>`
          : `<a class="btn ghost sm" href="#/script/${id}">前往最新版排戏单</a>`
      }
    </div>
    <div class="card" style="padding:12px 18px">
      <div class="stat-row">
        <span class="badge badge-dim">${esc(version.note || '无备注')}</span>
        <span class="badge badge-dim">保存于 ${esc(version.createdAt)}</span>
        ${!isLatest ? '<span class="badge badge-warn">历史只读版本，提示绑定以最新版为准</span>' : ''}
      </div>
    </div>
    <div class="readonly-box">${esc(version.content)}</div>`;
});

/* ================= 启动 ================= */

if (!location.hash) location.hash = '#/';
render();
