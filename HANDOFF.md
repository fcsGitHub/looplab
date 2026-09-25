# HANDOFF — 交接状态

更新时间：2026-09-26 02:20（P22 计划端点修复轮）· 分支：`main`

## 本轮新增：P22 — 研究 run 端点三重修复（2026-09-26）

给 `/v1/plans/:id/run` 补测试时发现的连环缺陷（该端点此前零测试覆盖，实际从未可用）：

| # | 缺陷 | 修复 |
|---|---|---|
| V14 | **runner 阻塞整个控制进程**：spawnSync 最长 120s，期间心跳/SSE/编排器全部停摆，租约到期会把运行中 attempt 误判 LOST | 异步 spawn（stdin 传参 + 超时），env 走 infraEnv 白名单 |
| V15 | **计划端点 IDOR**：run/analyze 仅凭 id 可达（无属主校验） | 经 hypothesis→goal 解析属主，非属主 404 |
| V16 | **实验文件损坏**：experiment.py 头部是 JS 风格 `/** */` 注释——Python 无法解析，run 端点一调用就 500（自入库起即坏） | 头注释转 Python docstring，py_compile 通过，测试内真实执行 6 runs |
| + | runtime_ms 小数炸 UPDATE（INTEGER 列）；规划 LLM 无频控 | Math.round；首消息每用户 5 次/10 分钟 + 60s 冷却（429） |

测试 `tests/integration/a31-plan-isolation-throttle.test.ts`（2，含真实 runner 执行）。
全量 **102 passed / 0 failed**；typecheck/build 双绿。

### 活体验证补遗（同轮）

生产实例首跑完整科研链路（假设→冻结→执行→分析）时又暴露一处：`analyze` 对
pg 已解析的 jsonb 列（seeds/protocol）再做 `JSON.parse` → 必抛 SyntaxError 500。
修复为宽容解析（对象直用、字符串才 parse）；上线复验：真实 6 runs 配对分析
产出 `supported_in_scope`（n=3，t=-7.9，记忆化确有成本优势）——科研链路首次
经 HTTP API 全线贯通。

---

更新时间：2026-09-26 01:40（P21 SSE 属主隔离 + 审批/总览 UI 轮）· 分支：`main`

## 本轮新增：P21 — SSE 跨用户事件泄露修复 + 审批与总览 UI（2026-09-26）

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| V13 | **SSE 事件流未按属主隔离**（P17 修复遗漏的流式端点）：任何已认证 member 可经 `/v1/events?after=0` 重放全局账本，含他人目标的工作摘要、修订目标、steer 内容 | `EventStore.after` 增加 owner 作用域：member 只见自己目标的事件 + 无目标系统事件；admin 全量；游标语义不变 | A30 两个测试（重放+实时尾随 × alice/bob/admin 三视角） |
| F | **审批 UI**：审批条从纯文本提示升级为可操作（标题 + 批准/驳回按钮，完成 P20 闭环的用户侧） | /v1/approvals + decision 接入 App.tsx，stream/20s 刷新 | UI 冒烟 0 控制台错误 |
| F | **目标总览侧栏**：「进行中目标」跨项目列出（state/任务数/更新时间），点击跳转会话 | /v1/goals 列表返回 project_id/session_id；侧栏新分区 | 同上 |

官方 playwright e2e（真实浏览器 + 真实模型）：**2 passed**（主路径注册→规划→
图渲染→暂停/恢复→运行记录/证据 8.0s；未认证 SSE 401）。全量 100 passed /
0 failed；typecheck + build 双绿。

---

更新时间：2026-09-26 01:00（P20 诊断→审批→自动修订闭环轮）· 分支：`main`

## 本轮新增：P20 — 目标停滞闭环修复（2026-09-26）

浸泡暴露的真实运营缺口：任务 3× 失败 → 诊断任务 SUCCEEDED 后，目标在 ACTIVE
状态静默停滞（被诊断任务 WAITING、后继被依赖规则挡住），必须有人**恰好注意到**
并手工 revise 才能继续（上轮 palindrome 目标即如此）。

