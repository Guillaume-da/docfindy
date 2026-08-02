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

type PreviewTab = "document" | "insights";

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

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
        <aside className="w-48 shrink-0 overflow-auto border-r border-edge-soft bg-panel/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-widest text-accent">
              {t("preview.outline")}
            </span>
            <button
              onClick={() => setShowOutline(false)}
              className="grid h-6 w-6 place-items-center rounded-md text-muted-2 transition hover:bg-fill-hover hover:text-txt"
              aria-label={t("preview.hideOutline")}
            >
              ×
            </button>
          </div>
          <nav className="space-y-0.5">
            {outline.map((h) => (
              <button
                key={h.i}
                onClick={() => scrollTo(h.i)}
                className="block w-full truncate rounded-md px-1.5 py-1 text-left text-xs text-muted transition hover:bg-fill hover:text-txt"
                style={{ paddingLeft: `${(h.level - 1) * 10 + 6}px` }}
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

function EmptyPreview() {
  const { t } = useTranslation();
  return (
    <div className="grid h-full place-items-center border-l border-edge-soft px-8 text-center">
      <div className="max-w-[290px]">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-[20px] border border-edge bg-panel shadow-[0_18px_45px_-28px_rgba(10,132,255,0.9)]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            className="h-7 w-7 text-accent"
            aria-hidden="true"
          >
            <path d="M7 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5a1.5 1.5 0 0 1 1-1.5Z" />
            <path d="M14 3.5V8h4M9 12h6M9 15.5h4" />
          </svg>
        </div>
        <h2 className="mt-4 text-[17px] font-bold tracking-tight text-txt-strong">
          {t("preview.emptyTitle")}
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
          {t("preview.emptyHint")}
        </p>
      </div>
    </div>
  );
}

export default function PreviewPane({ preview }: { preview: Preview | null }) {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<PreviewTab>("document");
  const [ai, setAi] = useState<AiSummary | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNoKey, setAiNoKey] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const summarySeq = useRef(0);
  const askSeq = useRef(0);

  const path = preview?.path;
  const kind = preview?.kind;
  const lang = i18n.language?.startsWith("fr")
    ? "fr"
    : i18n.language?.startsWith("es")
      ? "es"
      : "en";

  useEffect(() => {
    summarySeq.current += 1;
    askSeq.current += 1;
    setTab("document");
    setAi(null);
    setAiBusy(false);
    setAiNoKey(false);
    setAiError(null);
    setAnswer(null);
    setQuestion("");
    setAsking(false);
  }, [path, kind, lang]);

  if (!preview) return <EmptyPreview />;

  const src = convertFileSrc(preview.path);
  const hasHtml = !!preview.html && preview.html.length > 0;
  const hasBlocks = !!preview.blocks && preview.blocks.length > 0;
  const summarizable = kind === "text" || kind === "pdf";

  async function copyPath() {
    await navigator.clipboard.writeText(preview!.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function generateSummary() {
    if (!summarizable || aiBusy) return;
    const id = ++summarySeq.current;
    setTab("insights");
    setAiBusy(true);
    setAiNoKey(false);
    setAiError(null);
    try {
      const result = await invoke<AiSummary>("summarize_file", {
        path: preview!.path,
        lang,
      });
      if (id === summarySeq.current) setAi(result);
    } catch (e) {
      if (id !== summarySeq.current) return;
      if (String(e).includes("no_api_key")) setAiNoKey(true);
      else setAiError(String(e));
    } finally {
      if (id === summarySeq.current) setAiBusy(false);
    }
  }

  async function ask() {
    const query = question.trim();
    if (!query || asking) return;
    const id = ++askSeq.current;
    setAsking(true);
    setAnswer(null);
    try {
      const result = await invoke<{ answer: string }>("ask_document", {
        path: preview!.path,
        question: query,
        lang,
      });
      if (id === askSeq.current) setAnswer(result.answer);
    } catch (e) {
      if (id === askSeq.current) {
        setAnswer(
          String(e).includes("no_api_key") ? t("preview.aiNoKey") : String(e),
        );
      }
    } finally {
      if (id === askSeq.current) setAsking(false);
    }
  }

  const secondaryBtn =
    "rounded-[9px] border border-edge bg-fill px-3 py-2 text-[12px] font-semibold text-muted transition hover:bg-fill-hover hover:text-txt";

  const documentBody = (() => {
    if (preview.kind === "image") {
      return (
        <div className="grid min-h-full place-items-center p-6">
          <img
            src={src}
            alt={preview.name}
            className="max-h-[72vh] max-w-full rounded-2xl border border-edge-soft shadow-xl"
          />
        </div>
      );
    }
    if (preview.kind === "pdf") {
      return (
        <iframe
          src={src}
          title={preview.name}
          className="h-full min-h-[600px] w-full border-0 bg-panel"
        />
      );
    }
    if (preview.kind === "text" && hasHtml) {
      return (
        <div className="px-6 py-5">
          <div className="docx-page mx-auto max-w-[860px] rounded-[16px] border border-edge-soft bg-panel px-8 py-7 shadow-[0_18px_55px_-42px_rgba(0,0,0,0.9)]">
            <div
              className="docx-rich"
              dangerouslySetInnerHTML={{ __html: preview.html! }}
            />
          </div>
        </div>
      );
    }
    if (preview.kind === "text" && !hasHtml && hasBlocks) {
      return <DocView blocks={preview.blocks!} />;
    }
    if (preview.kind === "text") {
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
      return <div className="px-6 py-5">{body}</div>;
    }
    return (
      <div className="grid min-h-[380px] place-items-center px-8 py-16 text-center text-sm text-muted">
        {t("preview.noPreview")}
      </div>
    );
  })();

  return (
    <div className="flex h-full flex-col border-l border-edge-soft bg-surface/35">
      <div className="flex-shrink-0 border-b border-edge-soft bg-titlebar/45 px-5 pb-4 pt-4 backdrop-blur-xl">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[18px] font-bold tracking-tight text-txt-strong">
              {preview.name}
            </div>
            <div className="mt-1 truncate text-[11.5px] text-muted" title={preview.path}>
              {preview.path}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-muted-2">
              <span className="rounded-full bg-pill px-2 py-0.5">
                {extOf(preview.path).toUpperCase() || "FILE"}
              </span>
              <span>{fmtSize(preview.size)}</span>
              {preview.mtime && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {new Date(preview.mtime * 1000).toLocaleDateString(i18n.language)}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
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
              className="rounded-[9px] bg-gradient-to-br from-accent to-[#0A6CFF] px-3.5 py-2 text-[12px] font-semibold text-white shadow-[0_6px_16px_-8px_rgba(10,132,255,0.9)] transition hover:-translate-y-px"
            >
              {t("preview.open")}
            </button>
          </div>
        </div>
      </div>

      {summarizable && (
        <div className="flex flex-shrink-0 items-center gap-1 border-b border-edge-soft bg-panel/35 px-5 py-2">
          {(["document", "insights"] as const).map((value) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={
                "rounded-[8px] px-3 py-1.5 text-[12px] font-semibold transition " +
                (tab === value
                  ? "bg-fill-hover text-txt-strong shadow-sm"
                  : "text-muted hover:bg-fill hover:text-txt")
              }
              aria-pressed={tab === value}
            >
              {value === "document" ? t("preview.documentTab") : t("preview.insightsTab")}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {(!summarizable || tab === "document") && documentBody}

        {summarizable && tab === "insights" && (
          <div className="mx-auto max-w-[760px] space-y-4 px-6 py-5 fade-in">
            <section className="overflow-hidden rounded-2xl border border-edge-soft bg-panel shadow-[0_18px_55px_-45px_rgba(10,132,255,0.9)]">
              <div className="flex items-center justify-between gap-3 border-b border-edge-soft px-5 py-4">
                <div className="flex items-center gap-2">
                  <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-accent/15 text-accent">
                    <SparkleIcon className="h-4 w-4" />
                  </span>
                  <div>
                    <h2 className="text-[14px] font-bold text-txt-strong">
                      {t("preview.aiSummary")}
                    </h2>
                    <p className="text-[11.5px] text-muted">
                      {t("preview.summaryIntro")}
                    </p>
                  </div>
                </div>
                {ai && !aiBusy && (
                  <button onClick={generateSummary} className={secondaryBtn}>
                    {t("preview.regenerateSummary")}
                  </button>
                )}
              </div>

              <div className="px-5 py-5">
                {!ai && !aiBusy && (
                  <div className="rounded-xl border border-dashed border-edge bg-fill/50 px-4 py-5 text-center">
                    <button
                      onClick={generateSummary}
                      className="rounded-[10px] bg-gradient-to-br from-accent to-accent-2 px-4 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_22px_-12px_rgba(10,132,255,0.9)] transition hover:-translate-y-px"
                    >
                      <span className="inline-flex items-center gap-2">
                        <SparkleIcon className="h-4 w-4" />
                        {t("preview.generateSummary")}
                      </span>
                    </button>
                    <p className="mx-auto mt-3 max-w-[500px] text-[11px] leading-relaxed text-muted-2">
                      {t("preview.summaryPrivacy")}
                    </p>
                  </div>
                )}

                {aiBusy && (
                  <div className="space-y-3" aria-live="polite">
                    <div className="flex items-center gap-2 text-[11px] font-semibold text-accent">
                      <span className="thinking-dot h-2 w-2 rounded-full bg-accent" />
                      {t("preview.summarizing")}
                    </div>
                    <div className="h-4 w-4/5 animate-pulse rounded bg-fill-2" />
                    <div className="h-3 w-full animate-pulse rounded bg-fill" />
                    <div className="h-3 w-5/6 animate-pulse rounded bg-fill" />
                  </div>
                )}

                {ai && !aiBusy && (
                  <div className="fade-in">
                    <p className="text-[17px] font-bold leading-snug tracking-tight text-txt-strong">
                      {ai.tldr}
                    </p>
                    {ai.points.length > 0 && (
                      <ul className="mt-4 grid gap-2.5">
                        {ai.points.map((point, index) => (
                          <li key={index} className="flex items-start gap-3 rounded-xl bg-fill px-3.5 py-3">
                            <span className="mt-1.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[10px] font-bold text-accent">
                              {index + 1}
                            </span>
                            <span className="text-[13px] leading-relaxed text-txt-mid">
                              {point}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {(aiNoKey || aiError) && (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-[12px] leading-relaxed text-amber-400">
                    {aiNoKey ? t("preview.aiNoKey") : aiError}
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-edge-soft bg-panel px-5 py-5">
              <div className="mb-3 flex items-center gap-2">
                <SparkleIcon className="h-4 w-4 text-accent" />
                <h2 className="text-[14px] font-bold text-txt-strong">
                  {t("preview.askLabel")}
                </h2>
              </div>
              <div className="relative flex items-center">
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
                  className="w-full rounded-[12px] border border-edge bg-fill py-3 pl-4 pr-12 text-[13.5px] tracking-tight text-txt outline-none transition placeholder:text-muted-2 focus:bg-fill-2 focus:shadow-[0_0_0_3px_rgba(10,132,255,0.18)]"
                />
                <button
                  onClick={ask}
                  disabled={!question.trim() || asking}
                  className="absolute right-2 grid h-8 w-8 place-items-center rounded-[9px] bg-accent text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
                  aria-label={t("preview.askLabel")}
                >
                  {asking ? (
                    <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-white" />
                  ) : (
                    <span aria-hidden="true">↑</span>
                  )}
                </button>
              </div>
              <p className="mt-2 text-[10.5px] leading-relaxed text-muted-2">
                {t("preview.askPrivacy")}
              </p>
              {answer && (
                <div className="mt-3 rounded-xl border border-edge-soft bg-fill px-4 py-3 text-[13px] leading-relaxed text-txt-mid fade-in">
                  {answer}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
