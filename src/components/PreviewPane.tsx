import { useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { Preview } from "../types";

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
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

      <div className="min-h-0 flex-1 overflow-auto">
        {preview.kind === "image" && (
          <div className="grid h-full place-items-center p-4">
            <img src={src} alt={preview.name} className="max-h-full max-w-full rounded-lg" />
          </div>
        )}
        {preview.kind === "pdf" && (
          <iframe src={src} title={preview.name} className="h-full w-full border-0" />
        )}
        {preview.kind === "text" && (
          <pre className="whitespace-pre-wrap break-words p-4 text-xs leading-relaxed text-txt/90">
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