修复：诊断任务 SUCCEEDED 时自动创建 `goal_revise` 审批（复用既有 approvals
人审机制 + approval.requested 事件）；批准 → 插入 ACCEPTED revise 命令 →
orchestrator 既有管线自动重规划（无需新机制，纯接线）。FAILED 的诊断不发起。

测试 `tests/integration/a29-diagnosis-approval.test.ts`（3）+ 生产实例复验：
浸泡停滞目标经 API 批准后真实重规划 → **COMPLETED**（$0.4875 计量，零手工命令）。

全量 98 passed / 0 failed；typecheck/build 双绿。

---

更新时间：2026-09-26 00:20（P19 第二轮审计 + 报告导出轮）· 分支：`main`

## 本轮新增：P19 — 三处缺陷修复 + 两项功能 + token auth 下浸泡复验（2026-09-26）

### 修复的缺陷

| # | 缺陷 | 修复 | 验证 |
|---|---|---|---|
| V10 | **子进程全量继承宿主 env**：evaluator（evalbroker）与优化器后端（optimizer）spawn 用 `...process.env`——一旦操作者以导出方式携带 DEEPSEEK_API_KEY 启动控制服务，密钥即被转发给全部受信子进程，直接违反「模型密钥不出控制进程」不变量（代码注释声称"the ONLY credential"但实现不符） | 新增 `infraEnv()` 白名单（PATH/系统目录/TEMP/PYTHON*），两处 spawn 改走白名单 + 显式 run token；单测以毒化 env（DEEPSEEK_API_KEY/LL_COOKIE_SECRET/WORKER_TOKEN）断言零透传 | `tests/unit/childenv.test.ts` |
| V11 | **artifact 名双重编码**：worker 上传时 `encodeURIComponent(name)`，服务端原样入库，下载头再次编码——含中文/空格的交付物名在下载端被二次百分号编码 | 入库时恰好解码一次（try/catch 容错） | A28 集成测试（`报告 xxx.txt` 往返） |
| V12 | **登录用户名枚举侧信道**：用户不存在时跳过 scrypt 校验，响应时间差异泄露用户名存在性 | 未知用户也执行同代价的 dummy scrypt 校验 | 代码级，行为不变 |

### 新增功能

- **`GET /v1/goals/:id/report.md`**（P19）：从真实账本（tasks/attempts/budget_reservations/events/artifacts/claims）渲染 Markdown 运行报告——任务图、执行与花费、关键事件时间线、交付物清单、结论声明；属主/admin 可导出，UI 运行记录页一键下载。
- **Worker 运行时自报**：claim 载荷携带 `{runtime, version}`，注册表 `runtime` 列显示（如 `pi@2`）；缺失时保留旧值（COALESCE）。

### 真实复验

- 全量测试 **95 passed / 0 failed**（上轮 90 → 95）；typecheck/build 双绿。
- 10 分钟有界浸泡在 token auth + P19 代码上执行（3 并发真实目标、pause/resume 注入、steer 风暴、SSE 重连），结果归档 `docs/evidence/p19-round/`。

---

更新时间：2026-09-25 24:00（P17/P18 安全加固 + 可观测性轮）· 分支：`main`

## 本轮新增：安全审计修复（P17）+ fleet 可观测性（P18）（2026-09-25）

接管项目后的第一轮：全量安全审计 → 修复 9 处真实漏洞/缺陷 → 2 项新功能 →
真实端到端复验。全程无 mock：所有修复在真实控制服务（:8080，WORKER_TOKEN
启用）+ 真实 worker + 真实模型目标上复验。

### 修复的漏洞（按严重度）

