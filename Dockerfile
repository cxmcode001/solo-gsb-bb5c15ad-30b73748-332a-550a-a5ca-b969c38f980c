FROM node:20-alpine

# better-sqlite3 为原生模块，Alpine 下需要编译工具链；
# --virtual 形式安装、构建后清理，镜像里不残留编译器
RUN apk add --no-cache --virtual .build-deps \
      python3 make g++ \
    && apk add --no-cache tini

WORKDIR /app

# 先拷依赖清单，利用 Docker 层缓存安装依赖
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# 拷贝应用代码
COPY src ./src
COPY db ./db
COPY public ./public
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh \
    && mkdir -p /app/data \
    && apk del .build-deps

# SQLite 数据库文件持久化到该卷
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/app.db

EXPOSE 3000

# 入口脚本：先幂等初始化数据库，再启动服务
ENTRYPOINT ["/sbin/tini", "--", "./docker-entrypoint.sh"]
