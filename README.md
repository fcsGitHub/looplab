# LoopLab — 自我改进 Agent 框架平台

按《自我改进 Agent 框架设计》（`SELF_IMPROVING_AGENT_DESIGN.md`）实现的真实可运行平台：
真实调用模型（DeepSeek）、持久目标执行、可验证的自动改进（演进循环）、计算型科研流程、
可暂停/恢复、事件驱动且页面简洁。

实现目标与验收见 `IMPLEMENTATION_GOAL.md` 与 `acceptance/acceptance-manifest.json`。

## 架构总览

```
浏览器 (React 工作台, apps/web)
   │  REST /v1 + SSE /v1/events（游标续传、按 event_id 去重）
控制服务 (Fastify, apps/control)  ── 唯一调度权威：租约 + fencing token + 预算 + 发布门
   │  RunSpec（冻结）              │ LLM 网关：预留→真实调用→结算（密钥不出服务）
Worker (workers/agent-worker)   ── 有界 agent 循环 + 工具网关（Python 审计钩子沙箱）
   │
评测 (taskpacks/*/evaluator.py) ── dev/selection 公共套件 + sealed:// 发布套件（独立进程）
```

细节见 `docs/architecture/overview.md` 与 `docs/architecture/threat-model.md`。

## 快速开始

前置：Node ≥ 22、Python 3.11、Docker（跑 PostgreSQL）。

```bash
# 1) 数据库
docker run -d --name looplab-pg -e POSTGRES_USER=looplab -e POSTGRES_PASSWORD=localdev \
  -e POSTGRES_DB=looplab -p 5433:5432 postgres:16-alpine

# 2) 密钥与 worker 令牌（本地、已 gitignore）
#    WORKER_TOKEN 是 worker 平面的共享密钥：设置后所有 /v1/worker/* 与
#    /v1/attempts/* 请求必须携带 x-worker-token 头（服务绑定 0.0.0.0，
#    不设令牌等于向局域网开放模型计费通道）。worker 与控制服务必须一致。
printf 'DEEPSEEK_API_KEY=sk-xxx\nWORKER_TOKEN=%s\n' "$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")" > apps/control/config/.env.local

# 3) 依赖与 TaskPack 套件（含 sealed 发布套件）
npm install
npx tsx scripts/seal-suites.ts

# 4) 启动：控制服务（:8080，同时托管前端构建产物）
npx tsx apps/control/src/index.ts          # http://localhost:8080

# 5) 启动一个 worker（可多个；调度由控制服务统一裁决；令牌与控制服务一致）
WORKER_ID=dev-01 WORKER_TOKEN=$(grep '^WORKER_TOKEN=' apps/control/config/.env.local | cut -d= -f2) \
  npx tsx workers/agent-worker/src/index.ts

# 6) 浏览器打开 http://localhost:8080，注册首个账号（自动成为管理员），发送目标即可
```

开发模式前端（热更新）：`npm run dev --prefix apps/web`（Vite 代理 /v1 → :8080）。

## OptimizerPort 与元演进（第二轮迭代）

`packages/contracts/src/optimizer.ts` 定义后端注册表、纪元授权守卫与切换裁决
（严格 margin，平局=证据不足保留现任，递归深度 1）；`apps/control/src/optimizer.ts`
+ `/v1/goals/:id/optimizer/*`、`/v1/meta/epoch*` 为控制面；反射 LLM 经
计量代理计账（run token 鉴权，模型密钥不出控制进程）。后端 `gepa==0.1.4`
（`optimizers/gepa-backend/`），真实模型 epoch 试炼与裁决：
`docs/evidence/optimizer-epoch-trial/TRIAL-VERDICT.md`。现任 simple-baseline@1
也注册在同一端口上以等协议竞争；任务族可参数化（`TASKPACK=algorithm-search.bin-packing-large`，
大实例族 seed archive 与小族隔离）。图 revise 按 §六.3 只重跑受影响节点及后继、
保留有效前缀（A20）。

## 安全模型（P17 起强制）

- **worker 平面令牌**：控制服务绑定 `0.0.0.0`，fencing token 只隔离 worker
  彼此、不隔离“局域网里的任何人”。设置 `WORKER_TOKEN` 后（见快速开始），
  `/v1/worker/*`、`/v1/attempts/*`、`POST /v1/artifacts` 全部要求
  `x-worker-token`（timing-safe 比较）；未设置时启动日志会大声告警（仅限本机开发）。
- **读隔离**：goal/attempt/session 全部按属主隔离（member 只见自己的，
  404 不暴露存在性；admin 全量可见）；`GET /v1/metrics`、`GET /v1/workers`
  需要会话。
- **登录限流**：`/v1/auth/*` 按 IP+用户名滑动窗口限流，8 次失败锁定 15 分钟。
- **日预算熔断**：`DAILY_BUDGET_USD`（默认 0=关闭）设置后，LLM 网关在 24h
  滚动窗口花费（reserved+settled+unknown）达到上限时拒绝一切调用（402），
  `/v1/metrics` 可见 `last_24h_usd`/`daily_cap_usd`。
- **CORS**：仅白名单 origin（默认 Vite 开发端口）回显凭据头；同源请求无需 CORS。
- **子进程 env 白名单**：评测器与优化器后端子进程只继承 PATH/系统目录等非敏感项
  （`infraEnv`），宿主环境的模型密钥永远不会被转发。
- **运行报告**：`GET /v1/goals/:id/report.md`（会话鉴权，属主/admin）从真实事件账本
  导出 Markdown 报告（任务图、执行与花费、时间线、交付物、结论声明）。

## 测试

```bash
npx vitest run                                  # 单元 + 契约 + 集成（A02–A27；A17 长跑除外）
DEEPSEEK_API_KEY=sk-xxx npx vitest run tests/contract/deepseek-smoke.test.ts  # 真实模型烟测
npx playwright test                             # 真实浏览器端到端（需控制服务+worker 运行中）
npx tsx tests/soak/soak.ts --duration 10m       # 浸泡测试（72h 用 --duration 72h）
npx tsx tests/fault-injection/kill-worker.ts    # 杀 worker 故障注入
npx tsx scripts/demo-optimizer-epoch.ts         # 元演进 epoch 试炼（需 .venv-gepa，真实计费）
```

## 目录

```
apps/control        控制服务（auth/goals/scheduler/events/outbox/budget/evolution/release/research）
apps/web            React 工作台（构建产物由控制服务托管）
packages/contracts  状态机、事件信封、RunSpec、TaskPack、图编译器
packages/policy     工具授权 PolicyGate（纯函数）
packages/llm        DeepSeek 客户端（OpenAI 兼容）
workers/agent-worker  worker 守护进程 + agent 循环 + 能力网关
taskpacks/          三个领域包（harness/algorithm/research）合同与评测器
tests/              unit / contract / integration / e2e / soak / fault-injection
docs/               architecture / decisions / runbooks / evidence
acceptance/         机器可读验收清单（A01–A18）
```