| # | 漏洞 | 修复 | 验证 |
|---|---|---|---|
| V1 | **worker 平面零鉴权**：控制服务绑 0.0.0.0，`/v1/worker/*`、`/v1/attempts/*`（含 `/llm` 计费代理与 artifact 上传）无任何传输层鉴权——局域网任意主机可冒充 worker 驱动真实模型花费、伪造 commit；已认证 member 也可读到 attempts 列表里的 worker_id+lease_epoch 后冒充 | `WORKER_TOKEN` 共享密钥：所有 worker 平面路由要求 `x-worker-token`（sha256+timingSafeEqual）；未配置时启动 loud warning；worker 侧 `ControlClient` 自动携带 | A26 测试 3 项 + 生产实例：匿名/错令牌 claim=401，dev-01 带 token 正常认领执行 |
| V2 | **IDOR 读隔离缺失**：goal/attempt/session 全部仅凭 id 可读，任何 member 可读他人目标、任务、事件、证据、会话消息 | `goalScope`/`attemptScope` 助手应用到全部 20+ 读/写路由；member 视角 404（不暴露存在性），admin 全量；会话消息按 owner 过滤；goal 域 artifact 按 goal 归属 | A26 测试（8 类读 × owner/attacker/admin 三视角） |
| V3 | **`GET /v1/metrics` 无鉴权**：花费、目标统计、编排器内部错误对外暴露 | requireAuth | A26 + 生产实例匿名 401 |
| V4 | **登录无限暴力破解**：scrypt 校验无限流 | `RateLimiter`（滑动窗口，IP+用户名，8 败锁 15min，成功清零），register 同闸 | A26（第 9 次起 429，锁定中正确密码也 429）+ 单测 4 项 |
| V5 | **CORS 任意 Origin 反射 + credentials** | 白名单回显（默认仅 Vite dev 端口），同源无需 CORS | 代码审查 + A26 间接 |
| V6 | **500 响应泄露内部错误文本**（SQL/驱动消息） | 500 只回 `err_nonce`，全文进操作日志；4xx 保留受控消息 | 类型级修复，无路由依赖旧行为 |
| V7 | **SSE 连接泄漏**：每个断开的 EventSource 留下一个永续 1s interval；`?after=非数字` 直接 500 | close 时 clearInterval；非法游标回退 head | A26 SSE 测试 |
| V8 | **API key 指纹泄露**：`/v1/settings/model` 返回 key 前 6+后 4 字符 | 改 sha256 指纹 | — |
| V9 | **首用户 admin TOCTOU**：并发注册可双 admin | `pg_advisory_xact_lock` 序列化 count-then-insert | — |

### 新功能（P18）

- **worker 注册表**：`workers` 表（006/007 迁移）；claim 轮询 upsert（`last_seen_at`
  决定 alive，2×租约窗口），实际授予权才计 `claims_total`（007 修正语义，
  `polls_total` 单独计量轮询）；心跳刷新 `last_attempt_id/last_task_title`。
  `GET /v1/workers` + 系统弹窗「Worker 集群」面板。
- **全局日预算熔断**：`DAILY_BUDGET_USD`（默认 0=关）；LLM 网关在预留前检查
  24h 滚动 reserved+settled+unknown，达上限即 402（先于任何网络调用）；
  `/v1/metrics` 新增 `model.last_24h_usd` / `model.daily_cap_usd`。
- **`GET /v1/goals` 列表端点**：属主过滤 + state/q 过滤 + 任务计数（admin 全量）。

### 运维修复

- **根 `tsconfig.build.json` 缺失**（既有问题，HANDOFF 上轮已登记未触碰）：
  本轮落地 `tsc -b` 解决方案构建（5 个 composite 包配置 + 引用图），
  `npm run build`（真实 emit dist/）与 `npm run typecheck`（app 严格 +
  tests/scripts 宽松双配置）**首次可用且全绿**。
- **密钥落盘**：`DEEPSEEK_API_KEY` 此前只存在于启动进程的环境变量中
  （`.env.local` 从未创建——本轮重启时险些丢失）；已恢复并写入
  `apps/control/config/.env.local`（gitignored，连同 WORKER_TOKEN）。
- **A10 安全测试假阳性修复**：「sealed 标签泄漏」断言用裸 2 位数子串匹配
  （`items[0]`），与 `runtime_ms:0.369` 中的 "69" 随机碰撞导致间歇性红。
  改为结构化金丝雀（完整 items 数组 + release 档案 seed 前缀）——泄漏检测
  本身不再依赖会碰撞的子串。

### 真实端到端复验（WORKER_TOKEN 启用下）

goal_c056b3c450694c7e「is_palindrome + 5 用例验证」：planner 真实规划 →
worker（token 认证）t1→t3 SUCCEEDED → Reviewer t4 真实失败 3 次 →
retry-loop 诊断自动派发并 SUCCEEDED → 人工 revise（采纳诊断）→
A20 受影响子图重算（有效前缀保留）→ **COMPLETED**，$0.2968 全额计量。
期间发现并修复 claims_total 语义缺陷（007）。

