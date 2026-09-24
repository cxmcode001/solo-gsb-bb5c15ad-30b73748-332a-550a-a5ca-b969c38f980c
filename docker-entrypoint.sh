#!/bin/sh
set -e

echo "==> 初始化数据库（幂等）：$DB_PATH"
node db/init-db.js

echo "==> 启动 Web 服务"
exec node src/server.js
