import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import Chat from "./components/Chat";
import PreviewPane from "./components/PreviewPane";
import Settings from "./components/Settings";
import Onboarding from "./components/Onboarding";
import LangToggle from "./components/LangToggle";
import ThemeToggle from "./components/ThemeToggle";
import { SearchGlyph } from "./components/icons";
import type { AppSettings, IndexStatus, Preview, ShownFile } from "./types";

function errorPreview(
  path: string,
  err: unknown,
  summary?: string | null,
): Preview {
  return {
    kind: "text",
    path,
    name: path.split(/[\\/]/).pop() || path,
    size: 0,
    text: `Preview unavailable: ${String(err)}`,
    summary,
  };
}

export default function App() {
  const { t, i18n } = useTranslation();
  const [ready, setReady] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);

  // width of the preview pane, as a % of the split area, drag-adjustable
  const splitRef = useRef<HTMLDivElement>(null);
  const [previewPct, setPreviewPct] = useState(() => {
    // "findy.previewPct" is the pre-rename key; read it once so existing users
    // keep their pane width
    const saved = Number(
      localStorage.getItem("docfindy.previewPct") ?? localStorage.getItem("findy.previewPct"),
    );
    return saved >= 20 && saved <= 75 ? saved : 42;
  });
  const pctRef = useRef(previewPct);
  const dragging = useRef(false);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!dragging.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const pct = ((rect.right - e.clientX) / rect.width) * 100;
      const clamped = Math.min(75, Math.max(20, pct));
      pctRef.current = clamped;
      setPreviewPct(clamped);
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      localStorage.setItem("docfindy.previewPct", String(Math.round(pctRef.current)));
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  function startDrag() {
    dragging.current = true;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }

  const refresh = useCallback(async () => {
    const [s, hasKey, idx] = await Promise.all([
      invoke<AppSettings>("get_settings"),
      invoke<boolean>("has_api_key"),
      invoke<IndexStatus>("index_status"),
    ]);
    setSettings(s);
    setIndexStatus(idx);
    if (s.lang) i18n.changeLanguage(s.lang);
    // Instant search needs only an index; the Claude API key is optional.
    void hasKey;
    setNeedsOnboarding(!idx.exists);
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
      } catch (err) {
        setPreview(errorPreview(e.payload.path, err, e.payload.summary));
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
    } catch (err) {
      setPreview(errorPreview(path, err, summary));
    }
  }, []);

  if (!ready) return null;

  if (needsOnboarding) {
    return <Onboarding settings={settings} onDone={refresh} />;
  }

  return (
    <div className="flex h-full flex-col bg-surface backdrop-blur-2xl backdrop-saturate-150 float-in">
      <header className="flex flex-shrink-0 items-center gap-3.5 border-b border-edge-soft px-5 pb-3.5 pt-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-[34px] w-[34px] place-items-center rounded-[10px] bg-gradient-to-br from-accent to-accent-2 glow">
            <SearchGlyph className="h-[19px] w-[19px]" />
          </span>
          <span className="text-[19px] font-bold tracking-tight text-txt-strong">
            DocFindy
          </span>
          {indexStatus?.files ? (
            <span className="rounded-full bg-pill px-2.5 py-1 text-xs font-medium text-muted">
              {t("index.files", { count: indexStatus.files })}
            </span>
          ) : null}
        </div>

        <div className="ml-auto flex items-center gap-2.5">
          <LangToggle settings={settings} onChanged={(s) => setSettings(s)} />
          <ThemeToggle />
          <button
            onClick={() => setShowSettings(true)}
            className="grid h-[34px] w-[34px] place-items-center rounded-[9px] bg-fill-2 text-muted transition hover:bg-fill-hover hover:text-txt"
            title="Settings"
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      <div ref={splitRef} className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Chat onShowFile={showFile} />
        </div>
        <div
          onPointerDown={startDrag}
          className="group relative w-px shrink-0 cursor-col-resize bg-edge-soft transition hover:bg-accent"
          title="Drag to resize"
        >
          <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
        </div>
        <div className="min-w-0 shrink-0" style={{ width: `${previewPct}%` }}>
          <PreviewPane preview={preview} />
        </div>
      </div>

      <footer className="flex-shrink-0 border-t border-edge-soft px-5 py-2 text-center text-xs font-medium text-muted-2">
        Made by G. Dall'Olmo
      </footer>

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