### 本轮验证汇总

- `npx vitest run`：**90 passed / 2 skipped / 0 failed**（基线 74 → 90）
- `npm run typecheck`：app 严格 + tests/scripts 宽松，0 错误（首次）
- `npm run build`：5 包 emit 成功（首次）
- UI 冒烟（真实浏览器）：0 控制台错误
- 生产实例：匿名 metrics/claim 401；dev-01 注册表 alive=true

---

更新时间：2026-09-25 19:00（UI 全面改造轮）· 分支：`impl/platform`（本地，未推送）

## 本轮新增：UI/UX 全面改造（2026-09-25）

调研基线：`docs/research/rsi-ui-research.md`（RSI 论文图谱 + DeepSeek Harness 轨迹视图一手调研 + 训练控制台美学）。
范围纯前端（`apps/web`），控制内核零改动。

| 片 | 内容 | 证据 |
|---|---|---|
| S1 | 设计系统重写：5 级表面 token、角色配色体系、暗/亮主题切换（localStorage 持久化）、细滚动条/焦点环/动效降级 | `apps/web/src/styles.css`、`docs/evidence/ui-overhaul/01/06` |
| S2 | Agent 轨迹视图 `Trajectory.tsx`：Input/Model/Tools 三车道活动带（对标 DSH Trajectory）、结构化时间线（causation_id 配对算耗时/token/成本）、车道过滤、跟随滚动、2s 实时刷新；替换原 `<pre>` 原始日志 | `docs/evidence/ui-overhaul/12/13/16-*.png` |
| S3 | RSI 实时曲线：零依赖 SVG 图表 `charts.tsx`（面积渐变/虚线基线/最新值标注）；演进视图重构 `Evolution.tsx`——epoch 状态条、4 指标卡、评测曲线（`evaluation.completed` SSE 实时追加、按裁决着色、epoch 切换标线）、预算燃烧/指标调用双曲线（RUNNING 时 3s 轮询）、优化器运行表、"运行一轮优化"按钮 | `docs/evidence/ui-overhaul/30/31-*.png` |
| S4 | 任务 DAG `TaskGraph.tsx`（拓扑分层 SVG、角色点/状态色/箭头边）；顶栏系统弹窗（`/v1/settings/model` + `/v1/metrics`，此前 UI 未接的两个端点） | `docs/evidence/ui-overhaul/05/10-*.png` |
| S5 | 验证：35/35 单测过；官方 e2e 主路径 2/2 过（真实 LLM）；真实目标+真实 worker 全程截图 0 控制台错误；researcher 账号真实演进数据验证曲线渲染 | `docs/evidence/ui-overhaul/`、`data/ui-*-verify.log` |

本轮修复的运行时发现：SSE 信封字段 `sequence` 未归一为 `seq`（曲线 NaN）；`run-round` 空 body 触发服务端 502（UI 现发 `{}` 并默认用 epoch 活跃后端 active 模式）；轨迹时间戳 UTC→本地时区。
验证脚本：`scripts/ui-smoke.mjs`（无 LLM 冒烟）、`scripts/ui-live.mjs`（真实目标）、`scripts/ui-researcher.mjs`（真实演进数据 + 实时优化轮）。

注意：根 `package.json` 的 `build`/`typecheck` 脚本引用 `tsconfig.build.json`，该文件从未入库（git 无记录）——属既有问题，本轮未触碰；web 应用经 `apps/web` 自身 tsconfig 构建验证。

---

更新时间：2026-09-24 24:00（第二轮迭代）· 分支：`impl/platform`（本地，未推送）

## 当前状态

按 P0→P5 推进的核心平台已实现并在本机真实运行验证。
设计基线：`SELF_IMPROVING_AGENT_DESIGN.md`；实现目标：`IMPLEMENTATION_GOAL.md`；
机器可读验收：`acceptance/acceptance-manifest.json`。

## 已完成并有证据的能力

