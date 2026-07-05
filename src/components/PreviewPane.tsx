import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { DocBlock, Preview } from "../types";

interface AiSummary {
  tldr: string;
  points: string[];
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

// Tailwind classes per heading depth; level 0 is a body paragraph.
const HEADING_CLASS: Record<number, string> = {
  1: "mt-4 mb-1 text-base font-bold text-txt",
  2: "mt-3 mb-1 text-sm font-semibold text-txt",
  3: "mt-3 mb-0.5 text-sm font-semibold text-txt/90",
  4: "mt-2 text-xs font-semibold uppercase tracking-wide text-muted",
  5: "mt-2 text-xs font-semibold uppercase tracking-wide text-muted",
  6: "mt-2 text-xs font-semibold uppercase tracking-wide text-muted",
};

function DocView({ blocks }: { blocks: DocBlock[] }) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [showOutline, setShowOutline] = useState(true);

  // outline = headings down to level 3, with their block index as anchor
  const outline = useMemo(
    () =>
      blocks
        .map((b, i) => ({ ...b, i }))
        .filter((b) => b.level >= 1 && b.level <= 3 && b.text.trim()),
    [blocks],
  );

  function scrollTo(i: number) {
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-b="${i}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="flex h-full min-h-0">
      {outline.length > 0 && showOutline && (
        <aside className="w-48 shrink-0 overflow-auto border-r border-edge bg-panel/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-widest text-accent-2">
              {t("preview.outline")}
            </span>
            <button
              onClick={() => setShowOutline(false)}
              className="text-muted hover:text-txt"
              title={t("preview.hideOutline")}
            >
              ×
            </button>
          </div>
          <nav className="space-y-0.5">
            {outline.map((h) => (
              <button
                key={h.i}
                onClick={() => scrollTo(h.i)}
                className="block w-full truncate text-left text-xs text-muted transition hover:text-txt"
                style={{ paddingLeft: `${(h.level - 1) * 10}px` }}
                title={h.text}
              >
                {h.text}
              </button>
            ))}
          </nav>
        </aside>
      )}

      <div ref={bodyRef} className="min-w-0 flex-1 overflow-auto px-5 py-4">
        {outline.length > 0 && !showOutline && (
          <button
            onClick={() => setShowOutline(true)}
            className="mb-2 rounded-md border border-edge bg-panel-2 px-2 py-1 text-[11px] text-muted hover:text-txt"
          >
            {t("preview.showOutline")}
          </button>
        )}
        {blocks.map((b, i) =>
          b.level >= 1 ? (
            <div key={i} data-b={i} className={HEADING_CLASS[b.level] ?? HEADING_CLASS[3]}>
              {b.text}
            </div>
          ) : (
            <p
              key={i}
              data-b={i}
              className="whitespace-pre-wrap break-words text-xs leading-relaxed text-txt/80"
            >
              {b.text}
            </p>
          ),
        )}
      </div>
    </div>
  );
}

