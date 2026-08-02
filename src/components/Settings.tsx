import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import IndexProgress from "./IndexProgress";
import LangToggle from "./LangToggle";
import ThemeToggle from "./ThemeToggle";
import { FolderIcon } from "./icons";
import type { AppSettings, IndexStatus } from "../types";

export default function Settings({
  settings,
  onClose,
}: {
  settings: AppSettings;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [roots, setRoots] = useState<string[]>(settings.roots || []);
  const [indexing, setIndexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<IndexStatus | null>(null);

  // What the index left out is only trustworthy if it is visible: without it,
  // a file missing from the results is indistinguishable from a bug.
  const loadStatus = useCallback(() => {
    invoke<IndexStatus>("index_status")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(loadStatus, [loadStatus]);

  async function saveKey() {
    if (!apiKey.trim()) return;
    await invoke("set_api_key", { key: apiKey });
    setApiKey("");
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 2000);
  }

  async function addFolder() {
    const dir = await open({ directory: true, title: t("onboarding.pickFolder") });
    if (typeof dir === "string" && !roots.includes(dir)) {
      setRoots([...roots, dir]);
    }
  }

  async function rebuild() {
    setError(null);
    setIndexing(true);
    try {
      await invoke("build_index", { paths: roots });
      loadStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setIndexing(false);
    }
  }

  async function update() {
    setError(null);
    setIndexing(true);
    try {
      await invoke("update_index");
      loadStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setIndexing(false);
    }
  }

  const sectionLabel =
    "mb-2 ml-1 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-label";
  const card =
    "mb-6 rounded-[14px] border border-edge-soft bg-panel p-[18px]";
  const primaryBtn =
    "rounded-[9px] bg-gradient-to-br from-accent to-[#0A6CFF] px-4 py-2 text-[12.5px] font-semibold text-white shadow-[0_4px_12px_-5px_rgba(10,132,255,0.6)] transition hover:-translate-y-px disabled:opacity-40 disabled:hover:translate-y-0";
  const secondaryBtn =
    "rounded-[9px] border border-edge bg-fill px-4 py-2 text-[12.5px] font-semibold text-muted transition hover:bg-fill-hover hover:text-txt disabled:opacity-40";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6 backdrop-blur-sm fade-in">
      <div className="max-h-[88vh] w-[600px] max-w-[94vw] overflow-y-auto rounded-[18px] border border-edge bg-surface p-7 shadow-2xl backdrop-blur-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold tracking-tight text-txt-strong">
            {t("settings.title")}
          </h2>
          <button
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-[9px] bg-fill-2 text-muted transition hover:bg-fill-hover hover:text-txt"
          >
            ✕
          </button>
        </div>

        {/* Connection */}
        <div className={sectionLabel}>{t("settings.connection")}</div>
        <div className={card}>
          <label className="mb-2 block text-[13px] font-semibold text-muted">
            {t("settings.apiKey")}
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("settings.apiKeyPlaceholder")}
              className="flex-1 rounded-[11px] border border-edge bg-fill px-3.5 py-3 text-sm text-txt outline-none transition placeholder:text-muted-2 focus:bg-fill-2 focus:shadow-[0_0_0_3px_rgba(10,132,255,0.18)]"
            />
            <button onClick={saveKey} disabled={!apiKey.trim()} className={primaryBtn}>
              {keySaved ? "✓" : t("settings.save")}
            </button>
          </div>
        </div>

        {/* Index */}
        <div className={sectionLabel}>{t("settings.index")}</div>
        <div className={card}>
          <label className="mb-2 block text-[13px] font-semibold text-muted">
            {t("settings.folders")}
          </label>
          <div className="mb-3 space-y-1.5">
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
          <div className="flex flex-wrap gap-2 border-t border-edge-soft pt-4">
            <button onClick={addFolder} className={secondaryBtn}>
              + {t("settings.addFolder")}
            </button>
            <button
              onClick={rebuild}
              disabled={indexing || roots.length === 0}
              className={primaryBtn}
            >
              {t("settings.reindex")}
            </button>
            <button onClick={update} disabled={indexing} className={secondaryBtn}>
              {t("settings.updateIndex")}
            </button>
          </div>

          {!indexing && status?.exists && (
            <div className="mt-4 border-t border-edge-soft pt-4">
              <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-label">
                {t("settings.privacy")}
              </div>
              <ul className="space-y-1 text-[12.5px] leading-relaxed text-muted">
                <li>{t("settings.skippedSensitive", { count: status.skipped_sensitive ?? 0 })}</li>
                <li>{t("settings.secretFiles", { count: status.secret_files ?? 0 })}</li>
              </ul>
            </div>
          )}

          {indexing && (
            <div className="mt-4">
              <IndexProgress />
            </div>
          )}
          {error && (
            <div className="mt-4 rounded-[11px] border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-[13px] text-red-400">
              {error}
            </div>
          )}
        </div>

        {/* Appearance */}
        <div className={sectionLabel}>{t("settings.appearance")}</div>
        <div className="mb-6 rounded-[14px] border border-edge-soft bg-panel px-[18px]">
          <div className="flex items-center justify-between border-b border-edge-soft py-3.5">
            <div className="text-sm font-medium text-txt">
              {t("settings.theme")}
            </div>
            <ThemeToggle />
          </div>
          <div className="flex items-center justify-between py-3.5">
            <div className="text-sm font-medium text-txt">
              {t("settings.language")}
            </div>
            <LangToggle settings={settings} onChanged={() => {}} />
          </div>
        </div>

        <div className="pt-1 text-center">
          <div className="text-[13px] font-semibold text-muted">
            DocFindy — {t("settings.version")}
          </div>
          <div className="mt-0.5 text-xs text-muted-2">Made by G. Dall'Olmo</div>
        </div>
      </div>
    </div>
  );
}
