# HANDOFF — 交接状态

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
| Pi（@earendil-works）集成 | **生产可选运行时已验证**（第四/五轮） | 锁定 0.87.1；6 项契约测试 + 真实模型烟测；`RUNTIME=pi` 启动 worker 即用 PiAttemptExecutor 驱动完整 attempt（领取/计量/门控/检查点/RESULT/提交/3-strike 诊断全链路真实跑通，检查点带 runtime=pi-agent-core 标记）；默认运行时仍为 loop |
| OS 级 worker 沙箱（容器/Job Object） | 延期 | 当前为语言级审计钩子 + 目录/路径限界；威胁模型已登记边界 |
| A17 72h soak | **部分执行（扩大）** | 2026-09-25 追加 20 分钟有界浸泡（预算护栏语义修正为单次运行增量 + 请求超时 + 逐周期日志后执行）；72h 全程仍未执行，不能声称通过 |
| GEPA 后端（OptimizerPort） | **已接入**（第二轮迭代） | `gepa==0.1.4`（PyPI 核验，自研适配器 `optimizers/gepa-backend/`）；真实模型 epoch 试炼已运行，裁决"证据不足，保留现任"——见 `docs/evidence/optimizer-epoch-trial/TRIAL-VERDICT.md`。ShinkaEvolve/OpenEvolve 仍为后续 |
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

1. verify/审查任务偶发因模型不按 RESULT 格式收尾而失败重试（消耗预算）；
   已通过「临近步数上限强制收尾」缓解，仍偶发。
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
