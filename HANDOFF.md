# HANDOFF — 交接状态

更新时间：2026-09-24 04:00 · 分支：`impl/platform`（本地，未推送）

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
| Pi（@earendil-works）深度集成 | 延期 | npm 包已核验（ADR-0002）；AgentRuntimePort 由 DeepSeekLoopRuntime 实现，Pi 会话级适配留待后续 |
| OS 级 worker 沙箱（容器/Job Object） | 延期 | 当前为语言级审计钩子 + 目录/路径限界；威胁模型已登记边界 |
| GEPA / ShinkaEvolve / OpenEvolve 后端 | 未接 | OptimizerPort 合同与简单基线已实现；外部搜索器接入为后续阶段 |
| 参数训练（RL/微调） | 关闭 | 设计允许，非本期范围 |

## 事故账本

- incident-001：run_python cwd 静默回退（旧进程）→ chdir 哨兵。
- incident-002：run_python 允许绝对路径 → PEP 578 审计钩子全量隔离。
- incident-003：修完钩子未重启旧 worker → 仓库根散落 ~80 文件（已归档）；
  runbook 增加「worker 修复后必须重启 + gw-hardening 断言」步骤。

## 问题账本（按影响排序）

1. verify/审查任务偶发因模型不按 RESULT 格式收尾而失败重试（消耗预算）；
   已通过「临近步数上限强制收尾」缓解，仍偶发。
2. E2E 中 SSE 断连重连已实现游标续传，但未覆盖「服务重启中的重连」路径。
3. 调度 FIFO 会先消化历史积压目标（本次演示中已观察到）；优先级策略未实现。
4. 图 revise 后仅取消旧 READY/WAITING 任务，受影响后继的自动重算未实现（编译器 API 已备）。

## 复现命令

见 README「测试」一节。全套：`npx vitest run`（25+ 用例）、
`DEEPSEEK_API_KEY=… npx playwright test`、
`npx tsx scripts/demo-evolution.ts`（演进闭环演示）。

## 最终验证（2026-09-24）

- `DEEPSEEK_API_KEY=… npx vitest run`：25 passed / 1 skipped（BLOCKED 占位）/ 0 failed。
- `npx playwright test`：2 passed（真实浏览器主路径 + 未认证 SSE 拒绝）。
- 累计真实模型开销：全程约 $2.6（全部计入预算账本，可在 /v1/metrics 复核）。