| 阶段 | 内容 | 证据 |
|---|---|---|
| P0 | contracts 包（状态机/事件信封/RunSpec/TaskPack/图编译器）、ADR×2、威胁模型、验收清单 | `packages/contracts`、`tests/unit/contracts.test.ts`、`docs/decisions/`、`docs/architecture/threat-model.md` |
| P1 | 控制服务（auth/goals/scheduler/events/outbox/budget/SSE/LLM 网关）+ agent worker（真实模型+工具+检查点） | A01 垂直链路（见下）+ `tests/integration/a02-a05`、`a03-a04-a07`、`a06-a08` |
| P2 | 3 个 TaskPack 合同；bin-packing 与 harness 两个真实评测器；sealed 发布套件；审计钩子沙箱 | `taskpacks/`、`tests/integration/a09-a12`、`docs/evidence/evolution-demo/` |
| P3 | 演进闭环：失败归档→LLM 提案→构建→dev/selection/release 三层评测→CAS 发布→canary 回滚→元评测 | `scripts/demo-evolution.ts` 真实运行记录、`a09-a12`、`a13-a18` 测试 |
| P4 | 科研服务（假设卡/冻结协议/配对种子分析/五级判定/Claim）、引用核验、记忆与技能表 | `apps/control/src/research.ts`、`evidence.ts`、`a13-a18` 测试 |
| P5 | 租约对账、故障注入（杀 worker）、bounded soak 脚本、/v1/metrics | `tests/soak/`、`tests/fault-injection/`、`docs/evidence/soak/` |

### A01 垂直链路（真实模型，2026-09-24 运行）

- 目标「用 Python 写 is_prime 并用 10 个用例验证」：Coordinator→Builder→
  Experimenter→Reviewer→verify 全部真实执行；`prime.py` 真实生成并通过 10/10
  用例；Reviewer 独立对筛法交叉验证零失配（`docs/evidence/incident-001-…/` 内原始产物）。
- UI 实时目标「统计 1..10000 素数个数」：goal COMPLETED，核验 6/6，
  交付物 `primes_count.py` 独立复跑输出 `count=1229`（正确），
  总花费 $0.142 全额计量（截图 `docs/evidence/ui-live-*.png`）。
- 真实模型烟测：`tests/contract/deepseek-smoke.test.ts`（deepseek-chat，
  用量与成本入账，密钥不出现在任何事件负载）。

## 未完成 / 明确延期（不虚报）

