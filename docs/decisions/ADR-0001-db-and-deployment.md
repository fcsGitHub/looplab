# ADR-0001 数据库与部署形态：单机 PostgreSQL(Docker) + Node 控制服务

日期：2026-09-24　状态：已接受

## 背景
设计报告 §03/§18.1 推荐「TypeScript 控制服务 + PostgreSQL + React 网页 + Pi 运行时适配 + 隔离 Worker」。本机为 Windows 11，已装 Node 24 / Python 3.11 / Docker 29。需决定数据库与部署形态。

## 决策
1. PostgreSQL 16 以 Docker 容器（looplab-pg，端口 5433）运行——满足设计首选，保留 `SKIP LOCKED`、事务性 outbox、CAS 等内核机制的真实语义。
2. 控制服务为 Node + Fastify + `pg`；不做 ORM，迁移用纯 SQL 文件按序执行。
3. Worker 为独立 Node 进程（agent 循环）+ Python 子进程（TaskPack 实验），通过 HTTP 与控制服务交互，不直连数据库。
4. 对象存储首版用本地内容寻址目录 `data/objects/`（接口为 `ObjectStore`，预留远端实现）。

## 后果
- 单机部署即可复现全部验收；换 Temporal 或远程对象存储仅替换调度/存储端口实现。
- Docker 守护进程不可用时平台无法启动数据库：runbook 提供启动命令；启动脚本检测并给出明确错误。
