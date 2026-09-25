# RSI 与 Agent 轨迹可视化调研（2026-09-25）

目的：为 looplab 的「自改进过程可视化 + Agent 轨迹显示 + 整体美观度」改造提供论文/开源项目依据与落地设计。
本文是调研结论，不是实现；实现计划见文末第 4 节，进度登记在 HANDOFF.md。

## 1. RSI（递归自我改进）论文图谱

| 线 | 代表工作 | 与 looplab 的关系 |
|---|---|---|
| 形式化始祖 | Gödel Machine (Schmidhuber 2003)；Gödel Agent (Yin et al. 2024) | 自我指涉改写自身代码以优化效用函数——looplab 的 ChangeProposal→Candidate→Evaluation→Release 链路是其受控工程化版本 |
| 开放式进化 | **Darwin Gödel Machine** ([arXiv:2505.22954](https://arxiv.org/abs/2505.22954), [jennyzzt/dgm](https://github.com/jennyzzt/dgm), Sakana AI) | 自我修改 + 达尔文式开放探索；其「性能随自我改进持续提升」曲线正是 RSI 可视化的核心图 |
| AlphaEvolve 系 | AlphaEvolve (DeepMind 2025)；**OpenEvolve** ([openevolve](https://github.com/algorithmicsuperintelligence/openevolve)，已接入为第三后端) | OpenEvolve roadmap 自带 web dashboard（进化追踪），其 MAP-Elites 档案/代际曲线是参考 |
| 反思式提示进化 | **GEPA**（已接入，`gepa==0.1.4`）、OPRO、MetaPrompt、Self-Refine | GEPA 的 reflective mutation + Pareto frontier 可视化 |
| 测试时自改进 | Self-Improving LLM Agents at Test-Time (2510.07841)；Reflect, Retry, Reward (2025)；Experiential Reflective Learning (2603.24639) | 失败轨迹→归因→最小补丁，对应 looplab problem→proposal 链路 |
| 技能/记忆自演化 | SIRI (2606.02335)；MUSE-Autoskill (2605.27366) | 对应 looplab 技能表与记忆 |
| 综述/地图 | [awesome-rsi](https://github.com/lobehub/awesome-rsi)（模型/Agent/harness/具身/AI R&D/基准/安全）；The Path to Recursive Self-Improving Agents (Preprints 2026-08)；Agent Self-Evolution Survey (2023-2025)；The Last AI Built by Humans ([arXiv:2609.11873](https://arxiv.org/html/2609.11873v1))；ICLR 2026 RSI Workshop | 分级框架：looplab 处于「harness 级受控 RSI」（固定内核 + 可演进对象），递归深度限 1 层 |

共识结论：**RSI 系统的可信度依赖可观察性**——每次自我修改必须有不可变谱系、独立评测证据与可回滚指针。looplab 已具备数据层（candidates/evaluations/releases/pointers/optimizer_epochs)，缺的是**呈现层**。

## 2. Agent 轨迹显示：DeepSeek Harness 一手调研

来源：[deepseek.com/harness](https://www.deepseek.com/harness/en/)、[DataCamp 教程](https://www.datacamp.com/tutorial/deepseek-harness)、[LovStudio 借鉴笔记](https://lovstudio.ai/blog/yoda-task-open-silence-fence)、[harness-ds 可观察性博客](https://harness-ds.com/en/blog/trajectory-observability/)、[dsh-trajectory-governance 插件](https://dsh.directory/plugins/dfycaly98931680/dsh-trajectory-governance)。

DSH Trajectory 视图的关键设计：

1. **单一 append-only 事件流是唯一事实源**：系统提示、思维链、每次工具调用（名/参数/返回值）、子 Agent 调度、每次上下文注入全部入流；resume/fork/search/replay 共享同一流。looplab 已有同构物：`/v1/events` SSE + `/v1/attempts/:id/events`。
2. **顶部三轨道窄带**（Input / Model / Tools 各占一行）：谁在动一眼可见，是时间轴的「车道图」而非单线。
3. **按来源过滤**：可只看模型、只看工具、只看子 Agent。
4. **时间线条目**：状态着色标签（ok/fail/stop）、工具名、参数摘要、耗时；行可展开看完整参数与返回。
5. **子 Agent 派发为树**：父→子带上下文，异常（循环死锁/无效重试/目标漂移）可挂在树节点上（governance 插件）。
6. 反模式：只留最终聊天气泡 → "agent went crazy" 无从排查。

对 looplab 的映射：事件类型已足够（`model.call_started/completed`、`tool.call_authorized/denied/completed`、`checkpoint.saved`、`steer.applied`、`attempt.*`、`task.*`)，轨迹视图是**纯前端重构**（把 `<pre>` 原始日志换成结构化三车道时间线），无需改控制内核。

## 3. 训练控制台式实时曲线（RSI 过程可视化）

参考：wandb / TensorBoard scalars、OpenEvolve evolution dashboard、DGM 论文的 performance-over-generations 图、`rich`/`nvitop` 终端仪表盘。

优美的训练控制台共性：

- 主图大而少：1–3 条核心曲线（metric vs step），网格稀疏、坐标轴内敛、曲线平滑带最新值高亮与数值标签；
- 实时追加：新点从右侧进入，视口跟随，可暂停跟随；
- 多指标分栏小图（small multiples)：主指标 / 基线对比 / 预算燃烧（cost)、吞吐（calls);
- 状态行：当前 step、best、近 N 步增量、速率、ETA。

对 looplab 的映射（数据均已存在 API/事件中）:

| 曲线 | 数据源 |
|---|---|
| 候选评测 primary_value vs baseline_value（按时间/候选序） | `evaluation.completed` 事件载荷 + `GET /v1/goals/:id/candidates` |
| 优化器预算燃烧 spent_usd / metric_calls / llm_calls 随时间 | `GET /v1/goals/:id/optimizer/runs`（轮询 + `optimizer.run_*` 事件触发） |
| epoch 切换时间线（active_backend 变更点） | `GET /v1/meta/epoch` + `optimizer.epoch_switched` 事件 |
| 目标级吞吐：attempt 成功/失败、model calls、成本速率 | `GET /v1/metrics`（已有，UI 未用） |

实现取舍：**手绘 SVG 图表组件**（无新依赖，React 19 函数组件，~200 行可实现折线/面积/散点/轴），不引入 chart 库——与项目「锁定依赖、不假设可用库」的纪律一致。

## 4. 落地计划（分片实施，每片可验收）

- **S1 设计系统刷新**:`apps/web/src/styles.css` 全面打磨（更精细的暗色 token、主题切换持久化、字体/间距/圆角/微动效），对齐 kimi-code desktop 的克制暗色美学；保持 e2e 选择器（`.conn`、`.state-chip`、`.graph-mini`、tab 名、按钮文案）稳定。
- **S2 Agent 轨迹视图**：新 `Trajectory.tsx`——三车道活动带（Input/Model/Tools)+ 结构化时间线（角色徽标、工具卡片可展开、耗时、状态色、检查点/steer 标记）+ 来源过滤 + 跟随滚动；替换 attempt 详情里的 `<pre>` 原始日志。
- **S3 RSI 实时曲线**：新 `charts.tsx`(SVG 折线/面积/散点）+ 演进视图重构：评测曲线（primary vs baseline)、优化器运行列表与预算燃烧曲线、epoch 时间线；SSE 驱动实时追加。
- **S4 任务图与富化**:DAG 边渲染（SVG)；接入 `/v1/metrics`、`/v1/settings/model`；空态/断线/等待预算等状态完善。
- **S5 验证**:`npm run build` + vitest 相关套件 + 更新/保持 playwright e2e（必要时同步选择器），截图入 `docs/evidence/`。

边界：不改控制内核权限/预算/发布逻辑；如确需新只读端点（如 per-goal evaluations 列表），走最小增量并补集成测试。