| 项 | 状态 | 说明 |
|---|---|---|
| A17 72h soak | **部分执行** | 已跑 5 分钟有界浸泡（73 周期 / 0 错误 / 4 次故障注入，报告 `docs/evidence/soak/`）；72h 全程未执行，脚本已备好（`--duration 72h`），不能声称通过 |
| 故障注入（杀 worker） | **已执行（带保留）** | 实测击杀处于 RUNNING 的 victim；Windows 进程树击杀存在竞态（数次落在提交之后）。确定性覆盖见 A04/A05 自动化测试；账本取证报告 `docs/evidence/fault-injection/` |
| Pi（@earendil-works）集成 | **生产默认运行时（第九/十五轮）** | 锁定 0.87.1；6 项契约测试 + 真实模型烟测 + 结算对齐（第十四轮）；P15 起 `RUNTIME` 默认 `pi`（`RUNTIME=loop` 显式回退）。默认路径真实 e2e：新目标 t1→t3 全 SUCCEEDED（44 checkpoint 全带 runtime=pi-agent-core），verify 节点 3 次诚实失败后编排器自派 diagnose 任务并 SUCCEEDED——自诊断循环在默认运行时全链工作 |
| OS 级 worker 沙箱（容器/Job Object） | 延期 | 当前为语言级审计钩子 + 目录/路径限界；威胁模型已登记边界 |
| A17 72h soak | **部分执行（扩大）** | 2026-09-25 追加 20 分钟有界浸泡（预算护栏语义修正为单次运行增量 + 请求超时 + 逐周期日志后执行）；72h 全程仍未执行，不能声称通过 |
| GEPA 后端（OptimizerPort） | **已接入**（第二轮迭代） | `gepa==0.1.4`（PyPI 核验，自研适配器 `optimizers/gepa-backend/`）；真实模型 epoch 试炼已运行，裁决"证据不足，保留现任"——见 `docs/evidence/optimizer-epoch-trial/TRIAL-VERDICT.md`。ShinkaEvolve/OpenEvolve 结论（第十五轮调查）：**ShinkaEvolve 无官方可装包**（PyPI 无 `shinkaevolve`；`shinka` 0.3.0 为无关图像放大包，名称撞车）——接入须 vendor 研究代码，超出锁定依赖边界，诚实搁置；**OpenEvolve 可装**（`openevolve==0.3.2`，PyPI 核验）——第三后端的具体候选，接入方案与 GEPA 相同（后端子进程经计量代理反射、candidate_runner 沙箱评分、预算桥接 max_evaluations→max_metric_calls），作为独立后续轮次 |
| OpenEvolve 后端（OptimizerPort 第三后端） | **已接入 + 真实试炼完成**（第十六轮） | `openevolve==0.3.2` 注册进合同注册表（`openevolve-backend/backend.py`，与 GEPA 同一生成协议：argv manifest / result.json / LOOPLAB_OPT_TOKEN）。密钥不变式保住方式：OpenEvolve 自带 LLM 客户端指向**回环 shim**（127.0.0.1 随机端口，OpenAI 兼容 /chat/completions），shim 把每次调用转为计量代理请求——模型密钥仍不出控制进程；评测桥接为自包含生成文件（跨进程沙箱 + metric_state.json 预算账本）。真实试炼（goal_a184045a4a614540，gap 族，等预算 40 指标调用）：挑战者 10 次计量 LLM 变异 / $0.0147，best==seed 诚实 0 提案；现任 simple-baseline 提案独立评测 ELIGIBLE delta=1；结算**保留现任**。FFD 局部最优结论第三次获得独立后端佐证。demo 脚本现支持 `CHALLENGER=<backend>` 泛化 |
| 参数训练（RL/微调） | 关闭 | 设计允许，非本期范围 |

## 事故账本

- incident-001：run_python cwd 静默回退（旧进程）→ chdir 哨兵。
- incident-004：OptimizerPort 首接三缺陷（run token 未入子进程 → 反射静默 401；
  批量评估预算过冲；venv base-prefix 使沙箱误伤标准库 → 内部评分全 0）。
  两轮"看似成功"的试炼因内部信号全 0 被作废重跑——检查手段：适配器直接评分
  基线应有 ≈0.93–0.97 效率而非 0。报告：`docs/evidence/incident-004-…/`。
- incident-002：run_python 允许绝对路径 → PEP 578 审计钩子全量隔离。
- incident-003：修完钩子未重启旧 worker → 仓库根散落 ~80 文件（已归档）；
  runbook 增加「worker 修复后必须重启 + gw-hardening 断言」步骤。
- incident-005：demo 脚本三元 scope 映射落入 else → 错范围灰度发布；
  canary-check "no pointer" 立即暴露；手动回滚端点补齐后回滚→重发布→监视通过。
- incident-006：workspace_write 相对路径按 worker 进程 CWD 解析（策略判定
  与执行器解析不一致）→ soak 目标交付物散落仓库根（22 文件）。Gateway 新增
  contain()（解析+收容，与 PolicyGate 一致），回归测试 4 项；文件归档
  `docs/evidence/incident-006-workspace-write-cwd-litter/`。

## 问题账本（按影响排序）

5. **已关闭（第六轮）**：跨 attempt 产物传播落地——
   (a) claim 时 scheduler 解析 SUCCEEDED 前驱的最新 COMMITTED attempt 的
   task-scope 产物（按名去重取最新、上限 20），写入 RunSpec 新可选字段
   `propagated_artifacts`；(b) worker 循环开始前经 attempt 围栏下载端点
   `GET /v1/attempts/:id/propagated/:digest` 物化进工作区（两个运行时通用）；
   (c) commit 前对工作区做**确定性快照上传**（上限 20 文件×256KB），不再
   依赖模型在 RESULT.files 里自报交付物；(d) commit 围栏接受 STARTED 起点
   （纯文本收尾的 attempt 不经过 RUNNING）。端到端复验：t1→t2→t3 全链
   SUCCEEDED，实验任务摘要确认 import 前驱产物跑通 3/3 用例。
   测试：`tests/integration/a21-propagation.test.ts`（2 项）。

