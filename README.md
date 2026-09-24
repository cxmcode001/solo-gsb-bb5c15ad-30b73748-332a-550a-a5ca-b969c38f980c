# 🎭 台词提示单（Theater Cue Sheet）

供小剧团排练使用的台词提示单 Web 应用。导演/场记把**分场剧本全文**粘贴进来，
在任意一句台词旁边挂上 **灯光（💡）/ 音效（🔊）** 提示；剧本修改后保存新版，
系统会依据「**提示所在台词 + 上下相邻行**」在新文本中自动重新定位全部提示。

当一句台词在新剧本中重复出现、且上下文无法唯一区分，或者原台词已被删除/改写时，
提示会被标记为 **「待确认」** 并列出候选行 —— **绝不会被悄悄挂到另一句台词上**。
排练负责人可在页面上一键绑定候选、或手动指定任意台词行重新绑定并保存。

## 功能

- 📋 新建剧本、粘贴分场文本；按行展示，场景标题（第一幕 / 第二场 / 尾声 等）自动高亮
- 💡🔊 在指定台词旁添加 / 编辑 / 删除灯光或音效提示
- 📝 编辑剧本正文（或仅改标题）后「保存为新版」，自动保留全部历史版本，可只读回看
- 🔄 版本保存时批量重定位提示：
  - 台词唯一出现 → 直接绑定
  - 台词重复出现 → 用上下相邻行相似度消歧；上下文吻合（微调位置）或与次佳差距明显时才自动绑定
  - 上下文仍无法区分，或原句已删除/改写 → 标记 **待确认**，保留原锚点，给出候选行
- ⚠️ 待确认面板：展示原因、原锚点台词及相邻行、系统候选（带相似度）；支持「挂到此处」或从全剧行中手动选择绑定
- 🏷️ 已绑定提示标注「自动重定位」与人工绑定的区别；剧本列表显示待确认数量
- 🗃️ SQLite 单文件存储，数据通过 Docker 卷持久化

## 技术栈

Node.js + Express（后端 REST API）+ 原生 HTML/CSS/JavaScript（无构建步骤）+ SQLite（`better-sqlite3`）。

## 快速开始（推荐：Docker Compose，一条命令）

需要本机已安装 Docker 与 Docker Compose 插件。在本项目目录下执行：

```bash
docker compose up --build -d
```

这一条命令会自动完成：

1. 构建镜像并安装全部依赖（含 `better-sqlite3` 原生模块编译）；
2. 创建并初始化 SQLite 数据库（自动建库建表，幂等可重复执行）；
3. 启动 Web 服务。

然后浏览器访问：

> **http://localhost:3000**

查看日志 / 停止：

```bash
docker compose logs -f
docker compose down          # 停止（数据保留在 cue-data 卷中）
```

### 也可以直接用 Docker

```bash
docker build -t theater-cue-sheet .
docker run -d -p 3000:3000 -v cue-data:/app/data --name cue-sheet theater-cue-sheet
# 访问 http://localhost:3000
```

## 不用 Docker，本机直接运行

要求 Node.js ≥ 18（推荐 20 LTS）。

```bash
npm install        # 安装依赖（better-sqlite3 会在本机编译）
npm run init-db    # 初始化 SQLite 数据库（默认 data/app.db，幂等）
npm start          # 启动服务
```

访问 **http://localhost:3000**。

> 说明：即使不手动执行 `npm run init-db`，服务启动时也会自动建表；
> 该脚本用于显式完成「数据库初始化」并打印结果，便于部署时确认。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Web 服务监听端口（容器内固定 3000） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | Docker：`/app/data/app.db`；本机：`data/app.db` | SQLite 数据库文件路径，所在目录会自动创建 |
| `CUE_PORT` | `3000` | 仅 Compose 使用：宿主机映射端口，例如 `CUE_PORT=8080 docker compose up --build -d` 后访问 http://localhost:8080 |

修改宿主机访问端口示例：

```bash
CUE_PORT=8080 docker compose up --build -d   # 访问 http://localhost:8080
```

## 数据持久化

- Docker Compose 方式：数据库保存在命名卷 `cue-data`（容器内 `/app/data/app.db`），`docker compose down` 不删卷即不丢数据；彻底清除数据可用 `docker compose down -v`。
- 本机运行：数据库为项目下的 `data/app.db`，备份该文件即可备份全部数据。

## 目录结构

```
.
├── Dockerfile               # 多环境兼容的单镜像构建
├── docker-compose.yml       # 一条命令：安装依赖 + 初始化库 + 启动
├── docker-entrypoint.sh     # 容器入口：先 init-db 再启动
├── db/
│   └── init-db.js           # 建库建表脚本（幂等）
├── src/
│   ├── server.js            # Express 入口与 REST API
│   ├── db.js                # SQLite 连接与表结构
│   ├── storage.js           # 数据访问、版本保存与提示重定位事务
│   └── lines.js             # 台词行解析、相似度、锚点重定位算法
├── public/                  # 原生前端（HTML/CSS/JS，hash 路由）
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── package.json
```

## 提示重定位规则（简表）

保存新版本时，每条提示携带一个「锚点」：原台词文本与其上一行、下一行。

| 新版本中的情况 | 处理 |
| --- | --- |
| 锚点台词恰好出现 1 次 | 自动绑定到该行，标记「自动重定位」 |
| 锚点台词出现多次，但上下相邻行能唯一区分（吻合度 ≥ 0.9，或最佳与次佳差 ≥ 0.2） | 自动绑定 |
| 锚点台词出现多次、上下文无法唯一区分 | **待确认**：列出所有重复位置及各自上下文得分 |
| 锚点台词已不存在（删除/改写） | **待确认**：仅列出文本相似度 ≥ 0.6 的行作为候选，绝不自动改挂 |
| 人工绑定 / 新建提示 | 立即以所选行刷新锚点，标记为人工操作 |

## 许可证

MIT
