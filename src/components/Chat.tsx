import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";

interface Hit {
  path: string;
  name: string;
  score: number;
  snippet: string;
  size?: number;
  mtime?: number;
}

interface SearchResult {
  hits: Hit[];
  note?: string;
}

// FTS snippets mark matched terms with [ ]; render those highlighted.
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("[") && p.endsWith("]") ? (
          <mark key={i} className="rounded bg-accent-2/25 px-0.5 text-txt">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export default function Chat({
  onShowFile,
}: {
  onShowFile: (path: string, summary?: string | null) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [smartTerms, setSmartTerms] = useState<string[] | null>(null);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  async function smartSearch() {
    const query = q.trim();
    if (!query || busy) return;
    const id = ++seq.current; // invalidate any pending instant search
    setBusy(true);
    setSmartTerms(null);
    setNote(null);
    try {
      const res = await invoke<SearchResult & { expanded?: string[] }>(
        "smart_search",
        { query },
      );
      if (id !== seq.current) return;
      setHits(res.hits ?? []);
      setSmartTerms(res.expanded ?? []);
      setSel(0);
    } catch (e) {
      if (id !== seq.current) return;
      setNote(
        String(e).includes("no_api_key") ? t("chat.smartNoKey") : String(e),
      );
    } finally {
      if (id === seq.current) setBusy(false);
    }
  }

  // keep the keyboard-selected result scrolled into view
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // search-as-you-type: debounced, with stale-response guarding
  useEffect(() => {
    const query = q.trim();
    setSmartTerms(null); // typing returns to plain instant search
    if (!query) {
      setHits([]);
      setNote(null);
      setBusy(false);
      return;
    }
    const id = ++seq.current;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const res = await invoke<SearchResult>("quick_search", { query });
        if (id !== seq.current) return; // a newer keystroke already fired
        setHits(res.hits ?? []);
        setNote(res.note ?? null);
        setSel(0);
      } catch (e) {
        if (id !== seq.current) return;
        setHits([]);
        setNote(String(e));
      } finally {
        if (id === seq.current) setBusy(false);
      }
    }, 160);
    return () => clearTimeout(timer);
  }, [q]);

  const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

  function pick(h: Hit) {
    setActivePath(h.path);
    onShowFile(h.path);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-edge bg-panel p-4">
        <div className="flex items-center gap-2 rounded-2xl border border-edge bg-panel-2 px-3 py-2 focus-within:border-accent/60">
          <span className="text-muted">🔍</span>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, hits.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (hits[sel]) pick(hits[sel]);
              }
            }}
            placeholder={t("chat.placeholder")}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted/60"
          />
          {busy && (
            <span className="thinking-dot h-2 w-2 rounded-full bg-accent-2" />
          )}
          {q.trim() && (
            <button
              onClick={smartSearch}
              disabled={busy}
              className="text-sm transition hover:scale-110 disabled:opacity-40"
              title={t("chat.smart")}
            >
              ✨
            </button>
          )}
          {q && (
            <button
              onClick={() => setQ("")}
              className="text-muted transition hover:text-txt"
              title={t("chat.clear")}
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!q.trim() && (
          <div className="mt-16 text-center">
            <div className="bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-2xl font-bold text-transparent">
              {t("app.tagline")}
            </div>
            <p className="mt-3 text-sm text-muted">{t("chat.empty")}</p>
          </div>
        )}

        {note && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200">
            {note}
          </div>
        )}

        {smartTerms && smartTerms.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1 text-[10px] text-muted">
            <span className="font-semibold text-accent-2">
              ✨ {t("chat.smartTerms")}:
            </span>
            {smartTerms.map((term, i) => (
              <span
                key={i}
                className="rounded-full border border-edge bg-panel-2 px-2 py-0.5"
              >
                {term}
              </span>
            ))}
          </div>
        )}

        {q.trim() && !busy && hits.length === 0 && !note && (
          <div className="mt-8 text-center text-sm text-muted">
            {t("chat.noResults")}
          </div>
        )}

        <div ref={listRef} className="space-y-1.5">
          {hits.map((h, i) => (
            <button
              key={h.path}
              data-idx={i}
              onClick={() => {
                setSel(i);
                pick(h);
              }}
              className={
                "group flex w-full items-start gap-2 rounded-xl border px-3 py-2 text-left transition " +
                (activePath === h.path || sel === i
                  ? "border-accent/60 bg-accent/10"
                  : "border-edge bg-panel-2 hover:border-accent-2/50")
              }
            >
              <span className="mt-0.5 shrink-0 text-accent-2">📄</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-txt">
                  {baseName(h.path)}
                </span>
                {h.snippet && (
                  <span className="mt-0.5 block line-clamp-2 text-[11px] leading-snug text-muted">
                    <Snippet text={h.snippet} />
                  </span>
                )}
                <span className="mt-0.5 block truncate text-[10px] text-accent-2/70">
                  {h.path}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