1. **已关闭（第九轮）**：RESULT 收尾失败不再浪费整个 attempt——
   结算策略抽为两个运行时共享的 `result-synthesis.ts`：(a) 可解析 RESULT
   原样透传；(b) 做了工作但格式不可解析（重问后仍失败）→ SUCCEEDED +
   诚实 `result_format` 信号（passed=false，摘要取最后陈述），交付物由
   确定性工作区快照兜底，不再 verification=null 也不整 attempt 作废；
   (c) 无任何文本 → FAILED（重试合理，未产出可采信内容）。pi 运行时补齐
   「临近步数上限强制收尾」对齐（末轮禁工具 + 结构化重问，与 loop 一致）；
   无文本时不再浪费一次重问调用。生产库取证：407 COMMITTED / 0 FAILED
   attempt，重试浪费主要来自真实 verdict 失败与 soak 注入；本修复消除的是
   格式性失败这一残余浪费类别。测试：`tests/unit/result-synthesis.test.ts`（7）、
   `tests/unit/runtime-settlement.test.ts`（4，双运行时确定性结算）。
2. **已关闭（第八轮）**：SSE「服务重启中的重连」路径落地验证——
   A23 用应用级真实重启（旧实例被 closeAllConnections 杀停、socket 中断、
   内存总线全丢；新实例对同一 DB 打开）复现进程死亡：客户端持旧游标重连后，
   以 DB 事件账本为唯一事实断言——游标之后每个事件**恰好一次、按 seq 有序**，
   覆盖杀停前已提交未推送的在途窗口与重启后新事件；`?after=`（前端 hook
   路径）与标准 `Last-Event-ID` 头（原生 EventSource 路径，服务端新增回退
   支持）双路均验证。在线实证：重启后的 ：8080 实例以
   `Last-Event-ID: 30974` 恰好重放 5 个事件。
   测试：`tests/integration/a23-sse-restart-reconnect.test.ts`（1 项）。
3. **已关闭（第七轮）**：调度优先级落地——goals 增加 priority
   （1 最急 .. 9 最不急，默认 5，CHECK 约束）；claim 候选排序改为
   (priority ASC, created_at ASC)：紧急目标抢占更早的积压，同级保持 FIFO；
   预算不足的目标不阻塞更低层级的候选（循环跳到下一个候选）。用户经
   set_priority 命令即时改级（任意状态可用、幂等、走命令/事件审计，
   事件 goal.priority_changed 记录 from/to）；会话首消息可携带 priority
   建目标。1..9 之外的值在两个入口都被拒绝且无部分写入。
   测试：`tests/integration/a22-priority-scheduling.test.ts`（3 项）。
4. **已关闭（2026-09-25）**：图 revise 现在计算受影响子图（变更节点+传递后继），
   只重建受影响节点，保留有效前缀（不受影响已提交节点不重跑、不受影响在途任务
   保留冻结规格）；调度器依赖判定改为 (goal, node_key) 作用域以支持跨版本前缀；
   revise 负载支持显式携带新图（compileGraph 验证，非法图 → 命令 FAILED + 事件，
   不卡死编排器）。测试：`tests/integration/a20-revise-affected.test.ts`（4 项）。

## 复现命令

见 README「测试」一节。全套：`npx vitest run`（60+ 用例）、
`DEEPSEEK_API_KEY=… npx playwright test`、
`npx tsx scripts/demo-evolution.ts`（演进闭环演示）、
`npx tsx scripts/demo-optimizer-epoch.ts`（元演进 epoch 试炼，需 `.venv-gepa`）。

## 第二轮迭代：OptimizerPort + GEPA + 元演进 epoch（2026-09-24 晚）

- **合同**：`packages/contracts/src/optimizer.ts` —— 后端注册表、run manifest、
  提案/用量 schema、纪元授权守卫 `assertOptimizerAuthorized`、裁决规则
  `nextEpochWinner`（严格 margin，平局=证据不足不切换），递归深度结构性为 1。
