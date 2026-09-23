# ADR-0002 Agent 运行时：DeepSeek 直连适配器 + Pi 包核验结论

日期：2026-09-24　状态：已接受

## 背景
设计 §14 指定 AgentRuntimePort（start/events/steer/drain/abort/checkpoint/restore），并要求按当前官方文档核验 Pi（earendil-works/pi，npm @earendil-works 命名空间），先写契约测试再锁定版本。

## 核验结果（2026-09-24，npm registry 实查）
- `earendil-works/pi`（旧包名）存在，v0.0.3，多年未更新。
- `@earendil-works` 命名空间真实存在：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 等，v0.87.x（2026-09 更新）。
- 但其 API 面向交互式 CLI/会话传输（transport/CBOR protocol/TUI），与平台需要的「服务端受控、预算计量、工具网关审批」执行模型差异大；`@earendil-works/pi` 本身 404。

## 决策
1. `AgentRuntimePort` 为平台自有合同（contracts/runtime.ts），不宣称任何 SDK 原生具备。
2. 首个真实适配器 `DeepSeekLoopRuntime`：直接调用 DeepSeek OpenAI 兼容 API，模型调用经控制服务 LLM 网关完成（预算预留→调用→结算→事件），Worker 只持票据不持密钥。
3. Pi 适配（`packages/runtime/src/pi-adapter.ts`）以 `@earendil-works/pi-ai` 的统一 LLM API 作为可插拔 provider 探针（契约测试验证其可安装、可实例化），完整 Pi 会话集成列为后续增强，不阻塞 P1 垂直链路。核验与取舍记录于本文档，避免虚构 API。

## 后果
- 垂直链路 100% 真实（真模型、真工具、真账本），且满足「一个调度权威」。
- Pi 深度集成（session branch 恢复等）标记为延期增强项，验收清单不含伪造的 Pi 验收。
