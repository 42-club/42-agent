import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { streamRuntimeTurn } from "../http-client.js";

const args = parseArgs(process.argv.slice(2));
const runtimeUrl = args.url ?? process.env.AGENT_RUNTIME_URL ?? "http://127.0.0.1:8787";
const sessionId = args.session ?? `cli:${process.env.USER ?? "local"}`;
const terminal = createInterface({ input: stdin, output: stdout });

console.log(`Agent CLI · session ${sessionId}`);
console.log("输入 /exit 退出。\n");

while (true) {
  const input = (await terminal.question("> ")).trim();
  if (!input) continue;
  if (input === "/exit") break;
  let streamed = false;
  try {
    for await (const item of streamRuntimeTurn(runtimeUrl, { sessionId, userInput: input })) {
      if (item.type === "event" && item.event.type === "text_delta") {
        stdout.write(item.event.delta);
        streamed = true;
      } else if (item.type === "result") {
        if (!streamed) stdout.write(item.content);
        stdout.write("\n\n");
      } else if (item.type === "error") {
        console.error(`错误 [${item.code}]：${item.message}`);
      }
    }
  } catch (error) {
    console.error(`连接失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
terminal.close();

function parseArgs(values: string[]): { url?: string; session?: string } {
  const result: { url?: string; session?: string } = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--url") result.url = values[++index];
    else if (values[index] === "--session") result.session = values[++index];
  }
  return result;
}
