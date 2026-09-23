# API 合同 · 前端 ↔ 控制服务

本文件定义工作台 UI 消费的数据形状。样机中的 `demo-data.js` 逐字段对应本文 DTO；真实实现时渲染层不需要改动，只需把数据源从 fixture 换成 SSE 流 + REST 响应。

## 事件流（驱动一切展示）

```
GET /v1/events?after={cursor}        SSE，断线按游标补齐，按 event_id 去重
```

事件信封（对应设计报告 §17.2）：

```json
{
  "schema_version": "1",
  "event_id": "evt_a21f",
  "aggregate_type": "attempt | goal | run | candidate | release | budget",
  "aggregate_id": "run_7a31",
  "sequence": 12,
  "event_type": "experiment.result_committed",
  "goal_version": "goal_demo@3",
  "trace_id": "trace_…",
  "causation_id": "cmd_…",
  "actor": { "kind": "worker", "id": "sandbox-01" },
  "lease_epoch": 7,
  "payload_ref": "artifact://sha256/…",
  "occurred_at": "2026-09-23T06:12:03Z"
}
```

UI 投影规则：命令回执只代表 `accepted`；状态推进以事件流为准（`applied`）。重连后用最后游标补齐，不重复插入消息。

## 会话 / 目标

```ts
interface Session {
  id: string;                    // ses_…
  project: string;               // harness-improvement | algorithm-search | computational-research
  title: string;
  state: "draft" | "active" | "paused" | "waiting" | "blocked";
  updatedAt: string;             // 服务端投影的相对时间
  goalVersion: string | null;    // goal_demo@3
}

interface WorkCard {             // 当前工作卡（GET /v1/goals/{id} 投影）
  version: string;               // 采用的图/代码版本（冻结引用）
  doing: string;                 // 正在做什么
  lastProgress: string;          // 最近一次有效进展（非改写总结）
  waitingReason: string;         // PAUSED_USER / WAITING_RESOURCE / BLOCKED_INPUT / 无
  nextStep: string;
  budgetLeft: string;            // 含未结算保守预留
  verified: null | { done: number; total: number; source: string };
  // verified=null ⇒ 开放研究，UI 不得显示整体完成百分比
}
```

## 命令（均需登录身份 + command_id + expected_version）

```
POST /v1/goals/{id}/commands      { kind: "pause" | "resume" | "cancel" | "steer" | "revise", … }
POST /v1/approvals/{id}/decision  { decision: "approve" | "reject" }
POST /v1/promotions               发布/灰度请求（CAS：仅更新一次同一父版本指针）
```

- `pause`：停止派发新任务；当前动作按策略排空或终止——UI 分两段展示，不用一个绿色提示代表两件事。
- `cancel`：需确认影响；已发生的外部副作用不可撤销，UI 显式列出。
- `steer`：改变后续行为，不强制停止当前工具——聊天输入框不等于取消。

## 运行 / Attempt / 事件

```ts
interface Run {
  id: string;                    // run_…
  attempt: number;
  status: "RUNNING" | "LEASED" | "STARTED" | "RESULT_PENDING" | "COMMITTED"
        | "SUCCEEDED" | "FAILED" | "LOST" | "RECONCILE_REQUIRED";
  worker: string;
  started: string;
  dur: string | null;
  cost: string;
  events: number;
  cursor: string;                // 事件流游标：断线从此续传
}
```

`RECONCILE_REQUIRED` ⇒ 外部动作结果未知，先对账，禁止盲重试；迟到 Worker 的结果进入隔离记录，不推进任务状态（A04/A05）。

## 演进谱系

```ts
interface Candidate {
  digest: string;                // c118
  title: string;                 // 改了什么
  parent: string;                // 父版本（可多父："v17 · v12"）
  status: "PROPOSED" | "BUILT" | "EVALUATING" | "INCONCLUSIVE"
        | "ELIGIBLE" | "CANARY" | "RELEASED" | "REJECTED" | "ROLLED_BACK";
  note: string;                  // 测试覆盖与缺口、回滚方式；先于任何综合分数
}
```

呈现约束：RELEASED / CANARY / INCONCLUSIVE / REJECTED / ROLLED_BACK 视觉区分，禁止统一绿色成功色；REJECTED 与负结果保留在谱系中，不删除。

## 证据与资产

```ts
interface Artifact { name: string; digest: string; type: string; producer: string; scope: string; }
interface Claim    { text: string; stance: "条件内支持" | "证据不足" | "条件内否定" | "已被反证";
                     scope: string; state: "ok" | "warn" | "bad"; }
interface Skill    { name: string; version: string; status: "candidate"; scope: string; note: string; }
interface Hypothesis { text: string; stage: "S0" | "S1" | "S2" | "S3" | "S4";
                       verdict: string; scope: string; }
```

- `GET /v1/artifacts/{digest}`：权限检查 + 内容类型安全校验后下载原件；响应不含凭据与封存标签。
- Claim 与 Artifact 分开：报告只能引用已登记的 Claim；推论/引文/实测分栏。

## 审批

```ts
interface Approval { id: string; kind: "发布审批" | "预算审批"; title: string;
                     detail: string; scope: string; }
```

待审批项在全局待办条 + 检查器中呈现；`decision` 只允许对应人工主体在授权范围内操作。

## 预算

`BudgetReservation { scope, reserved, settled, unknown_cost }`：未结算模型费用保守预留、不记零；接近上限时不再接新高成本任务并保存检查点（A08）。顶栏预算条展示 已用/上限 + 未结算。
