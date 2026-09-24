'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'app.db');
const DB_PATH = process.env.DB_PATH || DEFAULT_DB_PATH;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scripts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id   INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  version_no  INTEGER NOT NULL,
  content     TEXT    NOT NULL,
  note        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (script_id, version_no)
);

-- cues 同时保存两组定位信息：
--   current_* / line_index / status : 提示在“当前最新版本”中的绑定结果
--   anchor_*                        : 最近一次经人工确认（或首次创建、高置信自动命中）的定位锚点，
--                                     保存新版本时依据 anchor_text + anchor_prev/next 在新版中重新定位
CREATE TABLE IF NOT EXISTS cues (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id            INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  type                 TEXT    NOT NULL CHECK (type IN ('light', 'sound')),
  label                TEXT    NOT NULL,

  current_version_id   INTEGER REFERENCES versions(id) ON DELETE SET NULL,
  line_index           INTEGER,
  status               TEXT    NOT NULL DEFAULT 'bound' CHECK (status IN ('bound', 'pending')),
  pending_reason       TEXT,
  candidates_json      TEXT,

  anchor_text          TEXT    NOT NULL,
  anchor_prev          TEXT,
  anchor_next          TEXT,

  auto_matched         INTEGER NOT NULL DEFAULT 0,
  match_type           TEXT,

  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_versions_script ON versions(script_id);
CREATE INDEX IF NOT EXISTS idx_cues_script     ON cues(script_id);
CREATE INDEX IF NOT EXISTS idx_cues_status     ON cues(script_id, status);
`;

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb, DB_PATH, DEFAULT_DB_PATH };
