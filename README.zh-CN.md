# 42 Agent

[English](./README.md)

42 Agent 是一个小型、可嵌入的 TypeScript Runtime，用于构建具备持久化能力和工具调用能力的
AI Agent。它的定位是生产应用下层的执行底座，而不是应用层的 Agent 编排器。

## 项目职责

一个 42 Agent Runtime 进程承载一个独立 Agent，并负责分配给该进程的 Session 执行及持久化状态：

- 运行模型与工具循环，并对外提供结构化的进度事件
- 持久化规范化消息、运行状态和工具调用检查点
- 保证同一 Session 内的 Turn 按 FIFO 顺序执行，同时允许不同 Session 并发运行
- 通过稳定的内部接口统一模型 Provider、工具、Skill 和前端 Channel
- 取消正在执行的工作，并在运行中断后采取保守的恢复策略

Runtime 被有意设计为单进程构建单元。生产应用可以同时启动多个 42 Agent 进程并行运行。这些
Agent 相互独立：它们不共享进程内队列、不通过共同的 `SessionStore` 协调，也不需要分布式锁。

Runtime 上层的应用负责 Agent 发现、任务拆解、调度、结果路由、协作策略、身份、租户和部署。
如果 Agent A 的输出需要成为 Agent B 的输入，这层关系应由应用层 Orchestrator 建立，而不是
隐藏在任一 Agent Runtime 内部。

```text
生产应用 / Orchestrator
          │
          ├── ACP Client ──► 42 Agent 进程 A ──► SessionStore A
          ├── ACP Client ──► 42 Agent 进程 B ──► SessionStore B
          └── ACP Client ──► 42 Agent 进程 C ──► SessionStore C
```

## 协议方向

[Agent Client Protocol（ACP）](https://agentclientprotocol.com/) 是应用层 Orchestrator 与每个
42 Agent 进程之间计划采用的标准协议边界。ACP 应提供 Session 生命周期、Prompt、结构化更新、
取消、能力协商和权限请求。一个 Orchestrator 可以同时作为多个 Agent 的 ACP Client，对它们进行
并发协调。

支持 ACP 是设计目标，并非当前已经具备的能力。当前 HTTP 和 CLI Channel 用于演示 Runtime
边界，但不能替代 ACP 实现。ACP 应位于 `AgentLoop` 之上的 Adapter 层；协议特有的生命周期和
消息类型不得泄漏到核心执行模型中。

在本架构中，ACP 是 Client-to-Agent 协议。它不会让多个 Runtime 共享状态，本身也不负责定义
协作策略；Orchestrator 通过组合多个相互独立的 ACP 连接构建多 Agent 系统。

## 非目标

42 Agent 不负责：

- 分布式调度器或集群成员管理系统
- Runtime 进程之间共享的可变 Session
- 跨 Agent 锁、共识或全局会话历史
- 应用特定的委派、规划或协作策略
- 终端用户认证、租户路由、计费或产品 UI
- 对具有外部副作用的工具提供 exactly-once 执行保证

项目的核心设计规则是：**Session 独立于 Channel**。任何 Channel 都可以把入站事件解析到同一个
Session ID，从而加入并继续该 Session。HTTP、Web、CLI 和机器人集成都属于 Channel；它们均不
拥有或重建会话历史。

```text
Channel A ─┐
Channel B ─┼─► AgentLoop ─► Model / Tools ─► SessionStore
Channel C ─┘
```

## 当前能力

- 协议无关的 `AgentRuntime` 生命周期，覆盖 Session、Prompt、取消、Steering 和能力查询
- Runtime、Session 和 Turn 级 Tool/Skill 选择，Prompt 不直接注入能力实现
- 服务端规范化消息与运行状态
- 模型事件流式传输与取消
- 本地及 MCP 兼容工具
- 在模型/工具边界应用 Steering
- 在模型和工具边界保存持久化检查点
- 保守的崩溃恢复：绝不自动重放结果不确定的副作用
- 内存、文件和 SQLite SessionStore
- 同一 Session 内 FIFO 执行，不同 Session 并发执行

## 架构

`AgentLoop` 是编排器，`SessionStore` 是持久化边界。Channel 负责规范化传输层输入并转发事件；
Provider 负责规范化模型 API；Tool 负责执行能力。边界定义与恢复语义详见
[ARCHITECTURE.md](./ARCHITECTURE.md)。

## 快速开始

需要 Node.js 22.13 或更高版本。使用内置 SQLite Store 时推荐 Node.js 25。

```bash
npm install
npm test
npm run example
```

运行由 OpenRouter 提供模型能力的 HTTP Runtime：

```bash
export OPENROUTER_API_KEY=...
npm run runtime
```

随后使用显式 Session ID 启动 CLI：

```bash
npm run cli -- --session shared-session
```

其他 Channel 只要解析到 `shared-session`，即可继续同一个规范化服务端 Session。

## Runtime 保证

- 在一个 Runtime 进程内，同一 Session 的 Turn 按 FIFO 顺序执行；不同 Session 可以并发执行。
- 不同 Runtime 进程相互独立，可以并发执行而不共享 Session 状态。
- 已完成的工具结果会在下一个模型步骤开始前持久化。
- 崩溃时仍处于 `running` 状态的工具，其结果会被视为未知，不会自动重放。
- Runtime 不保证具有外部副作用的操作 exactly-once 执行。

## 仓库结构

```text
src/agent-runtime.ts    协议无关的生命周期与能力 Facade
src/agent-loop.ts       编排与 Session 串行化
src/runtime/            模型执行、重试、事件、Steering 和工具
src/provider/           Provider Adapter
src/channel/            可复用的 Channel Adapter
src/tools/              本地工具
src/session*.ts         Session 契约和 Store
examples/               最小示例和 HTTP Runtime 示例
tests/                  Runtime 与集成测试
```

## 后续方向

本仓库只包含可复用 Runtime、协议 Adapter、聚焦的示例，以及一致性或集成测试。产品应用、
部署特定 UI、认证、租户和托管技术栈属于嵌入本 Runtime 的上层生产项目。

只有承担明确 Runtime 开发职责的应用才应进入本仓库，例如未来的 ACP 协议 Inspector。通用聊天
UI 或平台 Starter 不属于 Runtime。

下一个主要协议里程碑是 ACP Adapter，包括显式 Session 生命周期、结构化更新、取消、能力协商
和权限桥接。中断运行的检查点续接仍是 Runtime 层面的里程碑。
