import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { SparkleIcon } from "./icons";
import CodeView, { langForExt } from "./CodeView";
import CsvTable from "./CsvTable";
import MarkdownView from "./MarkdownView";
import type { DocBlock, Preview } from "../types";

export function extOf(path: string): string {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

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
  1: "mt-4 mb-1 text-base font-bold text-txt-strong",
  2: "mt-3 mb-1 text-sm font-semibold text-txt-strong",
  3: "mt-3 mb-0.5 text-sm font-semibold text-txt",
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
        <aside className="w-48 shrink-0 overflow-auto border-r border-edge-soft p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-widest text-accent">
              {t("preview.outline")}
            </span>
            <button
              onClick={() => setShowOutline(false)}
              className="text-muted-2 hover:text-txt"
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
            className="mb-2 rounded-md border border-edge bg-fill px-2 py-1 text-[11px] text-muted hover:text-txt"
          >
            {t("preview.showOutline")}
          </button>
        )}
        {blocks.map((b, i) =>
          b.level >= 1 ? (
            <div
              key={i}
              data-b={i}
              className={HEADING_CLASS[b.level] ?? HEADING_CLASS[3]}
            >
              {b.text}
            </div>
          ) : (
            <p
              key={i}
              data-b={i}
              className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-txt-mid"
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
      <div className="grid h-full place-items-center px-8 text-center text-[15px] text-muted">
        {t("preview.empty")}
      </div>
    );
  }

  const src = convertFileSrc(preview.path);
  const hasHtml = !!preview.html && preview.html.length > 0;
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

  const secondaryBtn =
    "rounded-[9px] border border-edge bg-fill px-3.5 py-2 text-[12.5px] font-semibold text-muted transition hover:bg-fill-hover hover:text-txt";

  return (
    <div className="flex h-full flex-col border-l border-edge-soft">
      {/* Header: name, path, meta + actions */}
      <div className="flex-shrink-0 border-b border-edge-soft px-6 py-5">
        <div className="truncate text-[19px] font-bold tracking-tight text-txt-strong">
          {preview.name}
        </div>
        <div
          className="mt-1 break-all text-[12.5px] leading-snug text-accent"
          title={preview.path}
        >
          {preview.path}
        </div>
        <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2.5">
          <div className="text-[12.5px] text-muted-2">
            {t("preview.size")}: {fmtSize(preview.size)}
            {preview.mtime && (
              <>
                {"  ·  "}
                {t("preview.modified")}:{" "}
                {new Date(preview.mtime * 1000).toLocaleDateString(
                  i18n.language,
                )}
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={copyPath} className={secondaryBtn}>
              {copied ? t("preview.copied") : t("preview.copyPath")}
            </button>
            <button
              onClick={() => invoke("reveal_in_folder", { path: preview.path })}
              className={secondaryBtn}
            >
              {t("preview.reveal")}
            </button>
            <button
              onClick={() => invoke("open_file", { path: preview.path })}
              className="rounded-[9px] bg-gradient-to-br from-accent to-[#0A6CFF] px-4 py-2 text-[12.5px] font-semibold text-white shadow-[0_4px_12px_-5px_rgba(10,132,255,0.6)] transition hover:-translate-y-px"
            >
              {t("preview.open")}
            </button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* AI summary */}
        {(aiBusy || ai) && (
          <div className="border-b border-edge-soft px-6 py-5">
            <div className="mb-3 flex items-center gap-1.5">
              <SparkleIcon className="h-[15px] w-[15px] text-accent" />
              <span className="text-[11.5px] font-bold uppercase tracking-[0.06em] text-accent">
                {t("preview.aiSummary")}
              </span>
              {aiBusy && (
                <span className="ml-1 text-[10px] text-muted-2">
                  {t("preview.summarizing")}
                </span>
              )}
            </div>

            {aiBusy && !ai && (
              <div className="space-y-2">
                <div className="h-3.5 w-3/4 animate-pulse rounded bg-fill-2" />
                <div className="h-2.5 w-full animate-pulse rounded bg-fill" />
                <div className="h-2.5 w-5/6 animate-pulse rounded bg-fill" />
              </div>
            )}

            {ai && (
              <>
                <p className="mb-4 text-base font-bold leading-snug tracking-tight text-txt-strong">
                  {ai.tldr}
                </p>
                {ai.points.length > 0 && (
                  <ul className="flex flex-col gap-2.5">
                    {ai.points.map((p, i) => (
                      <li key={i} className="flex items-start gap-2.5">
                        <span className="mt-2 h-[5px] w-[5px] shrink-0 rounded-full bg-accent" />
                        <span className="text-sm leading-relaxed text-txt-mid">
                          {p}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        {aiNoKey && (
          <div className="border-b border-edge-soft px-6 py-3 text-[11px] text-muted">
            {t("preview.aiNoKey")}
          </div>
        )}

        {/* Ask about this document */}
        {!aiNoKey && (kind === "text" || kind === "pdf") && (
          <div className="border-b border-edge-soft px-6 py-4">
            <div className="relative flex items-center">
              <SparkleIcon className="pointer-events-none absolute left-3.5 h-4 w-4 text-muted-2" />
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
                className="w-full rounded-[11px] border border-edge bg-fill py-3 pl-10 pr-9 text-[13.5px] tracking-tight text-txt outline-none transition placeholder:text-muted-2 focus:bg-fill-2 focus:shadow-[0_0_0_3px_rgba(10,132,255,0.18)]"
              />
              {asking && (
                <span className="thinking-dot absolute right-4 h-1.5 w-1.5 rounded-full bg-accent" />
              )}
            </div>
            {answer && (
              <div className="mt-2.5 rounded-xl border border-edge-soft bg-fill px-3.5 py-2.5 text-[13px] leading-relaxed text-txt-mid">
                {answer}
              </div>
            )}
          </div>
        )}

        {/* Document body */}
        {preview.kind === "image" && (
          <div className="grid place-items-center p-6">
            <img
              src={src}
              alt={preview.name}
              className="max-h-full max-w-full rounded-xl"
            />
          </div>
        )}
        {preview.kind === "pdf" && (
          <iframe
            src={src}
            title={preview.name}
            className="h-[70vh] w-full border-0"
          />
        )}
        {preview.kind === "text" && hasHtml && (
          <div className="px-6 py-5">
            <div className="mb-2.5 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-label">
              {t("preview.document")}
            </div>
            <div className="docx-page rounded-[13px] border border-edge-soft bg-panel px-8 py-7 shadow-sm">
              <div
                className="docx-rich"
                dangerouslySetInnerHTML={{ __html: preview.html! }}
              />
            </div>
          </div>
        )}
        {preview.kind === "text" && !hasHtml && hasBlocks && (
          <div className="h-[60vh]">
            <DocView blocks={preview.blocks!} />
          </div>
        )}
        {preview.kind === "text" && !hasHtml && !hasBlocks && (() => {
          const ext = extOf(preview.path);
          const text = preview.text;
          let body: React.ReactNode;
          if (text == null) {
            body = (
              <pre className="whitespace-pre-wrap break-words rounded-[13px] border border-edge-soft bg-panel px-5 py-[18px] font-sans text-[13.5px] leading-[1.75] text-txt-mid">
                {t("preview.noPreview")}
              </pre>
            );
          } else if (ext === "md" || ext === "markdown") {
            body = (
              <div className="rounded-[13px] border border-edge-soft bg-panel px-5 py-[18px]">
                <MarkdownView text={text} />
              </div>
            );
          } else if (ext === "csv" || ext === "tsv") {
            body = <CsvTable text={text} ext={ext} />;
          } else if (langForExt(ext)) {
            body = <CodeView text={text} ext={ext} />;
          } else {
            body = (
              <pre className="whitespace-pre-wrap break-words rounded-[13px] border border-edge-soft bg-panel px-5 py-[18px] font-sans text-[13.5px] leading-[1.75] text-txt-mid">
                {text}
              </pre>
            );
          }
          return (
            <div className="px-6 py-5">
              <div className="mb-2.5 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-label">
                {t("preview.document")}
              </div>
              {body}
            </div>
          );
        })()}
        {preview.kind === "other" && (
          <div className="grid place-items-center px-8 py-16 text-center text-sm text-muted">
            {t("preview.noPreview")}
          </div>
        )}
      </div>
    </div>
  );
}
