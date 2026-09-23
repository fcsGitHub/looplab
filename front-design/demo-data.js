/* ═══════════════════════════════════════════════════════════════
   演示数据 · DEMO DATA
   ⚠ 全部为界面示意 fixture，不代表真实运行结果。
   字段形状与 api-contract.md 中定义的服务端 DTO 一一对应；
   接入真实控制服务后，本文件由 GET /v1/events SSE 流驱动替换。
   ═══════════════════════════════════════════════════════════════ */

const DEMO = {
  sessions: [
    {
      id: "ses_9f2c",
      project: "harness-improvement",
      title: "改进工具失败处理插件",
      state: "active",            // draft/active/paused/waiting/cancelled
      updatedAt: "2 分钟前",
      goalVersion: "goal_demo@3",

      /* —— 主 Agent 摘要（点开看详情） —— */
      mainAgent: {
        role: "Coordinator",
        status: "running",        // running/paused/waiting
        objective: "改进工具失败处理：消除大输出截断后的无效重复调用",
        doing: "委派 Builder 实现最小补丁（提案 C-118），并同步准备选择评测",
        nextStep: "补丁构建通过后进入开发评测 suite://harness/dev-v1",
        plan: [
          { step: "固定模型与图版本，收集基线轨迹", status: "done" },
          { step: "失败归因（截断 / 重试 / 上下文）", status: "done" },
          { step: "实现最小补丁（候选 C-118）", status: "run" },
          { step: "开发评测 dev-v1", status: "todo" },
          { step: "独立评测 + 灰度发布", status: "todo" }
        ],
        detail: {
          frozen: "graph@5 · looplab-model/default · 编辑面 candidate/",
          budgetScope: "执行 ¥37.60 剩余 · 演进 ¥8.20 · 评测 ¥4.00（分账）",
          checkpoint: "14:15:01 checkpoint.committed（epoch 7）",
          waiting: "无（依赖与预算满足）"
        }
      },

      /* —— 子 Agent（点开看执行情况） —— */
      subagents: [
        {
          id: "sa_b1", role: "Builder", status: "running", dur: "12 分钟",
          task: "按提案 C-118 修改工具包装：截断后先压缩摘要再决定是否重试",
          progress: "构建通过 · 开发评测 3/8 项",
          steps: [
            { t: "14:12", kind: "info", text: "领取任务 t_103（lease epoch 7）" },
            { t: "14:13", kind: "tool", text: "编辑 candidate/tool_wrapper.py（+38 −12）" },
            { t: "14:14", kind: "tool", text: "运行构建与契约测试 — 通过" },
            { t: "14:15", kind: "ok",   text: "提交检查点 checkpoint.committed" },
            { t: "14:16", kind: "run",  text: "执行 dev-v1 评测（3/8 项，进行中）" }
          ],
          output: "patch-c118.diff · eval-dev-v1-report.json"
        },
        {
          id: "sa_r1", role: "Researcher", status: "done", dur: "8 分钟",
          task: "来源定位与竞争解释，支撑失败归因",
          progress: "已交付 3 条主张（2 支持 / 1 反证）",
          steps: [
            { t: "13:02", kind: "info", text: "领取任务 t_101" },
            { t: "13:05", kind: "tool", text: "检索内部轨迹库，定位 12 组失败组合" },
            { t: "13:10", kind: "ok",   text: "交付归因分布与竞争解释" }
          ],
          output: "baseline-traces.tar.zst"
        },
        {
          id: "sa_e1", role: "Experimenter", status: "waiting",
          task: "安排基线复测与配对种子",
          progress: "等待 Builder 补丁进入评测",
          steps: [],
          output: null
        }
      ],

      /* —— 任务状态栏 / 当前工作 —— */
      work: {
        version: "release/0.4.2",
        doing: "Builder 正在按提案 C-118 修改工具包装，限制大输出截断后的重复调用",
        lastProgress: "14:02 复现了失败组合 F-07：截断输出导致第 2 次无效重试，轨迹已归档",
        waitingReason: "无（预算与依赖均满足）",
        nextStep: "提交最小补丁后进入选择评测；若通过则安排独立发布评测",
        budgetLeft: "¥37.60 / ¥50.00（未结算 ¥1.10）",
        verified: { done: 3, total: 8, source: "固定合同批次 dev-v1" }
      },
      tasks: [
        { id: "t_101", name: "收集基线轨迹（F-01…F-12）", status: "SUCCEEDED" },
        { id: "t_102", name: "失败归因：截断 / 重试 / 上下文", status: "SUCCEEDED" },
        { id: "t_103", name: "实现最小补丁（C-118）", status: "RUNNING", role: "Builder" },
        { id: "t_104", name: "开发评测 suite://harness/dev-v1", status: "READY" },
        { id: "t_105", name: "选择评测 + 独立发布评测（封存）", status: "WAITING" },
        { id: "t_106", name: "灰度 5% 低风险任务", status: "WAITING" }
      ],

      messages: [
        { role: "user", text: "这个插件在工具返回大输出或暂时失败时经常反复调用，先固定模型和任务包，收集基线轨迹再改。" },
        { role: "agent", who: "Coordinator", text: "已冻结模型 looplab-model/default 与图版本 graph@5。基线轨迹 12 组失败组合已归档，归因分布如下：" },
        { role: "agent", who: "Coordinator", card: {
          title: "失败归因 · 12 组基线轨迹", status: "已归档",
          rows: [["输出截断", "6 组 · 主因"], ["重试策略", "3 组"], ["上下文缺失", "2 组"], ["工具/环境故障", "1 组 · 不计入算法失败"]]
        }},
        { role: "agent", who: "Builder", text: "最小补丁 c118 已生成：截断后先压缩摘要再决定是否重试，禁止原样重发。构建通过，进入开发评测。" },
        { role: "user", text: "补充上下文：失败组合 F-07 的日志已上传到 evidence/。" }
      ],

      traces: [
        { id: "run_7a31", attempt: 1, status: "RUNNING", worker: "sandbox-01", started: "14:12:03", dur: "12 分钟", cost: "¥0.42", events: 118, cursor: "evt_a21f" },
        { id: "run_7a2e", attempt: 2, status: "COMMITTED", worker: "sandbox-01", started: "13:58:41", dur: "9 分钟", cost: "¥0.35", events: 96, cursor: "evt_a10c" },
        { id: "run_79fd", attempt: 1, status: "SUCCEEDED", worker: "sandbox-02", started: "13:20:07", dur: "21 分钟", cost: "¥0.61", events: 204, cursor: "evt_9e88" },
        { id: "run_79e0", attempt: 1, status: "RECONCILE_REQUIRED", worker: "sandbox-03", started: "11:02:55", dur: "—", cost: "¥0.18", events: 41, cursor: "evt_88d1" }
      ],

      candidates: [
        { digest: "c118", title: "截断后摘要压缩 + 去重重试", parent: "release/0.4.2", status: "EVALUATING", note: "开发评测 3/8 项通过；覆盖缺口：大文件写入路径。回滚：指针回退即恢复。" },
        { digest: "c115", title: "重试退避改为指数 + 抖动", parent: "release/0.4.2", status: "RELEASED", note: "独立评测通过（δ 达标）；灰度 5% 观察 24h 无异常后发布。" },
        { digest: "c111", title: "上下文拼接携带最近错误摘要", parent: "release/0.4.1", status: "INCONCLUSIVE", note: "样本不足（n=6），不判方向失败；复活条件：补 F-09…F-12 复测。" },
        { digest: "c109", title: "失败后立即换模型重试", parent: "release/0.4.1", status: "REJECTED", note: "成本翻倍而成功率无显著提升；保留记录。" },
        { digest: "c097", title: "灰度期间触发关键回归", parent: "release/0.4.0", status: "ROLLED_BACK", note: "契约失败率越过 ε，指针已回退；证据保留。" }
      ],

      evidence: {
        artifacts: [
          { name: "baseline-traces.tar.zst", digest: "sha256:9c1f…e207", type: "application/zstd", producer: "run_79fd", scope: "开发集" },
          { name: "patch-c118.diff", digest: "sha256:44ab…91c0", type: "text/x-diff", producer: "run_7a31", scope: "候选编辑面" },
          { name: "eval-dev-v1-report.json", digest: "sha256:77d0…3a5b", type: "application/json", producer: "eval_3f9a", scope: "评测证据" }
        ],
        claims: [
          { text: "截断后压缩摘要可将无效重试从 6/12 降至 1/12（开发集）", stance: "条件内支持", scope: "dev-v1 · 未见故障组合", state: "ok" },
          { text: "新包装在大文件写入路径上的行为", stance: "证据不足", scope: "缺少覆盖样例", state: "warn" },
          { text: "候选可读取封存标签", stance: "已被反证", scope: "A10 隔离测试 · 访问被拒绝", state: "bad" }
        ],
        skills: [
          { name: "evidence-driven-debugging", version: "0.3.1", status: "candidate", scope: "project", note: "前提：可复现失败 + 测试运行器" },
          { name: "trace-bisect", version: "0.1.0", status: "candidate", scope: "taskpack", note: "反例：异步副作用重排" }
        ],
        hypotheses: [
          { text: "工具大输出截断是重复调用的主因", stage: "S2", verdict: "条件内支持", scope: "dev-v1 故障组合" },
          { text: "摘要压缩会损失关键诊断信息", stage: "S1", verdict: "条件内否定", scope: "6 组中 5 组保留定位线索" }
        ]
      },

      approvals: [
        { id: "ap_51", kind: "发布审批", title: "将 c115 灰度扩大到 20% 低风险任务", detail: "manifest://rel/9e88 · 父版本 release/0.4.2", scope: "灰度仅低风险任务" }
      ]
    },

    {
      id: "ses_31bd",
      project: "algorithm-search",
      title: "装箱启发式改进（固定预算搜索）",
      state: "paused",
      updatedAt: "1 小时前",
      goalVersion: "goal_demo@5",
      mainAgent: {
        role: "Coordinator", status: "paused",
        objective: "在固定 40 次试验内改进装箱启发式（质量不劣于基线）",
        doing: "已暂停：用户暂停优先于自动续行，当前 attempt 已排空",
        nextStep: "恢复后继续第 19 次试验；搜索集与发布集按种子区间隔离",
        plan: [
          { step: "基线可行性验证（seeds 1-200）", status: "done" },
          { step: "演化搜索：邻域结构变异", status: "run" },
          { step: "配对比较（固定预算 · 交替执行）", status: "todo" }
        ],
        detail: {
          frozen: "graph@3 · looplab-model/default · cpu 120s/trial",
          budgetScope: "执行 ¥6.10 剩余 · 已用 18/40 trials",
          checkpoint: "12:40 第 18 次试验已提交",
          waiting: "PAUSED_USER：只能由获授权命令解除"
        }
      },
      subagents: [
        {
          id: "sa_x1", role: "Experimenter", status: "paused", dur: "已运行 38 分钟",
          task: "演化搜索试验 19/40：邻域交换变体评估",
          progress: "暂停前：小实例 +4.2%，大实例耗时 +11%（条件化优势）",
          steps: [
            { t: "12:38", kind: "info", text: "领取试验 19（种子 19，生成区间 B）" },
            { t: "12:39", kind: "tool", text: "运行候选 heuristic.py — 120s 预算" },
            { t: "12:40", kind: "warn", text: "收到暂停命令：排空并保存检查点" }
          ],
          output: "trials-all.jsonl"
        },
        {
          id: "sa_x2", role: "Reviewer", status: "done", dur: "5 分钟",
          task: "审查第 6 次试验 Worker 失联处置",
          progress: "fencing token 已提升，外部状态核对完成",
          steps: [
            { t: "12:20", kind: "ok", text: "确认迟到结果隔离，未推进任务状态" }
          ],
          output: null
        }
      ],
      work: {
        version: "release/1.1.0",
        doing: "已暂停：等待用户恢复；新任务已停止派发",
        lastProgress: "12:40 第 18/40 次试验：邻域交换在小实例上优于基线 4.2%",
        waitingReason: "PAUSED_USER：用户暂停，只能由获授权命令解除",
        nextStep: "恢复后继续第 19 次试验",
        budgetLeft: "¥6.10 / ¥20.00（未结算 ¥0.00）",
        verified: { done: 18, total: 40, source: "固定试验批次 total_trials_cap=40" }
      },
      tasks: [
        { id: "t_201", name: "基线可行性验证（seeds 1-200）", status: "SUCCEEDED" },
        { id: "t_202", name: "演化搜索：邻域结构变异", status: "PAUSED" },
        { id: "t_203", name: "配对比较（固定预算）", status: "WAITING" }
      ],
      messages: [
        { role: "user", text: "搜索固定 40 次试验，保留全部记录，小规模优势不要当成全局最优。" },
        { role: "agent", who: "Experimenter", text: "第 6 次试验 Worker 失联，已提升 fencing token 并核对状态，迟到结果隔离，未推进任务。" }
      ],
      traces: [
        { id: "run_5511", attempt: 7, status: "COMMITTED", worker: "cpu-sandbox", started: "12:38:02", dur: "2 分钟", cost: "¥0.03", events: 12, cursor: "evt_40be" },
        { id: "run_54f0", attempt: 6, status: "LOST", worker: "cpu-sandbox", started: "12:31:47", dur: "—", cost: "¥0.02", events: 4, cursor: "evt_40a1" }
      ],
      candidates: [
        { digest: "v18", title: "邻域交换 + 首次改进下降", parent: "v17 · v12", status: "CANARY", note: "灰度 8%：小实例 +4.2%，大实例耗时 +11%（条件化优势）。" },
        { digest: "v12", title: "基于体积排序的初始构造", parent: "v9", status: "RELEASED", note: "全规模非劣效，采纳。" },
        { digest: "v9", title: "基线：首次适应递减", parent: "—", status: "RELEASED", note: "可信基线，封存对照。" }
      ],
      evidence: {
        artifacts: [
          { name: "trials-all.jsonl", digest: "sha256:1aa0…77be", type: "application/x-ndjson", producer: "run_5511", scope: "全部 18 次试验" }
        ],
        claims: [
          { text: "邻域交换在小实例（≤120 项）质量优于基线", stance: "条件内支持", scope: "seeds 1-200 · Δ̂=+4.2%", state: "ok" },
          { text: "优势随规模保持", stance: "证据不足", scope: "仅 2 个规模点，未达 S3", state: "warn" }
        ],
        skills: [], hypotheses: []
      },
      approvals: []
    },

    {
      id: "ses_88a0",
      project: "computational-research",
      title: "长程记忆机制的成本优势研究",
      state: "waiting",
      updatedAt: "昨天 18:22",
      goalVersion: "goal_demo@2",
      mainAgent: {
        role: "Coordinator", status: "waiting",
        objective: "验证某记忆机制在长程依赖任务上是否存在成本优势",
        doing: "等待预算：无可执行任务时不进行空转模型调用",
        nextStep: "额度恢复后执行 S1 可观察性实验（合成序列 + 干扰条件）",
        plan: [
          { step: "来源定位与竞争解释", status: "done" },
          { step: "假设卡 H-03 机制核验", status: "done" },
          { step: "S1 可观察性实验", status: "todo" }
        ],
        detail: {
          frozen: "research/0.2.0 · 协议已冻结（主指标 + 分析规则）",
          budgetScope: "本日额度 ¥0.00 · 未结算 ¥0.40 保守预留",
          checkpoint: "昨天 17:55 假设卡 H-03 提交",
          waiting: "WAITING_RESOURCE：等待次日额度或扩大授权"
        }
      },
      subagents: [],
      work: {
        version: "research/0.2.0",
        doing: "等待预算：无可执行任务时不进行空转模型调用",
        lastProgress: "昨天 17:55 假设卡 H-03 完成机制核验（S0 通过）",
        waitingReason: "WAITING_RESOURCE：本日预算已耗尽，等待次日额度或扩大授权",
        nextStep: "额度恢复后执行 S1 可观察性实验",
        budgetLeft: "¥0.00 / ¥30.00（未结算 ¥0.40 保守预留）",
        verified: null
      },
      tasks: [
        { id: "t_301", name: "来源定位与竞争解释", status: "SUCCEEDED" },
        { id: "t_302", name: "假设卡 H-03 机制核验", status: "SUCCEEDED" },
        { id: "t_303", name: "S1 可观察性实验", status: "WAITING_BUDGET" }
      ],
      messages: [
        { role: "agent", who: "Researcher", text: "短序列上记忆机制平均损失较差只能说明当前设置不占优。已登记为 out_of_regime 而非方向失败；复活条件：序列长度 ≥4k 可运行时复试。" }
      ],
      traces: [],
      candidates: [],
      evidence: {
        artifacts: [],
        claims: [
          { text: "记忆机制在短序列（≤512）上不占优", stance: "条件内否定", scope: "S2 · seeds 8", state: "bad" },
          { text: "机制在长程（≥4k）存在成本优势", stance: "证据不足", scope: "已入休眠池", state: "warn" }
        ],
        skills: [],
        hypotheses: [
          { text: "稀疏记忆写入在长程依赖上降低推理成本", stage: "S0", verdict: "机制成立（符号核验）", scope: "理想化条件" },
          { text: "短序列成本劣势随长度反转", stage: "S2", verdict: "条件内否定（≤512）", scope: "复活条件：≥4k" }
        ]
      },
      approvals: [
        { id: "ap_77", kind: "预算审批", title: "申请今日追加 ¥20 研究预算", detail: "S1 实验 ×32 运行 · 预计 ¥11.5", scope: "仅本项目，当日有效" }
      ]
    },

    {
      id: "ses_new",
      project: "harness-improvement",
      title: "新会话",
      state: "draft",
      updatedAt: "刚刚",
      goalVersion: null,
      mainAgent: null,
      subagents: [],
      work: null, tasks: [], traces: [], messages: [], candidates: [],
      evidence: { artifacts: [], claims: [], skills: [], hypotheses: [] },
      approvals: []
    }
  ]
};
