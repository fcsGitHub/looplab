# 运维手册（Runbook）

## 1. 启动 / 停止

```powershell
# 数据库（如未运行）
docker start looplab-pg   # 或 docker run … 见 README

# 控制服务（前端构建产物由其托管）
npx tsx apps/control/src/index.ts          # 监听 :8080

# worker（可多实例，命名区分）
# 默认运行时为 Pi（@earendil-works）；RUNTIME=loop 显式回退到内置循环
$env:WORKER_ID="dev-01"; npx tsx workers/agent-worker/src/index.ts
$env:RUNTIME="loop"; npx tsx workers/agent-worker/src/index.ts   # 回退

# 优化器后端 venv（元演进 epoch 试炼所需，一次性）
python -m venv .venv-gepa; .venv-gepa/Scripts/pip install gepa==0.1.4
# 试炼（真实反射调用经计量代理计账）：
#   npx tsx scripts/demo-optimizer-epoch.ts
# 配置 OPTIMIZER_PYTHON 可覆盖解释器路径（默认 <repo>/.venv-gepa/Scripts/python.exe）

# 停止：Ctrl+C（SIGTERM 同样优雅退出）；worker 直接终止是安全的——
# 租约过期后由 supervisor 对账（LOST → 重排 / RECONCILE_REQUIRED）
```

首次使用：浏览器打开 http://localhost:8080 → 注册（首个用户自动为 admin）→
选择项目 → 新建会话 → 发送目标。

## 2. 配置

| 配置 | 位置 | 说明 |
|---|---|---|
| DEEPSEEK_API_KEY | `apps/control/config/.env.local`（gitignored） | 密钥只存在于控制服务进程 |
| DATABASE_URL | 同上（默认 `postgres://looplab:localdev@localhost:5433/looplab`） | |
| PORT / LEASE_TTL_MS / WORKER_HEARTBEAT_MS | 同上 | 租约与心跳 |
| DEFAULT_GOAL_BUDGET_USD | 同上 | 每目标默认预算上限（USD） |
| DATA_DIR / SEALED_DIR | 同上 | 对象库与封存套件目录 |

前端模型设置页（/v1/settings/model）只显示 provider/model/密钥指纹，绝不返回密钥。

## 3. 日常运维

- **升级 TaskPack 评测器**：修改 `taskpacks/<id>/` 后执行 `npx tsx scripts/seal-suites.ts`
  （会刷新 data/taskpacks 与 sealed 的运行副本）。
- **调度优先级**（A22）：goal 的 priority 1（最急）..9（最不急），默认 5；
  claim 按 (priority, created_at) 排序——紧急目标抢占更早的积压，同级 FIFO。
  改级：`POST /v1/goals/{id}/commands {"kind":"set_priority","payload":{"priority":1}}`
  （任意状态可用、幂等、记 goal.priority_changed 事件）；会话首消息可带
  `"priority": n` 直接建到对应层级。
- **观察**：`GET /v1/metrics`（目标/attempt 状态分布、事件水位、模型用量与成本、
  supervisor 最近对账时间与 LOST/RECONCILE 计数、最后错误）。
- **日志**：控制服务 stderr（含被拒请求）；事件账本 `events` 表为唯一事实。

## 4. 故障处置

| 症状 | 处置 |
|---|---|
| worker 无响应 | 无需操作：租约过期后 attempt → LOST，任务自动重排（≤3 次）；RESULT_PENDING 例外 → RECONCILE_REQUIRED，需人工/诊断任务介入 |
| 目标停在 WAITING_RESOURCE | 预算恢复后自动 ACTIVE；或 `POST /v1/goals/{id}/commands {"kind":"resume"}` |
| 用户暂停被卡住 | 仅 `resume` 命令可解除；重启不会复活（A07） |
| 模型调用报 402 | 该目标预算耗尽；提高 `goals.budget_cap_usd` 或等待未知结算落定 |
| 候选评测 REJECTED: sandbox violation | 试图越出沙箱（读 sealed/网络/子进程）；候选已隔离，详见事件与 candidate_status_history |
| 事件流断连 | SSE 自动按游标续传；UI 按 event_id 去重，不会重复插入 |

## 5. 部署 worker 修复的固定步骤

1. `npx tsx tests/manual/gw-hardening.ts` 必须输出三行断言全部符合
   （相对写 OK / 绝对读阻断 / socket 阻断）。
2. 重启所有 worker 进程（旧进程不会热更新，事故 003 的教训）。
3. 观察下一个 attempt 的 tool_results 无 `LOOPLAB_SANDBOX` 误报。

## 6. 已知边界

- 单机部署：worker 与控制服务同 OS 用户；语言级沙箱 ≠ 内核级沙箱。
- 72h soak（A17）需要 `npx tsx tests/soak/soak.ts --duration 72h` 且有外部
  断言检查；当前证据仅含短时运行（见 docs/evidence/soak 报告的 run_kind）。

## 7. 本机自愈栈（P25，宿主可靠性）

本开发机曾两度在无人值守时整栈坍塌（Docker Desktop/WSL 自行停止 → 控制服务失去
Postgres；后台进程被会话回收）。现行四层自愈：

1. **进程内**（代码）：pg 池 `error` 处理器（V28，PG 维护杀连接不再崩进程）；
   worker 对控制服务瞬断自动重试；租约/SSE 重连既有机制。
2. **子进程**：`scripts/dev-stack.mjs` 以封顶退避重启 control/worker 子进程。
3. **容器**：`looplab-pg` 已设 `restart=unless-stopped`（Docker 守护进程恢复即自启）。
4. **守护者**：supervisor 本身若死，计划任务每 3 分钟重拉（实例互斥端口 47613，
   存活时新实例立即退出）；Docker 守护进程不在时自动启动 Docker Desktop。

运维命令：

```
npm run dev:stack                        # 手动前台运行（观察日志用）
tail -f data/stack-supervisor.log        # 栈日志（含子进程输出）
schtasks /Create /TN LoopLabStack /TR "D:\project\looplab\scripts\stack-task.cmd" /SC MINUTE /MO 3 /F   # 注册（用户级免提权）
schtasks /Run   /TN LoopLabStack         # 立即触发一次
schtasks /Delete /TN LoopLabStack /F     # 移除守护
```

验证记录（2026-09-27）：树杀 control 子进程 → supervisor 2 秒内自动重启并重新监听；
故障注入与恢复全程 worker 仅瞬时 claim 失败后自愈。
