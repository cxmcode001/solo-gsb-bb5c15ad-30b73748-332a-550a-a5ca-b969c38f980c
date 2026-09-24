'use strict';

/**
 * 数据库初始化脚本：建库、建表（幂等，可重复执行）。
 * 容器启动入口 docker-entrypoint.sh 会先执行本脚本。
 *   npm run init-db
 */

const { openDb, DB_PATH } = require('../src/db');

const db = openDb();
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((row) => row.name);

console.log(`数据库已就绪：${DB_PATH}`);
console.log(`已初始化数据表：${tables.join(', ')}`);
db.close();
