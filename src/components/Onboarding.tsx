import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import IndexProgress from "./IndexProgress";
import LangToggle from "./LangToggle";
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
    <div className="grid h-full place-items-center p-6">
      <div className="w-[520px] max-w-[92vw]">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-accent to-accent-2 text-xl font-black text-ink glow">
              F
            </span>
            <h1 className="bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-2xl font-bold text-transparent">
              {t("onboarding.welcome")}
            </h1>
          </div>
          <LangToggle settings={settings} onChanged={() => {}} />
        </div>
        <p className="mb-6 text-sm text-muted">{t("onboarding.intro")}</p>

        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          {t("onboarding.step1")}
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t("settings.apiKeyPlaceholder")}
          className="mb-5 w-full rounded-xl border border-edge bg-panel-2 px-3 py-2.5 text-sm outline-none focus:border-accent/60"
        />

        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          {t("onboarding.step2")}
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
        <button
          onClick={addFolder}
          className="mb-6 rounded-xl border border-edge bg-panel-2 px-3 py-2 text-sm text-muted transition hover:text-txt"
        >
          + {t("settings.addFolder")}
        </button>

        {busy && <IndexProgress />}
        {error && (
          <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <button
          onClick={start}
          disabled={busy}
          className="w-full rounded-xl bg-gradient-to-r from-accent to-accent-2 py-3 text-sm font-bold text-ink transition hover:opacity-90 disabled:opacity-40"
        >
          {busy ? t("onboarding.indexing") : t("onboarding.start")}
        </button>
      </div>
    </div>
  );
}
