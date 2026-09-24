'use strict';

const { openDb } = require('./db');
const { parseLines, contextOf, normalize, relocateCue } = require('./lines');

const db = openDb();

// ---------- 通用查询 ----------

function listScripts() {
  return db
    .prepare(
      `SELECT s.id, s.title, s.created_at, s.updated_at,
              COALESCE(v.version_no, 0) AS version_no,
              (SELECT COUNT(*) FROM cues c WHERE c.script_id = s.id) AS cue_total,
              (SELECT COUNT(*) FROM cues c WHERE c.script_id = s.id AND c.status = 'pending') AS cue_pending
       FROM scripts s
       LEFT JOIN versions v ON v.id = (
         SELECT id FROM versions WHERE script_id = s.id ORDER BY version_no DESC LIMIT 1
       )
       ORDER BY s.updated_at DESC`
    )
    .all();
}

function getScript(scriptId) {
  return db.prepare('SELECT * FROM scripts WHERE id = ?').get(scriptId);
}

function getLatestVersion(scriptId) {
  return db
    .prepare('SELECT * FROM versions WHERE script_id = ? ORDER BY version_no DESC LIMIT 1')
    .get(scriptId);
}

function listVersions(scriptId) {
  return db
    .prepare(
      'SELECT id, version_no, note, created_at, length(content) AS content_length FROM versions WHERE script_id = ? ORDER BY version_no DESC'
    )
    .all(scriptId);
}

function getVersion(scriptId, versionId) {
  return db
    .prepare('SELECT * FROM versions WHERE script_id = ? AND id = ?')
    .get(scriptId, versionId);
}

function listCues(scriptId) {
  return db
    .prepare('SELECT * FROM cues WHERE script_id = ? ORDER BY id')
    .all(scriptId);
}

// ---------- 序列化 ----------

function serializeCue(cue, lines) {
  let candidates = [];
  if (cue.candidates_json) {
    try {
      candidates = JSON.parse(cue.candidates_json);
    } catch {
      candidates = [];
    }
  }
  const lineText =
    cue.status === 'bound' && cue.line_index != null && lines && cue.line_index < lines.length
      ? lines[cue.line_index]
      : null;
  return {
    id: cue.id,
    scriptId: cue.script_id,
    type: cue.type,
    label: cue.label,
    status: cue.status,
    pendingReason: cue.pending_reason,
    autoMatched: !!cue.auto_matched,
    matchType: cue.match_type,
    currentVersionId: cue.current_version_id,
    lineIndex: cue.line_index,
    lineText,
    candidates,
    anchor: {
      text: cue.anchor_text,
      prev: cue.anchor_prev,
      next: cue.anchor_next,
    },
    createdAt: cue.created_at,
    updatedAt: cue.updated_at,
  };
}

function buildScriptPayload(scriptId) {
  const script = getScript(scriptId);
  if (!script) return null;
  const latest = getLatestVersion(scriptId);
  const lines = latest ? parseLines(latest.content) : [];
  const cues = listCues(scriptId).map((c) => serializeCue(c, lines));
  return {
    id: script.id,
    title: script.title,
    createdAt: script.created_at,
    updatedAt: script.updated_at,
    latestVersion: latest
      ? {
          id: latest.id,
          versionNo: latest.version_no,
          note: latest.note,
          createdAt: latest.created_at,
        }
      : null,
    lines,
    cues,
  };
}

// ---------- 写入 ----------

const insertScript = db.prepare(
  'INSERT INTO scripts (title) VALUES (?)'
);
const insertVersion = db.prepare(
  'INSERT INTO versions (script_id, version_no, content, note) VALUES (?, ?, ?, ?)'
);
const touchScript = db.prepare(
  "UPDATE scripts SET title = COALESCE(?, title), updated_at = datetime('now') WHERE id = ?"
);

function createScript(title, content, note) {
  const tx = db.transaction(() => {
    const scriptInfo = insertScript.run(title.trim());
    const scriptId = scriptInfo.lastInsertRowid;
    insertVersion.run(scriptId, 1, content, note || null);
    touchScript.run(null, scriptId);
    return scriptId;
  });
  return tx();
}

// 保存新版本 + 批量重新定位提示
const insertCue = db.prepare(
  `INSERT INTO cues (script_id, type, label,
      current_version_id, line_index, status, pending_reason, candidates_json,
      anchor_text, anchor_prev, anchor_next, auto_matched, match_type)
   VALUES (@scriptId, @type, @label,
      @currentVersionId, @lineIndex, @status, @pendingReason, @candidatesJson,
      @anchorText, @anchorPrev, @anchorNext, @autoMatched, @matchType)`
);

const relocateCueStmt = db.prepare(
  `UPDATE cues SET
      current_version_id = @currentVersionId,
      line_index         = @lineIndex,
      status             = @status,
      pending_reason     = @pendingReason,
      candidates_json    = @candidatesJson,
      anchor_text        = @anchorText,
      anchor_prev        = @anchorPrev,
      anchor_next        = @anchorNext,
      auto_matched       = @autoMatched,
      match_type         = @matchType,
      updated_at         = datetime('now')
   WHERE id = @id AND script_id = @scriptId`
);

