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
- 协作式取消正在执行的工作、等待全部已启动工具结束，并在中断后采取保守恢复策略

Runtime 被有意设计为单进程构建单元。生产应用可以同时启动多个 42 Agent 进程并行运行。这些
Agent 相互独立：它们不共享进程内队列、不通过共同的 `SessionStore` 协调，也不需要分布式锁。
每个进程必须使用独立 Store；多个 Runtime 共享同一个 File 或 SQLite Store 不属于支持的进程模型。

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
边界，但不能替代 ACP 实现。ACP 应位于 `AgentRuntime` 之上的 Adapter 层；协议特有的生命周期和
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
Channel B ─┼─► AgentRuntime ─► AgentLoop ─► Model / Tools ─► SessionStore
Channel C ─┘
```

## 当前能力

- 协议无关的 `AgentRuntime` 生命周期，覆盖 Session、Prompt、取消、Steering 和能力查询
- `AgentRuntime` 从 `AgentLoop` 派生并校验唯一的 `SessionStore`、`ToolRegistry` 与 Skill Loader
- Runtime、Session 和 Turn 级 Tool/Skill 选择，Prompt 不直接注入能力实现
- 只读工具仅接收与 Runtime 隔离的深度不可变 Session 快照
- 显式可并行 Tool 有界并发；需要副作用顺序或受信任写权限的 Tool 独占执行
- 与 Model、Tool 参数、Event 和 Runtime DTO 隔离的服务端规范状态
- 深拷贝、冻结且不阻塞核心状态机的 best-effort 进度事件
- 模型事件流式传输，以及向 Provider 和 MCP 工具传播的协作式取消
- 本地及 MCP 兼容工具
- 在模型/工具边界应用 Steering
- 在模型和工具边界保存持久化检查点
- 保守的崩溃恢复：绝不自动重放结果不确定的副作用
- 仅更新已有 Session、带版本检查的内存、文件和 SQLite SessionStore
- 同一 Session 的 Turn 与恢复共用 FIFO，不同 Session 并发执行
- 仅接受格式完好的 Unicode Session ID，File Store 使用固定长度摘要路径并核对文件内规范 ID

## 架构

`AgentRuntime` 是唯一面向协议的生命周期 Facade。它从 `AgentLoop` 派生 Store、Tool Registry 和
Skill Loader，避免校验、执行、关闭与恢复连接到不同的事实来源。`AgentLoop` 持有 per-session FIFO 协调器，
`SessionStore` 是持久化边界。Channel 负责规范化输入并投影 best-effort 事件；Provider 负责统一
模型 API；Tool 负责执行能力。边界定义与恢复语义详见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 快速开始

需要 Node.js 22.13 或更高版本。使用内置 SQLite Store 时推荐 Node.js 25。

```bash
npm install
npm test
npm run example
```

私有包入口已指向 `dist/src/index.js` 及对应类型声明，可通过 workspace 或 tarball 方式嵌入，
并可使用 `npm pack --dry-run` 做本地消费检查。公开发布到 registry 仍需由项目所有者明确决定
版本与许可证。

运行由 OpenRouter 提供模型能力的 HTTP Runtime：

```bash
export OPENROUTER_API_KEY=...
npm run runtime
```

HTTP Server 是可信开发环境下的 Adapter，不是生产入口：它不提供认证，默认只监听 loopback，
浏览器 Origin 必须与显式 `allowedOrigin` 精确匹配，请求必须为 JSON，请求体与待发送 Event 都有
大小上限，也不会注册可选的 Bash 工具。认证、Host/DNS-rebinding 防护、租户、限流和部署策略
属于嵌入 Runtime 的上层应用。

随后使用显式 Session ID 启动 CLI：

```bash
npm run cli -- --session shared-session
```

其他 Channel 只要解析到 `shared-session`，即可继续同一个规范化服务端 Session。

## Runtime 保证

- 在一个 Runtime 进程内，同一 Session 的 Turn 按 FIFO 顺序执行；不同 Session 可以并发执行。
- 显式恢复使用同一 per-session FIFO，不会与活动 Turn 竞态执行。
- 在进入 FIFO 执行槽位前已取消的请求不会创建 Run，也不会追加 User Message。
- Steering 与取消在 Turn 终态屏障处关闭入场；控制消息不会泄漏到下一个 Turn。
- 不同 Runtime 进程相互独立，可以并发执行而不共享 Session 状态。
- 取消会停止派发新工具，并在所有已启动工具结束前保持 Turn 未完成。
- 重复或重入的 Runtime/Session Close 会等待同一个关闭操作；关闭会阻止新工作，等待已入场的
  读取、恢复、Turn 与 Tool 完成，然后按请求删除 Session 状态。
- 已完成的工具结果会在下一个模型步骤开始前持久化。
- 恢复时会把所有已持久化的完成/失败工具结果补成模型可见的 Tool Message。
- 崩溃时仍处于 `running` 状态的工具，其结果会被视为未知，不会自动重放。
- Store 的 `save` 只更新已存在的版本；晚到保存不能重新创建已删除 Session。默认只允许追加
  Message；修改已有 Message 必须显式使用 `rewriteMessages`。
- Event Observer 只收到深拷贝冻结值；异常、篡改尝试和永不完成的回调都不会改变或卡住规范状态。
  Adapter 自己负责事件顺序与背压。
- Runtime 不保证具有外部副作用的操作 exactly-once 执行。

## 工具信任与取消

Session 只读 Tool 接收与 Runtime 隔离、深度冻结的 Session 快照。声明 `sessionAccess: "write"` 的 Tool
属于受信任的 Runtime 扩展：它可以访问 live Session，并相对于同批其他工具以独占屏障执行。
Tool 结果必须能够 JSON 序列化；非法结果会成为模型可见的 Tool Failure，而不会破坏持久化状态。
其检查点会重写完整消息历史，保证已有消息的修改在不同 Store 中具有一致的持久化语义。

`sessionAccess` 不代表工具没有外部副作用。需要保证外部执行顺序的 Tool 应声明
`executionPolicy: "exclusive"`；只有允许重叠和乱序的 Tool 才使用默认并行策略。Bash 为独占执行，
MCP Tool 默认独占，除非显式声明可并行。Tool 参数在执行前会被隔离，Model Client 只接收冻结的
消息与 Tool Definition 快照。

取消采用协作式语义。Provider、MCP Client 和 Tool 都会收到 `AbortSignal`，Runtime 会等待已启动
工作结束；需要及时关闭时，实现必须主动响应该信号。可选 `BashTool` 的每个命令都需要显式批准，
默认限制 `cwd` 并限制输出大小，但它不是 Sandbox；生产宿主应优先使用操作系统/容器隔离或严格
命令白名单。

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