- **控制面**：`apps/control/src/optimizer.ts` + 路由 `/v1/goals/:id/optimizer/*`、
  `/v1/meta/epoch*`；迁移 004（`optimizer_epochs` / `optimizer_runs`）。
  反射 LLM 走 **计量代理** `POST /v1/optimizer/llm`（run token 鉴权、
  预留→调用→结算、密钥不出控制进程）；后端是唯一拿 run token 的进程。
- **后端**：`optimizers/gepa-backend/backend.py` —— GEPAAdapter 真适配
  （evaluate 沙箱子进程评分 / make_reflective_dataset / propose_new_texts），
  预算预检防批量过冲，连续反射失败熔断，种子未改进=诚实 0 提案。
- **试炼裁决**：gepa 挑战现任 4 轮（2 轮因 incident-004 作废），2× 预算下
  26 次真实反射无一变体通过严格改进验收 → INCONCLUSIVE，纪元不切换。
  FFD 在该任务族已处贪心局部最优（6 种确定性策略同箱数实测）。
- **测试**：单元 `tests/unit/optimizer-contracts.test.ts`（10）+
  集成 `tests/integration/a19-optimizer-port.test.ts`（6）；验收清单 v3 增 A19。

## 第三轮迭代：等协议试炼 + 大实例族 + revise 受影响子图（2026-09-25）

- **等协议元演进**：现任 simple-baseline@1 注册进 OptimizerPort（进程内一次
  真实 LLM 提案，同一 completeRun 合同），与挑战者在同一冻结任务族上比较；
  结算只看独立 selection 评测的严格 margin。
- **大实例族**：`algorithm-search.bin-packing-large`（220 物品/实例，seed
  archive 与小族隔离），seal-suites 一并 provision；OptimizerService/taskpack
  参数化（route 透传 taskpack_id）。
- **试炼结果**（等协议，goal_400e49a41ee644ab）：现任 delta=0（INCONCLUSIVE）、
  挑战者无提案（80/80 评估、13 反射、$0.021）→ 证据不足，保留现任。
  解读：FFD 在均匀随机实例上接近贪心最优，LLM 提案同样只能打平——这是任务族
  信息量结论，不是平台缺陷；有区分度的下一次试炼需要已知次优间隙的实例族。
  见 `TRIAL-VERDICT.md` 补充裁决。
- **A20（§六.3）**：revise 受影响子图重算落地（见问题账本 #4 关闭记录）。

## 最终验证（2026-09-24）

- `DEEPSEEK_API_KEY=… npx vitest run`：第一轮 25 passed；第三轮 45 passed / 1 skipped / 0 failed（A19+A20 在内）。
- `npx playwright test`：2 passed（真实浏览器主路径 + 未认证 SSE 拒绝）。
- 累计真实模型开销：第一轮约 $10.9（3952 次调用）；第二轮 epoch 试炼新增
  ≈$0.20（含作废运行的全部计量花费，见 TRIAL-VERDICT.md）。全部计入预算账本，
  可在 /v1/metrics 复核。

## 第四轮迭代（2026-09-25）：间隙族试炼 — 改进闭环全程真实贯通

- **间隙任务族** `algorithm-search.bin-packing-gap`：供给期筛选保证 FFD
  至少 1 箱可回收（套件无标签，评测器不变，属基准选题）。
- **等协议试炼**：现任与挑战者**双双 ELIGIBLE**（bins_avg 19.5→18.5，
  delta=1.0）——独立收敛到同幅改进，结算按规则判平保留现任（诚实拒绝
  无区分度证据下的纪元切换）。
- **首个真实灰度发布**：rel_fc218733450544ba @ algorithm:bin-packing-gap
  （canary，ACTIVE），回归监视通过；期间发生并纠正错范围发布事故
  （incident-005：demo 脚本三元 scope 映射落入 else 分支），补上手动
  回滚运维端点 `POST /v1/goals/:id/releases/:releaseId/rollback`。
- **A17 证据加强**：soak 加固三处——预算护栏从"账本累计"修正为"单次运行
  增量"（原实现对长生命周期账本必然秒退）、每次请求 20s 超时、逐周期进度
  日志；20 分钟有界浸泡执行归档（`docs/evidence/soak/`）。
