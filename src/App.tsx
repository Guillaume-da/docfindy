import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import Chat from "./components/Chat";
import PreviewPane from "./components/PreviewPane";
import Settings from "./components/Settings";
import Onboarding from "./components/Onboarding";
import LangToggle from "./components/LangToggle";
import type { AppSettings, IndexStatus, Preview, ShownFile } from "./types";

export default function App() {
  const { i18n } = useTranslation();
  const [ready, setReady] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);

  const refresh = useCallback(async () => {
    const [s, hasKey, idx] = await Promise.all([
      invoke<AppSettings>("get_settings"),
      invoke<boolean>("has_api_key"),
      invoke<IndexStatus>("index_status"),
    ]);
    setSettings(s);
    setIndexStatus(idx);
    if (s.lang) i18n.changeLanguage(s.lang);
    setNeedsOnboarding(!hasKey || !idx.exists);
    setReady(true);
  }, [i18n]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const un = listen<ShownFile>("show-file", async (e) => {
      if (!e.payload.exists) return;
      try {
        const p = await invoke<Preview>("read_preview", { path: e.payload.path });
        setPreview({ ...p, summary: e.payload.summary });
      } catch {
        /* file vanished between show and read */
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const showFile = useCallback(async (path: string, summary?: string | null) => {
    try {
      const p = await invoke<Preview>("read_preview", { path });
      setPreview({ ...p, summary });
    } catch {
      /* ignore */
    }
  }, []);

  if (!ready) return null;

  if (needsOnboarding) {
    return <Onboarding onDone={refresh} />;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge bg-panel px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent-2 text-sm font-black text-ink glow">
            F
          </span>
          <span className="text-lg font-semibold tracking-tight">Findy</span>
        </div>
        {indexStatus?.files ? (
          <span className="ml-2 rounded-full border border-edge bg-panel-2 px-3 py-1 text-xs text-muted">
            {indexStatus.files.toLocaleString()} files
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <LangToggle
            settings={settings}
            onChanged={(s) => setSettings(s)}
          />
          <button
            onClick={() => setShowSettings(true)}
            className="rounded-lg border border-edge bg-panel-2 px-3 py-1.5 text-sm text-muted transition hover:text-txt"
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r border-edge">
          <Chat onShowFile={showFile} />
        </div>
        <div className="w-[42%] min-w-[320px]">
          <PreviewPane preview={preview} />
        </div>
      </div>

      {showSettings && settings && (
        <Settings
          settings={settings}
          onClose={() => {
            setShowSettings(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}
