export const BASE_SYSTEM_PROMPT = "";

export function buildSystemPrompt(injections: readonly string[] = []): string {
  return [BASE_SYSTEM_PROMPT, ...injections]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n\n");
}
