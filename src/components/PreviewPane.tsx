import { useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { DocBlock, Preview } from "../types";

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
              onClick={() => invoke("open_in_browser", { path: preview.path })}
              className="rounded-lg bg-gradient-to-r from-accent to-accent-2 px-2.5 py-1 font-semibold text-ink"
            >
              {t("preview.openBrowser")}
            </button>
          </span>
        </div>
      </div>

      {preview.summary && (
        <div className="border-b border-edge bg-accent/5 px-4 py-3">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-accent-2">
            {t("preview.synthesis")}
          </div>
          <p className="text-xs leading-relaxed text-txt/90">{preview.summary}</p>
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
