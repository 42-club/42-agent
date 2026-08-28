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
42 Agent 进程之间的标准协议边界。仓库内置的 Adapter 使用官方 `@agentclientprotocol/sdk`，在
`AgentRuntime` 之上实现稳定版 ACP v1；ACP 特有的生命周期与 Wire 类型不会泄漏到核心执行模型。
一个 Orchestrator 可以同时作为多个独立 Agent 的 ACP Client，对它们进行并发协调。

在本架构中，ACP 是 Client-to-Agent 协议。它不会让多个 Runtime 共享状态，本身也不负责定义
协作策略；Orchestrator 通过组合多个相互独立的 ACP 连接构建多 Agent 系统。

### ACP Adapter

`createAcpAgent` 提供初始化、Session 新建/恢复/删除、Prompt、取消、有序文本与工具更新，以及可选的
客户端权限请求。请求取消与 `session/cancel` 都会传递给 Runtime。更新发送由
`maxPendingUpdates` 和 `updateDeliveryTimeoutMs` 约束顺序、队列和等待时间；客户端停滞时会取消
Prompt，而不会无限堆积更新。Prompt 支持文本和基础 `resource_link`，后者会转换成明确的文本标记。
`name`、`title` 与 `version` 用于配置初始化时返回的 Agent 身份。

必填的 `workspaceRoot` 是宿主 Tool 或 Sandbox 已经强制执行的规范根目录。ACP Session 的 `cwd`
必须解析到同一目录；Adapter 不会动态重配 Tool 根目录。Resume、Prompt 与 Delete 还会要求 Session
中存储的 `acp.cwd` 完全匹配；缺失或外来的 Workspace Metadata 会被拒绝，且不会泄漏已有 Session
是否属于其他 Workspace。Resume 与 Prompt 会拒绝不存在的 Session，Delete 则保持幂等。
`session/cancel` 只影响由当前 Adapter 接纳的 Prompt。要把 Runtime 审批桥接到当前 ACP Client，
构建 `AgentLoop` 与 ACP Adapter 时必须使用同一个 `AcpPermissionBridge`。下例假设 `model`、`tools`
和 `sessionStore` 已按 [`examples/minimal.ts`](./examples/minimal.ts) 完成配置：

```ts
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { AgentLoop, AgentRuntime } from "42-agent";
import { AcpPermissionBridge, createAcpAgent } from "42-agent/acp";

const permissions = new AcpPermissionBridge();
const loop = new AgentLoop({
  model,
  tools,
  sessionStore,
  requestApproval: permissions.requestApproval,
});
const runtime = new AgentRuntime({ loop });
await runtime.start();

const app = createAcpAgent(runtime, {
  workspaceRoot: process.cwd(), // 必须与宿主 Tool/Sandbox 根目录一致。
  permissionBridge: permissions,
});
const connection = app.connect(ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
));
try {
  await connection.closed;
} finally {
  await runtime.close();
}
```

ACP Transport 由嵌入宿主负责；上例使用官方 SDK 的 NDJSON stdio Stream。Adapter 会在每个
`AgentApp` 实例中强制只保留一个活动 ACP Client 连接。
在活动 ACP Prompt 之外，`AcpPermissionBridge` 默认拒绝审批，除非宿主显式提供 fallback 策略。
`ToolRegistry` 会把规范 Turn Signal 绑定到审批调用；即使 Tool 只等待 `requestApproval`，Runtime
关闭也能取消待处理的 ACP 权限请求。
Adapter 会如实声明
`loadSession: false`，目前不实现 Session 回放/加载、`session/close`、额外工作目录、ACP 托管的 MCP
Server 生命周期或图片/音频/嵌入资源 Prompt。非空 `mcpServers` 与 `additionalDirectories`
会被明确拒绝，而不是静默忽略。ACP v1 没有 Message 替换原语；若最终规范结果与已发送 Delta
不一致，Adapter 会用新的 Message ID 发布最终结果。

## 非目标

42 Agent 不负责：

- 分布式调度器或集群成员管理系统
- Runtime 进程之间共享的可变 Session
- 跨 Agent 锁、共识或全局会话历史
- 应用特定的委派、规划或协作策略
- 终端用户认证、租户路由、计费或产品 UI
- 对具有外部副作用的工具提供 exactly-once 执行保证

