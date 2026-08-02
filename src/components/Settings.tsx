import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import IndexProgress from "./IndexProgress";
import LangToggle from "./LangToggle";
import ThemeToggle from "./ThemeToggle";
import { FolderIcon } from "./icons";
import { PROVIDERS, modelFor, providerInfo } from "../providers";
import type { AppSettings, IndexStatus, ProviderId } from "../types";

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

  const [provider, setProvider] = useState<ProviderId>(settings.provider ?? "anthropic");
  const [hasKey, setHasKey] = useState<Partial<Record<ProviderId, boolean>>>({});
  const [model, setModel] = useState(() => modelFor(settings, settings.provider ?? "anthropic"));
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const info = providerInfo(provider);

  // Read from the running app rather than a literal: the footer previously
  // claimed "Version 1.0", a number this app never carried, because nothing
  // made it move when the real version did.
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  const loadKeys = useCallback(() => {
    invoke<Record<ProviderId, boolean>>("provider_keys")
      .then(setHasKey)
      .catch(() => setHasKey({}));
  }, []);

  useEffect(loadKeys, [loadKeys]);

  // Model ids come from the provider itself, so a line-up change does not need
  // an app update. Without a key there is nothing to ask, hence the guard.
  const loadModels = useCallback(
    (id: ProviderId) => {
      setModels([]);
      setModelsError(null);
      if (!hasKey[id]) return;
      setLoadingModels(true);
      invoke<string[]>("list_models", { provider: id })
        .then(setModels)
        .catch((e) => setModelsError(String(e)))
        .finally(() => setLoadingModels(false));
    },
    [hasKey],
  );

  useEffect(() => loadModels(provider), [provider, loadModels]);

  // save_settings merges shallowly, so the whole map is resent each time; keep
  // it in state rather than reading back the stale `settings` prop.
  const [modelMap, setModelMap] = useState<Partial<Record<ProviderId, string>>>(
    () => settings.models ?? {},
  );

  async function persistModel(id: ProviderId, chosen: string, alsoProvider = false) {
    const next = { ...modelMap, [id]: chosen };
    setModelMap(next);
    await invoke("save_settings", {
      settings: alsoProvider ? { provider: id, models: next } : { models: next },
    });
  }

  async function pickProvider(id: ProviderId) {
    setProvider(id);
    setApiKey("");
    const next = modelFor({ ...settings, models: modelMap }, id);
    setModel(next);
    await persistModel(id, next, true);
  }

  async function pickModel(id: string) {
    setModel(id);
    await persistModel(provider, id);
  }

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
    await invoke("set_api_key", { key: apiKey, provider });
    setApiKey("");
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 2000);
    setHasKey((h) => ({ ...h, [provider]: true }));
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
    // A full screen rather than a dialog: at 600px wide every section stacked
    // into one column and the panel scrolled inside itself, which reads as
    // cramped. Side by side, the whole thing fits the window.
    <div className="flex h-full min-h-0 flex-col bg-surface fade-in">
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-edge-soft px-7 py-4">
        <button
          onClick={onClose}
          className="grid h-9 w-9 place-items-center rounded-[9px] bg-fill-2 text-muted transition hover:bg-fill-hover hover:text-txt"
          aria-label={t("settings.close")}
          title={t("settings.close")}
        >
          ←
        </button>
        <h2 className="text-xl font-bold tracking-tight text-txt-strong">
          {t("settings.title")}
        </h2>
        <button onClick={onClose} className="ml-auto rounded-[9px] border border-edge bg-fill px-4 py-2 text-[12.5px] font-semibold text-muted transition hover:bg-fill-hover hover:text-txt">
          {t("settings.close")}
        </button>
      </div>

      {/* overflow is a safety valve for very short windows, not the usual case */}
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-[1100px]">
        <div className="flex flex-col gap-x-7 lg:flex-row lg:items-start">
        {/* Connection */}
        <div className="lg:min-w-0 lg:flex-1">
        <div className={sectionLabel}>{t("settings.connection")}</div>
        <div className={card}>
          <label className="mb-2 block text-[13px] font-semibold text-muted">
            {t("settings.provider")}
          </label>
          <div className="mb-4 flex gap-2">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                onClick={() => pickProvider(p.id)}
                className={`flex-1 rounded-[11px] border px-3 py-2.5 text-[13px] font-semibold transition ${
                  provider === p.id
                    ? "border-accent bg-accent/15 text-txt-strong"
                    : "border-edge bg-fill text-muted hover:bg-fill-hover hover:text-txt"
                }`}
              >
                {p.label}
                {hasKey[p.id] && <span className="ml-1.5 text-accent">•</span>}
              </button>
            ))}
          </div>

          <label className="mb-2 block text-[13px] font-semibold text-muted">
            {t("settings.apiKeyFor", { provider: info.label })}
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey[provider] ? t("settings.keyStored") : info.keyPlaceholder}
              className="flex-1 rounded-[11px] border border-edge bg-fill px-3.5 py-3 text-sm text-txt outline-none transition placeholder:text-muted-2 focus:bg-fill-2 focus:shadow-[0_0_0_3px_rgba(10,132,255,0.18)]"
            />
            <button onClick={saveKey} disabled={!apiKey.trim()} className={primaryBtn}>
              {keySaved ? "✓" : t("settings.save")}
            </button>
          </div>
          <button
            onClick={() => invoke("open_provider_keys_page", { provider })}
            className="mt-2 text-[12px] text-muted-2 underline-offset-2 transition hover:text-accent hover:underline"
          >
            {t("settings.getKey", { provider: info.label })}
          </button>

          <div className="mt-4 border-t border-edge-soft pt-4">
            <label className="mb-2 block text-[13px] font-semibold text-muted">
              {t("settings.model")}
            </label>
            {models.length > 0 ? (
              <select
                value={models.includes(model) ? model : ""}
                onChange={(e) => pickModel(e.target.value)}
                className="w-full rounded-[11px] border border-edge bg-fill px-3.5 py-3 text-sm text-txt outline-none transition focus:bg-fill-2"
              >
                {!models.includes(model) && <option value="">{model}</option>}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              // No key, or the list could not be fetched: a free-text field is
              // the only thing that still lets the user name a model.
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={() => pickModel(model.trim() || info.defaultModel)}
                className="w-full rounded-[11px] border border-edge bg-fill px-3.5 py-3 text-sm text-txt outline-none transition focus:bg-fill-2"
              />
            )}
            <div className="mt-1.5 text-[12px] text-muted-2">
              {loadingModels
                ? t("settings.modelsLoading")
                : modelsError
                  ? t("settings.modelsError")
                  : !hasKey[provider]
                    ? t("settings.modelsNeedKey")
                    : t("settings.modelsCount", { count: models.length })}
            </div>
            {/* The provider's own words. "401 Incorrect API key", "404 model
                not found" and a DNS failure all need different fixes, and the
                translated line above cannot tell them apart. */}
            {modelsError && !loadingModels && (
              <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-[9px] border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11.5px] leading-relaxed text-red-400">
                {modelsError}
              </pre>
            )}
          </div>
        </div>
        </div>

        {/* Index and Appearance share the second column */}
        <div className="lg:min-w-0 lg:flex-1">
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
          </div>
        </div>

        <div className="pt-1 text-center">
          <div className="text-[13px] font-semibold text-muted">
            {version ? `DocFindy — ${t("settings.version", { version })}` : "DocFindy"}
          </div>
          <div className="mt-0.5 text-xs text-muted-2">Made by G. Dall'Olmo</div>
        </div>
        </div>
      </div>
    </div>
  );
}
