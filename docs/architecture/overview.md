# 系统架构（实现态）

对应设计 §04–§17 的落地结构。日期：2026-09-24。

## 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| 控制服务 | `apps/control` | 身份/会话、目标与版本、任务图、调度（唯一权威）、事件账本、outbox、预算、LLM 网关、演进/发布/科研/证据服务、SSE |
| Worker | `workers/agent-worker` | 领取 attempt → 有界 agent 循环（真实模型、工具）→ 检查点 → 提交；心跳驱动 drain/abort/steer |
| 能力网关 | `workers/agent-worker/src/capability-gateway.ts` | 工具执行的 OS 限界：路径规约、chdir 哨兵、Python 审计钩子（文件/网络/子进程）、时长/输出/进程数上限 |
| 评测器 | `taskpacks/*/evaluator.py` + `data/taskpacks/`（运行副本） | 独立进程评测；sealed:// 套件仅评测进程可解析；候选运行于审计钩子沙箱 |
| 前端 | `apps/web` | React 工作台：左侧项目/会话、中间 Agent 区、右侧工作区四视图、按需检查器 |

## 数据流（一次提交）

```
POST /v1/sessions/:id/messages
  → 首条消息：goal + goal_version(1) + 消息入账
  → LLM 规划（经 LlmGateway：预算预留→真实 DeepSeek→结算→事件）
  → compileGraph 校验（环必须有界声明）→ graph_versions + tasks(READY)
  → 事件 goal.graph_planned / goal.activated
Scheduler.claim(worker)（唯一调度权威，SKIP LOCKED）
  → 依赖满足 + goal ACTIVE + 预算余量 → attempts(LEASED, epoch=1)
  → attempt_specs 冻结 RunSpec（工具白名单、资源、预算、租约 TTL）
Worker 循环（每轮）：
  heartbeat → continue/drain(PAUSED_USER)/abort(CANCELLED|fencing)
  LLM 调用 → POST /v1/attempts/:id/llm（网关：预留→真实调用→结算→事件）
  工具调用 → POST /tools/authorize（PolicyGate，先决后行）
           → 本地能力网关执行（审计钩子沙箱）
           → POST /tools/report（产物摘要入账）
  检查点 → POST /checkpoint（状态+产物引用+进展类别）
  结束 → RESULT JSON → 产物上传（内容寻址）→ POST /commit（fencing + 幂等）
Commit（控制服务事务内）：
  fencing 校验 → attempt COMMITTED → task SUCCEEDED/FAILED（A13: 3 次同指纹→WAITING+诊断任务）
  → 图完成 → Reviewer 独立验证任务 → goal COMPLETED / BLOCKED_INPUT
Supervisor（Orchestrator，规则驱动，无 LLM）：
  租约过期 → LOST（RESUILT_PENDING→RECONCILE_REQUIRED，不盲重试）
  WAITING_RESOURCE + 预算恢复 → 自动 ACTIVE（同一授权内）
  ACCEPTED 未应用的 revise → 异步规划
```

## 关键机制 ↔ 验收映射

| 机制 | 验收 |
|---|---|
| PolicyGate 执行前拒绝 + 拒绝事件 | A02 |
| SSE 游标重放 + event_id 去重 | A03 |
| 产物先上传、迟到提交隔离（fencing + 状态机） | A04 |
| 租约 epoch 抢占 | A05 |
| 暂停停止派发 + 运行中 drain | A06 |
| 暂停持久化、重启不复活、仅 resume 可解除 | A07 |
| 预算预留/结算/未知保守保留、超限拒绝 | A08 |
| 版本指针 CAS | A09 |
| sealed:// 沙箱（审计钩子）+ 违规隔离 | A10 |
| 程序评测硬门 > LLM 评审意见 | A11 |
| INCONCLUSIVE（证据不足）判定与保留 | A12 |
| 同指纹 3 次失败 → 诊断任务 | A13 |
| 引用核验（dangling → 阻断完成） | A14 |
| canary 回滚（指针翻转、证据保留） | A15 |
| RunSpec 冻结 + attempt_specs 可追溯 | A16 |
| soak/故障注入脚本 + 诚实标注 | A17 |
| 元评测外层任务族比较（保护域只读） | A18 |

## 明确的当前边界（与设计差距）

- Worker 与控制服务同机：审计钩子提供语言级隔离，OS 级隔离（容器/Job Object）为增强项。
- 调度为 FIFO（按任务创建时间）：跨目标的优先级/公平性策略未实现（问题账本 #4）。
- Pi（@earendil-works）深度会话集成延期（ADR-0002）；AgentRuntimePort 由 DeepSeekLoopRuntime 实现。
- 图编辑后的"受影响后继重算"支持编译器级 API（affectedSubgraph），goal 层自动重算未接。
