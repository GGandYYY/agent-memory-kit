# 设计说明

这个包是一个纯通用的 AI Agent 基础库，目标是把“结构化记忆 + relay auto-compaction”做成可复用模块，而不是绑定某个具体业务系统。

## 设计边界

这个库负责：

- memory item / episode / conflict / session state 的数据模型
- turn 后的记忆提炼
- 基于 query 的 memory context 构建
- relay summary compact
- AI SDK prepareStep 集成

这个库不负责：

- 业务 prompt
- 权限控制
- 多租户鉴权
- 队列调度
- 工作流编排
- 埋点和监控平台

## 为什么这样更安全

因为开源包只保留通用机制，不带具体业务流程和产品语义，所以它更像一个基础设施组件，而不是把现有项目的业务系统直接公开出去。

## 面试里怎么描述

可以说：

“我把 AI Agent 的长上下文治理抽象成独立库，核心包括 structured memory、episodic summary、conflict-aware memory update、session rehydration 和 relay auto-compaction，并提供 AI SDK 与 Prisma 的通用适配层。”
