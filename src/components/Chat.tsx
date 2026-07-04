import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import type { ChatMessage, ShownFile } from "../types";

interface ChatResult {
  text: string;
  shown: ShownFile[];
}

export default function Chat({
  onShowFile,
}: {
  onShowFile: (path: string, summary?: string | null) => void;
}) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const un = listen<{ tool: string }>("agent-activity", (e) => {
      setActivity(e.payload.tool);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setError(null);
    setInput("");
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setBusy(true);
    setActivity(null);
    try {
      const res = await invoke<ChatResult>("chat", { messages: next });
      setMessages([...next, { role: "assistant", content: res.text }]);
      const last = res.shown.filter((s) => s.exists).pop();
      if (last) onShowFile(last.path, last.summary);
    } catch (e) {
      const msg = String(e);
      setError(msg === "no_api_key" ? t("chat.noKey") : `${t("chat.error")}: ${msg}`);
      setMessages(next);
    } finally {
      setBusy(false);
      setActivity(null);
    }
  }

  const activityLabel: Record<string, string> = {
    graph_vocab: "graph vocab",
    graph_query: "graph query",
    fs_probe: "disk scan",
    show_file: "preview",
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {messages.length === 0 && (
          <div className="mt-16 text-center">
            <div className="bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-2xl font-bold text-transparent">
              {t("app.tagline")}
            </div>
            <p className="mt-3 text-sm text-muted">{t("chat.empty")}</p>
            <p className="mt-1 text-xs text-muted/70">{t("chat.examples")}</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex"}>
            <div
              className={
                "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed " +
                (m.role === "user"
                  ? "bg-gradient-to-r from-accent/90 to-accent/70 text-white"
                  : "border border-edge bg-panel-2")
              }
            >
              {m.role === "assistant" ? (
                <div className="prose-invert prose-sm [&_code]:rounded [&_code]:bg-ink/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-accent-2 [&_p]:my-1">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>
              ) : (
                m.content
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <span className="flex gap-1">
              <span className="thinking-dot h-2 w-2 rounded-full bg-accent" />
              <span className="thinking-dot h-2 w-2 rounded-full bg-accent" />
              <span className="thinking-dot h-2 w-2 rounded-full bg-accent" />
            </span>
            {t("chat.thinking")}
            {activity && (
              <span className="rounded-full border border-edge bg-panel-2 px-2 py-0.5 text-xs">
                {activityLabel[activity] ?? activity}
              </span>
            )}
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
            {error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-edge bg-panel p-4">
        <div className="flex items-end gap-2 rounded-2xl border border-edge bg-panel-2 p-2 focus-within:border-accent/60">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={t("chat.placeholder")}
            className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted/60"
          />
          <button
            onClick={send}
            disabled={busy || !input.trim()}
            className="rounded-xl bg-gradient-to-r from-accent to-accent-2 px-4 py-2 text-sm font-semibold text-ink transition disabled:opacity-40"
          >
            {t("chat.send")}
          </button>
        </div>
      </div>
    </div>
  );
}