function addCue(scriptId, versionId, lines, lineIndex, type, label) {
  const ctx = contextOf(lines, lineIndex);
  const info = insertCue.run({
    scriptId,
    type,
    label: label.trim(),
    currentVersionId: versionId,
    lineIndex,
    status: 'bound',
    pendingReason: null,
    candidatesJson: null,
    anchorText: ctx.text,
    anchorPrev: ctx.prev,
    anchorNext: ctx.next,
    autoMatched: 0,
    matchType: 'manual',
  });
  touchScript.run(null, scriptId);
  return info.lastInsertRowid;
}

function saveNewVersion(scriptId, content, note) {
  const script = getScript(scriptId);
  if (!script) {
    const err = new Error('剧本不存在');
    err.status = 404;
    throw err;
  }

  const tx = db.transaction(() => {
    const prev = getLatestVersion(scriptId);
    const nextNo = (prev ? prev.version_no : 0) + 1;
    const verInfo = insertVersion.run(scriptId, nextNo, content, note || null);
    const newVersionId = verInfo.lastInsertRowid;
    const newLines = parseLines(content);

    for (const cue of listCues(scriptId)) {
      const result = relocateCue(
        { text: cue.anchor_text, prev: cue.anchor_prev, next: cue.anchor_next },
        newLines
      );

      if (result.status === 'bound') {
        const ctx = contextOf(newLines, result.lineIndex);
        relocateCueStmt.run({
          id: cue.id,
          scriptId,
          currentVersionId: newVersionId,
          lineIndex: result.lineIndex,
          status: 'bound',
          pendingReason: null,
          candidatesJson: null,
          // 唯一命中才推进锚点；上下文消歧的命中也同步锚点（人工在页面上随时可纠正）
          anchorText: ctx.text,
          anchorPrev: ctx.prev,
          anchorNext: ctx.next,
          autoMatched: result.autoMatched ? 1 : 0,
          matchType: result.matchType,
        });
      } else {
        // 待确认：保留原锚点不动（那是用户最近确认的事实），绝不静默改写或挂到别句
        relocateCueStmt.run({
          id: cue.id,
          scriptId,
          currentVersionId: newVersionId,
          lineIndex: null,
          status: 'pending',
          pendingReason: result.reason,
          candidatesJson: JSON.stringify(result.candidates),
          anchorText: cue.anchor_text,
          anchorPrev: cue.anchor_prev,
          anchorNext: cue.anchor_next,
          autoMatched: 0,
          matchType: null,
        });
      }
    }

    touchScript.run(null, scriptId);
    return { versionId: newVersionId, versionNo: nextNo };
  });

  return tx();
}

function updateCue(cueId, scriptId, fields) {
  const cue = db
    .prepare('SELECT * FROM cues WHERE id = ? AND script_id = ?')
    .get(cueId, scriptId);
  if (!cue) {
    const err = new Error('提示不存在');
    err.status = 404;
    throw err;
  }
  const type = fields.type || cue.type;
  if (fields.type && fields.type !== 'light' && fields.type !== 'sound') {
    const err = new Error("提示类型必须是 light（灯光）或 sound（音效）");
    err.status = 400;
    throw err;
  }
  const label = fields.label != null ? String(fields.label).trim() : cue.label;
  if (!label) {
    const err = new Error('提示内容不能为空');
    err.status = 400;
    throw err;
  }
  db.prepare(
    `UPDATE cues SET type = ?, label = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(type, label, cueId);
  touchScript.run(null, scriptId);
}

const deleteCueStmt = db.prepare('DELETE FROM cues WHERE id = ? AND script_id = ?');
function deleteCue(cueId, scriptId) {
  const info = deleteCueStmt.run(cueId, scriptId);
  if (info.changes === 0) {
    const err = new Error('提示不存在');
    err.status = 404;
    throw err;
  }
  touchScript.run(null, scriptId);
}

/** 人工重新绑定：以选定行建立新的已确认锚点 */
function rebindCue(cueId, scriptId, versionId, lines, lineIndex) {
  const cue = db
    .prepare('SELECT * FROM cues WHERE id = ? AND script_id = ?')
    .get(cueId, scriptId);
  if (!cue) {
    const err = new Error('提示不存在');
    err.status = 404;
    throw err;
  }
  if (lineIndex == null || lineIndex < 0 || lineIndex >= lines.length) {
    const err = new Error('目标行不存在');
    err.status = 400;
    throw err;
  }
  const ctx = contextOf(lines, lineIndex);
  db.prepare(
    `UPDATE cues SET
        current_version_id = ?, line_index = ?, status = 'bound',
        pending_reason = NULL, candidates_json = NULL,
        anchor_text = ?, anchor_prev = ?, anchor_next = ?,
        auto_matched = 0, match_type = 'manual_rebind',
        updated_at = datetime('now')
     WHERE id = ?`
  ).run(versionId, lineIndex, ctx.text, ctx.prev, ctx.next, cueId);
  touchScript.run(null, scriptId);
}

module.exports = {
  db,
  listScripts,
  getScript,
  getLatestVersion,
  listVersions,
  getVersion,
  listCues,
  serializeCue,
  buildScriptPayload,
  createScript,
  saveNewVersion,
  addCue,
  updateCue,
  deleteCue,
  rebindCue,
  // 便于测试
  _parseLines: parseLines,
  _normalize: normalize,
};
