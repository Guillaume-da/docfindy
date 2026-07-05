import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import Chat from "./components/Chat";
import PreviewPane from "./components/PreviewPane";
import Settings from "./components/Settings";
import Onboarding from "./components/Onboarding";
import LangToggle from "./components/LangToggle";
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
  const { i18n } = useTranslation();
  const [ready, setReady] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);

  // width of the preview pane, as a % of the split area, drag-adjustable
  const splitRef = useRef<HTMLDivElement>(null);
  const [previewPct, setPreviewPct] = useState(() => {
    const saved = Number(localStorage.getItem("findy.previewPct"));
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
      localStorage.setItem("findy.previewPct", String(Math.round(pctRef.current)));
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

      <div ref={splitRef} className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Chat onShowFile={showFile} />
        </div>
        <div
          onPointerDown={startDrag}
          className="group relative w-1 shrink-0 cursor-col-resize bg-edge transition hover:bg-accent-2"
          title="Drag to resize"
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
        </div>
        <div className="min-w-0 shrink-0" style={{ width: `${previewPct}%` }}>
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
