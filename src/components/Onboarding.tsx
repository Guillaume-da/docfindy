import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import IndexProgress from "./IndexProgress";
import LangToggle from "./LangToggle";
import ThemeToggle from "./ThemeToggle";
import { FolderIcon, LockIcon, SearchGlyph } from "./icons";
import type { AppSettings } from "../types";

export default function Onboarding({
  settings,
  onDone,
}: {
  settings: AppSettings | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [roots, setRoots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addFolder() {
    const dir = await open({ directory: true, title: t("onboarding.pickFolder") });
    if (typeof dir === "string" && !roots.includes(dir)) {
      setRoots([...roots, dir]);
    }
  }

  async function start() {
    setError(null);
    if (roots.length === 0) {
      setError(t("onboarding.noFolders"));
      return;
    }
    setBusy(true);
    try {
      if (apiKey.trim()) {
        await invoke("set_api_key", { key: apiKey });
      }
      await invoke("build_index", { paths: roots });
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center bg-surface p-6 backdrop-blur-2xl float-in">
      <div className="w-[520px] max-w-[92vw] rounded-[18px] border border-edge-soft bg-panel p-8 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-12 w-12 place-items-center rounded-[16px] bg-gradient-to-br from-accent to-accent-2 glow">
              <SearchGlyph className="h-7 w-7" />
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-txt-strong">
              {t("onboarding.welcome")}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <LangToggle settings={settings} onChanged={() => {}} />
            <ThemeToggle />
          </div>
        </div>
        <p className="mb-7 text-sm leading-relaxed text-muted">
          {t("onboarding.intro")}
        </p>

        <label className="mb-2 block text-[11.5px] font-semibold uppercase tracking-[0.05em] text-label">
          {t("onboarding.step1")}
        </label>
        <div className="relative mb-6 flex items-center">
          <LockIcon className="pointer-events-none absolute left-3.5 h-4 w-4 text-muted-2" />
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t("settings.apiKeyPlaceholder")}
            className="w-full rounded-[11px] border border-edge bg-fill py-3 pl-10 pr-3.5 text-sm text-txt outline-none transition placeholder:text-muted-2 focus:bg-fill-2 focus:shadow-[0_0_0_3px_rgba(10,132,255,0.18)]"
          />
        </div>

        <label className="mb-2 block text-[11.5px] font-semibold uppercase tracking-[0.05em] text-label">
          {t("onboarding.step2")}
        </label>
        <div className="mb-2.5 flex gap-2">
          <div className="relative flex flex-1 items-center">
            <FolderIcon className="pointer-events-none absolute left-3.5 h-4 w-4 text-muted-2" />
            <input
              readOnly
              value={roots[roots.length - 1] ?? ""}
              placeholder={t("onboarding.folderPlaceholder")}
              className="w-full truncate rounded-[11px] border border-edge bg-fill py-3 pl-10 pr-3.5 text-sm text-txt-mid outline-none placeholder:text-muted-2"
            />
          </div>
          <button
            onClick={addFolder}
            className="shrink-0 rounded-[11px] border border-edge bg-fill px-4 text-[13px] font-semibold text-muted transition hover:bg-fill-hover hover:text-txt"
          >
            {t("onboarding.browse")}
          </button>
        </div>
        <div className="mb-7 space-y-1.5">
          {roots.map((r) => (
            <div
              key={r}
              className="flex items-center gap-2 rounded-[11px] border border-edge-soft bg-fill px-3.5 py-2.5 text-[13px]"
            >
              <FolderIcon className="h-4 w-4 shrink-0 text-muted-2" />
              <span className="min-w-0 flex-1 truncate text-txt-mid" title={r}>
                {r}
              </span>
              <button
                onClick={() => setRoots(roots.filter((x) => x !== r))}
                className="text-muted-2 transition hover:text-red-400"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        {busy && <IndexProgress />}
        {error && (
          <div className="mb-4 rounded-[11px] border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-[13px] text-red-400">
            {error}
          </div>
        )}

        <button
          onClick={start}
          disabled={busy}
          className="w-full rounded-[12px] bg-gradient-to-br from-accent to-accent-2 py-3 text-sm font-bold text-white shadow-[0_8px_20px_-8px_rgba(10,132,255,0.6)] transition hover:-translate-y-px disabled:opacity-40 disabled:hover:translate-y-0"
        >
          {busy ? t("onboarding.indexing") : t("onboarding.start")}
        </button>
      </div>
    </div>
  );
}
