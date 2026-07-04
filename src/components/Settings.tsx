import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import IndexProgress from "./IndexProgress";
import type { AppSettings } from "../types";

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
    } catch (e) {
      setError(String(e));
    } finally {
      setIndexing(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm">
      <div className="w-[560px] max-w-[92vw] rounded-2xl border border-edge bg-panel p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("settings.title")}</h2>
          <button onClick={onClose} className="text-muted transition hover:text-txt">
            ✕
          </button>
        </div>

        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          {t("settings.apiKey")}
        </label>
        <div className="mb-5 flex gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t("settings.apiKeyPlaceholder")}
            className="flex-1 rounded-xl border border-edge bg-panel-2 px-3 py-2 text-sm outline-none focus:border-accent/60"
          />
          <button
            onClick={saveKey}
            disabled={!apiKey.trim()}
            className="rounded-xl bg-gradient-to-r from-accent to-accent-2 px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40"
          >
            {keySaved ? "✓" : t("settings.save")}
          </button>
        </div>

        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          {t("settings.folders")}
        </label>
        <div className="mb-2 space-y-1.5">
          {roots.map((r) => (
            <div
              key={r}
              className="flex items-center gap-2 rounded-xl border border-edge bg-panel-2 px-3 py-2 text-xs"
            >
              <span className="min-w-0 flex-1 truncate" title={r}>
                {r}
              </span>
              <button
                onClick={() => setRoots(roots.filter((x) => x !== r))}
                className="text-muted transition hover:text-red-400"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="mb-5 flex gap-2">
          <button
            onClick={addFolder}
            className="rounded-xl border border-edge bg-panel-2 px-3 py-2 text-sm text-muted transition hover:text-txt"
          >
            + {t("settings.addFolder")}
          </button>
          <button
            onClick={rebuild}
            disabled={indexing || roots.length === 0}
            className="rounded-xl border border-accent/50 bg-accent/10 px-3 py-2 text-sm text-accent transition hover:bg-accent/20 disabled:opacity-40"
          >
            {t("settings.reindex")}
          </button>
          <button
            onClick={update}
            disabled={indexing}
            className="rounded-xl border border-edge bg-panel-2 px-3 py-2 text-sm text-muted transition hover:text-txt disabled:opacity-40"
          >
            {t("settings.updateIndex")}
          </button>
        </div>

        {indexing && <IndexProgress />}
        {error && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
