export const BASE_SYSTEM_PROMPT =
  "当会话消息达到 100 条时，调用 compress_conversation 工具压缩会话。";

export function buildSystemPrompt(injections: readonly string[] = []): string {
  return [BASE_SYSTEM_PROMPT, ...injections.map((value) => value.trim()).filter(Boolean)].join(
    "\n\n",
  );
}