项目的核心设计规则是：**核心 Runtime 不把 Session 绑定到 Channel**。具体 Adapter 仍可在把事件
解析到 Session ID 前施加入场与所有权策略。HTTP、Web、CLI 和机器人集成都属于 Channel；它们均
不会重建会话历史。ACP Adapter 只操作其配置 Workspace 内、由 ACP 绑定的 Session，因此跨 Channel
续接必须经过显式的受信迁移，不能只凭 Session ID。

```text
Channel A ─┐
Channel B ─┼─► AgentRuntime ─► AgentLoop ─► Model / Tools ─► SessionStore
Channel C ─┘
```

## 当前能力

- 基于官方 SDK 的稳定版 ACP v1 Adapter，提供如实能力协商、有界更新、取消和权限桥接
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

需要 Node.js 22.13 或更高版本，推荐使用 Node.js 24 LTS。

```bash
npm install
npm test
npm run example
```

各项工程检查既可单独运行，也可通过统一的本地门禁执行：

```bash
npm run lint
npm run typecheck
npm run coverage
npm run check
```

`npm run coverage` 会运行测试，并对 `dist/src` 强制要求行/语句覆盖率至少 85%、分支至少 75%、
函数至少 80%。GitHub Actions 会在 Node.js 22.13、24 和 26 上执行 Lint、类型检查、覆盖率门禁及
`npm pack --dry-run`。

Package 入口指向 `dist/src/index.js` 及对应类型声明，并通过 `42-agent/acp` 暴露 ACP Adapter。
项目采用 [Apache-2.0](./LICENSE) 许可证，并已配置为可公开发布到 npm。公开发布使用语义化版本，
且必须由维护者显式执行；`npm pack --dry-run` 只校验发布内容，不会实际发布。

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
Tool 参数在执行前会被隔离，Model Client 只接收冻结的消息与 Tool Definition 快照。

按照 MCP 规范，annotations 只是默认不可信的 Hint。因此，即使 Server 声称
`readOnlyHint: true`，MCP Tool 默认仍需审批并独占执行。宿主只有在信任已配置 Server 时才能显式
设置 `trustToolAnnotations: true`；此时明确标为只读的 Tool 才会跳过审批并默认并行。Wire 端提供的
`executionPolicy` 会被忽略；宿主拥有的顺序覆盖必须通过本地 `executionPolicyFor` 配置：

```ts
const provider = new MCPToolProvider(client, {
  trustToolAnnotations: true, // 仅用于宿主明确信任的 Server。
  executionPolicyFor: ({ name }) => name === "ordered_read" ? "exclusive" : undefined,
});

const tools = await provider.load({ signal });
await provider.refresh({ signal });
await provider.close();
```

带有 `isError: true` 的 MCP 结果会成为类型明确的 `MCPToolCallError`，不会被当作成功结果；JSON-RPC
Error Envelope 会成为 `MCPProtocolError`。`MCPToolProvider.close()` 会先阻止新的执行与刷新，等待
已入场的 `listTools`/`callTool` 请求结束，再关闭 Client，避免因过早断开 Transport 而丢弃已经确认
的副作用结果。只需要单次快照且由调用方管理 Client 生命周期时，可继续使用便捷的
`loadMCPTools`。

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
src/acp/                基于官方 SDK 的 ACP v1 Adapter、权限桥和更新投影器
src/channel/            可复用的 Channel Adapter
src/tools/              本地工具
src/mcp.ts              MCP Tool 策略、结果规范化、刷新与生命周期
src/session*.ts         Session 契约和 Store
examples/               最小示例和 HTTP Runtime 示例
tests/                  Runtime 与集成测试
```

## 后续方向

本仓库只包含可复用 Runtime、协议 Adapter、聚焦的示例，以及一致性或集成测试。产品应用、
部署特定 UI、认证、租户和托管技术栈属于嵌入本 Runtime 的上层生产项目。

只有承担明确 Runtime 开发职责的应用才应进入本仓库，例如未来的 ACP 协议 Inspector。通用聊天
UI 或平台 Starter 不属于 Runtime。

稳定版 ACP v1 Adapter 已建立预期的 Client-to-Agent 边界。后续只有在所有权和恢复策略明确后，
才会考虑增加 Session 回放/加载、更多 Prompt 内容类型或 ACP 托管的 MCP 生命周期。中断运行的
检查点续接仍是 Runtime 层面的里程碑。
