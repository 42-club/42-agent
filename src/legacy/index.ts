/**
 * Compatibility APIs that bypass AgentLoop's mutation coordinator.
 *
 * New integrations must use AgentLoop. This entry point may be removed in the
 * next major release and is intentionally excluded from the package root.
 */
export { ToolExecutor } from "../runtime/tool-executor.js";
export { EventDispatcher } from "../runtime/events.js";
