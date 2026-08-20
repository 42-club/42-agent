"use client";

import { FormEvent, useMemo, useRef, useState } from "react";

type ChatMessage = { role: "user" | "assistant"; content: string };

export default function Home() {
  const [runtimeUrl, setRuntimeUrl] = useState("http://127.0.0.1:8787");
  const [sessionId, setSessionId] = useState("shared-demo");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Ready");
  const abortRef = useRef<AbortController | null>(null);
  const canSend = useMemo(() => input.trim() && sessionId.trim() && !running, [input, sessionId, running]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || running) return;
    setInput("");
    setRunning(true);
    setStatus("Thinking");
    setMessages((current) => [...current, { role: "user", content: text }, { role: "assistant", content: "" }]);
    const controller = new AbortController();
    abortRef.current = controller;
    let streamed = "";
    try {
      const response = await fetch(`${runtimeUrl.replace(/\/$/, "")}/v1/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, userInput: text }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Runtime returned ${response.status}`);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += value ?? "";
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const item = JSON.parse(line);
          if (item.type === "event" && item.event?.type === "text_delta") {
            streamed += item.event.delta;
            updateLastAssistant(streamed);
          } else if (item.type === "result" && !streamed) {
            streamed = item.content;
            updateLastAssistant(streamed);
          } else if (item.type === "error") throw new Error(item.message);
        }
        if (done) break;
      }
      setStatus("Ready");
    } catch (error) {
      const message = controller.signal.aborted ? "Cancelled" : error instanceof Error ? error.message : String(error);
      updateLastAssistant(`Unable to complete: ${message}`);
      setStatus(controller.signal.aborted ? "Cancelled" : "Disconnected");
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function updateLastAssistant(content: string) {
    setMessages((current) => {
      const next = [...current];
      next[next.length - 1] = { role: "assistant", content };
      return next;
    });
  }

  return (
    <main className="shell">
      <aside className="rail">
        <div className="brand"><span className="mark">A</span><span>Agent Loop</span></div>
        <div className="rail-section">
          <label htmlFor="session">Session</label>
          <input id="session" value={sessionId} onChange={(event) => setSessionId(event.target.value)} />
          <p>Any channel using this ID continues the same canonical session.</p>
        </div>
        <div className="rail-section">
          <label htmlFor="runtime">Runtime</label>
          <input id="runtime" value={runtimeUrl} onChange={(event) => setRuntimeUrl(event.target.value)} />
        </div>
        <div className="source-note">
          <span className="pulse" />
          <div><strong>{status}</strong><small>Agent Loop owns session state</small></div>
        </div>
      </aside>

      <section className="workspace">
        <header>
          <div><p className="eyebrow">Shared runtime</p><h1>One conversation, any channel.</h1></div>
          {running && <button className="stop" onClick={() => abortRef.current?.abort()}>Stop</button>}
        </header>

        <div className="conversation" aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty">
              <span className="empty-mark">↗</span>
              <h2>Start in one channel.<br />Continue in another.</h2>
              <p>Channels resolve events to a shared Session ID. Conversation history remains canonical in the Agent Runtime.</p>
            </div>
          ) : messages.map((message, index) => (
            <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
              <span>{message.role === "user" ? "You" : "Agent"}</span>
              <p>{message.content || "…"}</p>
            </article>
          ))}
        </div>

        <form className="composer" onSubmit={submit}>
          <textarea aria-label="Message" placeholder="Ask the agent…" rows={2} value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }} />
          <button disabled={!canSend} aria-label="Send message">↑</button>
        </form>
      </section>
    </main>
  );
}