export default function PreviewPane({ preview }: { preview: Preview | null }) {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [ai, setAi] = useState<AiSummary | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNoKey, setAiNoKey] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  // Generate an AI summary whenever a summarizable document is shown, or when
  // the UI language changes (so the summary follows the EN/ES toggle).
  const path = preview?.path;
  const kind = preview?.kind;
  const lang = i18n.language?.startsWith("es") ? "es" : "en";
  useEffect(() => {
    setAi(null);
    setAiNoKey(false);
    setAnswer(null);
    setQuestion("");
    if (!path || kind === "image" || kind === "other") {
      setAiBusy(false);
      return;
    }
    let cancelled = false;
    setAiBusy(true);
    invoke<AiSummary>("summarize_file", { path, lang })
      .then((r) => {
        if (!cancelled) setAi(r);
      })
      .catch((e) => {
        if (!cancelled && String(e).includes("no_api_key")) setAiNoKey(true);
      })
      .finally(() => {
        if (!cancelled) setAiBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, kind, lang]);

  if (!preview) {
    return (
      <div className="grid h-full place-items-center bg-panel/50 text-sm text-muted">
        {t("preview.empty")}
      </div>
    );
  }

  const src = convertFileSrc(preview.path);
  const hasBlocks = !!preview.blocks && preview.blocks.length > 0;

  async function copyPath() {
    await navigator.clipboard.writeText(preview!.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function ask() {
    const query = question.trim();
    if (!query || asking) return;
    setAsking(true);
    setAnswer(null);
    try {
      const r = await invoke<{ answer: string }>("ask_document", {
        path: preview!.path,
        question: query,
        lang,
      });
      setAnswer(r.answer);
    } catch (e) {
      setAnswer(
        String(e).includes("no_api_key") ? t("preview.aiNoKey") : String(e),
      );
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-panel/50">
      <div className="border-b border-edge px-4 py-3">
        <div className="truncate text-sm font-semibold">{preview.name}</div>
        <div
          className="mt-0.5 truncate text-xs text-accent-2/90"
          title={preview.path}
        >
          {preview.path}
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <span>
            {t("preview.size")}: {fmtSize(preview.size)}
          </span>
          {preview.mtime && (
            <span>
              · {t("preview.modified")}:{" "}
              {new Date(preview.mtime * 1000).toLocaleDateString(i18n.language)}
            </span>
          )}
          <span className="ml-auto flex gap-2">
            <button
              onClick={copyPath}
              className="rounded-lg border border-edge bg-panel-2 px-2.5 py-1 transition hover:text-txt"
            >
              {copied ? t("preview.copied") : t("preview.copyPath")}
            </button>
            <button
              onClick={() => invoke("reveal_in_folder", { path: preview.path })}
              className="rounded-lg border border-edge bg-panel-2 px-2.5 py-1 transition hover:text-txt"
            >
              {t("preview.reveal")}
            </button>
            <button
              onClick={() => invoke("open_file", { path: preview.path })}
              className="rounded-lg bg-gradient-to-r from-accent to-accent-2 px-2.5 py-1 font-semibold text-ink"
            >
              {t("preview.open")}
            </button>
          </span>
        </div>
      </div>

      {(aiBusy || ai) && (
        <div className="border-b border-edge bg-gradient-to-br from-accent/10 via-panel/40 to-accent-2/10 px-4 py-3">
          <div className="mb-2 flex items-center gap-1.5">
            <span className="text-sm">✨</span>
            <span className="bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-[10px] font-bold uppercase tracking-widest text-transparent">
              {t("preview.aiSummary")}
            </span>
            {aiBusy && (
              <span className="ml-1 text-[10px] text-muted">
                {t("preview.summarizing")}
              </span>
            )}
          </div>

          {aiBusy && !ai && (
            <div className="space-y-2">
              <div className="h-3 w-3/4 animate-pulse rounded bg-edge" />
              <div className="h-2.5 w-full animate-pulse rounded bg-edge/60" />
              <div className="h-2.5 w-5/6 animate-pulse rounded bg-edge/60" />
            </div>
          )}

          {ai && (
            <>
              <p className="text-sm font-medium leading-relaxed text-txt">
                {ai.tldr}
              </p>
              {ai.points.length > 0 && (
                <ul className="mt-2.5 space-y-1.5">
                  {ai.points.map((p, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 text-xs leading-relaxed text-txt/85"
                    >
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-r from-accent to-accent-2" />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {aiNoKey && (
        <div className="border-b border-edge bg-panel/40 px-4 py-2 text-[11px] text-muted">
          {t("preview.aiNoKey")}
        </div>
      )}

      {!aiNoKey && (kind === "text" || kind === "pdf") && (
        <div className="border-b border-edge px-4 py-2.5">
          <div className="flex items-center gap-2 rounded-xl border border-edge bg-panel-2 px-2.5 py-1.5 focus-within:border-accent/60">
            <span className="text-xs text-accent-2">✦</span>
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  ask();
                }
              }}
              placeholder={t("preview.ask")}
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted/60"
            />
            {asking && (
              <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-accent-2" />
            )}
          </div>
          {answer && (
            <div className="mt-2 rounded-xl bg-accent/5 px-3 py-2 text-xs leading-relaxed text-txt/90">
              {answer}
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {preview.kind === "image" && (
          <div className="grid h-full place-items-center overflow-auto p-4">
            <img src={src} alt={preview.name} className="max-h-full max-w-full rounded-lg" />
          </div>
        )}
        {preview.kind === "pdf" && (
          <iframe src={src} title={preview.name} className="h-full w-full border-0" />
        )}
        {preview.kind === "text" && hasBlocks && <DocView blocks={preview.blocks!} />}
        {preview.kind === "text" && !hasBlocks && (
          <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-4 text-xs leading-relaxed text-txt/90">
            {preview.text ?? t("preview.noPreview")}
          </pre>
        )}
        {preview.kind === "other" && (
          <div className="grid h-full place-items-center text-sm text-muted">
            {t("preview.noPreview")}
          </div>
        )}
      </div>
    </div>
  );
}
