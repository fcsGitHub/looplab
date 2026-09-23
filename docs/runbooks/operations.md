# 运维手册（Runbook）

## 1. 启动 / 停止

```powershell
# 数据库（如未运行）
docker start looplab-pg   # 或 docker run … 见 README

# 控制服务（前端构建产物由其托管）
npx tsx apps/control/src/index.ts          # 监听 :8080

# worker（可多实例，命名区分）
$env:WORKER_ID="dev-01"; npx tsx workers/agent-worker/src/index.ts

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
