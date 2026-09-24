'use strict';

const path = require('path');
const express = require('express');
const store = require('./storage');
const { parseLines } = require('./lines');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 工具 ----------

function validateCueType(type) {
  if (type !== 'light' && type !== 'sound') {
    const err = new Error("提示类型必须是 light（灯光）或 sound（音效）");
    err.status = 400;
    throw err;
  }
}

function requireLatestVersion(scriptId) {
  const latest = store.getLatestVersion(scriptId);
  if (!latest) {
    const err = new Error('剧本还没有任何版本');
    err.status = 400;
    throw err;
  }
  return latest;
}

// ---------- 剧本 / 版本 ----------

// 剧本列表
app.get('/api/scripts', (req, res) => {
  res.json(store.listScripts());
});

// 剧本详情（含最新版本行与全部提示）
app.get('/api/scripts/:id', (req, res) => {
  const payload = store.buildScriptPayload(Number(req.params.id));
  if (!payload) return res.status(404).json({ error: '剧本不存在' });
  res.json(payload);
});

// 版本列表
app.get('/api/scripts/:id/versions', (req, res) => {
  const scriptId = Number(req.params.id);
  if (!store.getScript(scriptId)) return res.status(404).json({ error: '剧本不存在' });
  res.json(store.listVersions(scriptId));
});

// 单个版本（只读查看历史版本）
app.get('/api/scripts/:id/versions/:vid', (req, res) => {
  const scriptId = Number(req.params.id);
  const version = store.getVersion(scriptId, Number(req.params.vid));
  if (!version) return res.status(404).json({ error: '版本不存在' });
  res.json({
    id: version.id,
    scriptId,
    versionNo: version.version_no,
    note: version.note,
    content: version.content,
    lines: parseLines(version.content),
    createdAt: version.created_at,
  });
});

// 新建剧本（首个版本）
app.post('/api/scripts', (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const content = typeof req.body.content === 'string' ? req.body.content : '';
  if (!title) return res.status(400).json({ error: '请填写剧本标题' });
  if (!content.trim()) return res.status(400).json({ error: '请粘贴剧本正文' });

  const id = store.createScript(title, content, req.body.note);
  res.status(201).json(store.buildScriptPayload(id));
});

// 保存新版本（可同时改标题），触发全部提示重新定位
app.put('/api/scripts/:id', (req, res) => {
  const scriptId = Number(req.params.id);
  if (!store.getScript(scriptId)) return res.status(404).json({ error: '剧本不存在' });

  const content = typeof req.body.content === 'string' ? req.body.content : null;
  if (content === null || !content.trim()) {
    return res.status(400).json({ error: '新版本正文不能为空' });
  }
  if (typeof req.body.title === 'string' && req.body.title.trim()) {
    store.db
      .prepare('UPDATE scripts SET title = ? WHERE id = ?')
      .run(req.body.title.trim(), scriptId);
  }

  const result = store.saveNewVersion(scriptId, content, req.body.note);
  const payload = store.buildScriptPayload(scriptId);
  payload.relocated = result;
  res.json(payload);
});

// ---------- 提示（仅针对当前最新版本）----------

// 在指定台词旁添加提示
app.post('/api/scripts/:id/cues', (req, res) => {
  const scriptId = Number(req.params.id);
  if (!store.getScript(scriptId)) return res.status(404).json({ error: '剧本不存在' });
  const latest = requireLatestVersion(scriptId);
  const lines = parseLines(latest.content);

  validateCueType(req.body.type);
  const label = typeof req.body.label === 'string' ? req.body.label.trim() : '';
  if (!label) return res.status(400).json({ error: '请填写提示内容' });

  const lineIndex = Number(req.body.lineIndex);
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) {
    return res.status(400).json({ error: '目标台词行不存在（可能剧本已更新，请刷新页面）' });
  }

  const cueId = store.addCue(scriptId, latest.id, lines, lineIndex, req.body.type, label);
  const cue = store.db.prepare('SELECT * FROM cues WHERE id = ?').get(cueId);
  res.status(201).json(store.serializeCue(cue, lines));
});

// 编辑提示内容/类型
app.put('/api/scripts/:id/cues/:cueId', (req, res) => {
  const scriptId = Number(req.params.id);
  if (!store.getScript(scriptId)) return res.status(404).json({ error: '剧本不存在' });
  if (req.body.type) validateCueType(req.body.type);
  store.updateCue(Number(req.params.cueId), scriptId, req.body);
  res.json(store.buildScriptPayload(scriptId));
});

// 删除提示
app.delete('/api/scripts/:id/cues/:cueId', (req, res) => {
  const scriptId = Number(req.params.id);
  store.deleteCue(Number(req.params.cueId), scriptId);
  res.json({ ok: true });
});

// 人工重新绑定到某句台词
app.post('/api/scripts/:id/cues/:cueId/rebind', (req, res) => {
  const scriptId = Number(req.params.id);
  if (!store.getScript(scriptId)) return res.status(404).json({ error: '剧本不存在' });
  const latest = requireLatestVersion(scriptId);
  const lines = parseLines(latest.content);

  const lineIndex = Number(req.body.lineIndex);
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) {
    return res.status(400).json({ error: '目标台词行不存在' });
  }

  store.rebindCue(Number(req.params.cueId), scriptId, latest.id, lines, lineIndex);
  res.json(store.buildScriptPayload(scriptId));
});

// ---------- 错误处理 ----------

app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // better-sqlite3 约束错误等
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`台词提示单已启动：http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

module.exports = app;
