
---

## §2 故障类型清单

每类故障定义：目标、注入手段、参数、预期系统行为、观测指标。

| ID | 故障类型 | 目标层 | 注入手段（默认工具） | 关键参数 | 预期行为 | 观测指标 |
|----|----------|--------|----------------------|----------|----------|----------|
| F1 | 网络延迟 (Latency) | 网络 | `tc netem delay` / ChaosBlade `network delay` | 延迟 100ms / 500ms / 2s，抖动 ±20ms | 上游 P99 上升，超时重试触发 | P99 延迟、超时计数 |
| F2 | 丢包 (Packet Loss) | 网络 | `tc netem loss` | 丢包率 1% / 5% / 20% | 重传增加，错误率上升 | 错误率、TCP 重传 |
| F3 | 进程崩溃 (Process Crash) | 进程 | `kill -9` / ChaosBlade `process kill` | 单实例 / 全部实例 | 实例重启，流量切换，短暂 5xx | 可用性、重启次数、5xx |
| F4 | 依赖超时 (Dependency Timeout) | 应用/依赖 | 依赖侧延迟或黑洞 + 客户端超时 | 依赖响应 > 客户端超时阈值 | 熔断/降级触发，快速失败 | 熔断器状态、降级率 |
| F5 | 磁盘满 (Disk Full) | 资源 | `fallocate` 填充 / ChaosBlade `disk fill` | 填充至 95% / 100% | 写失败、日志丢失、可能崩溃 | 磁盘使用率、写错误 |
| F6 | CPU 饱和 (CPU Saturation) | 资源 | `stress-ng --cpu` / ChaosBlade `cpu fullload` | 占用 80% / 100%，持续 60s | 延迟上升，可能超时 | CPU 使用率、P99 延迟 |
| F7 | 内存压力 (Memory Pressure) | 资源 | `stress-ng --vm` | 占用 80% / 95% 内存 | GC/swap 抖动，OOM 风险 | 内存使用率、OOM 计数 |
| F8 | 依赖不可用 (Dependency Down) | 应用/依赖 | 停止依赖容器 / 黑洞端口 | 依赖完全不可达 | 熔断打开，降级或失败 | 可用性、熔断状态 |

**故障严重度分级（用于渐进放大）**：

| 级别 | 网络类 | 资源类 | 进程类 | 说明 |
|------|--------|--------|--------|------|
| L1 轻度 | 延迟 100ms / 丢包 1% | CPU 80% / 内存 80% | 单实例崩溃 | 预期不破 SLO |
| L2 中度 | 延迟 500ms / 丢包 5% | CPU 100% / 内存 95% | 单实例崩溃×2 | 预期接近 SLO 边界 |
| L3 重度 | 延迟 2s / 丢包 20% | 磁盘 100% | 全部实例崩溃 | 预期触发降级/熔断 |

---

## §3 每类故障的注入点（具体主机/容器/接口）

> 容器名与主机为默认假设；执行前须替换为真实标识。所有注入点均位于隔离测试环境。

| 故障 ID | 注入点（容器/主机） | 注入接口/路径 | 命令示例（默认工具） | 前置条件 |
|---------|---------------------|---------------|----------------------|----------|
| F1 | `order-service` 容器出向网卡 `eth0` | 到 `payment-service:8080` 的流量 | `tc qdisc add dev eth0 root netem delay 500ms` | 容器具备 NET_ADMIN |
| F2 | `api-gateway` 容器出向网卡 | 到 `order-service:8080` 的流量 | `tc qdisc add dev eth0 root netem loss 5%` | 同上 |
| F3 | `order-service` 容器进程 | 主进程 PID 1 | `docker kill --signal=SIGKILL <container>` | 有重启策略 |
| F4 | `payment-service` 容器 | 监听端口 `8080`（对外表现为超时） | `tc qdisc ... delay 5s` 或 `iptables -A INPUT -p tcp --dport 8080 -j DROP` | 客户端已配置超时 |
| F5 | `order-service` 容器文件系统 `/var/log` | 挂载卷路径 | `fallocate -l 10G /var/log/fill` | 卷可写、有容量上限 |
| F6 | `payment-service` 容器 CPU | cgroup CPU 配额 | `stress-ng --cpu 4 --timeout 60s` | 容器有 CPU limit |
| F7 | `order-service` 容器内存 | cgroup memory | `stress-ng --vm 2 --vm-bytes 80% --timeout 60s` | 容器有 mem limit |
| F8 | `payment-service` 容器 | 整个服务 | `docker stop payment-service` | 有熔断/降级逻辑 |

**注入点选择原则**：
1. 优先在**调用方出向**注入（更贴近真实网络路径，F1/F2）。
2. 依赖类故障在**被调用方**注入（F4/F8），以验证调用方韧性。
3. 资源类故障在**目标容器 cgroup** 内注入（F5/F6/F7），避免影响宿主。
