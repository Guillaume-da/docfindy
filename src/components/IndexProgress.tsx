import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";

interface ProgressEvent {
  stage: string;
  root?: string;
  files?: number;
  nodes?: number;
}

export default function IndexProgress() {
  const { t } = useTranslation();
  const [ev, setEv] = useState<ProgressEvent | null>(null);

  useEffect(() => {
    const un = listen<ProgressEvent>("index-progress", (e) => setEv(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  const label = (() => {
    if (!ev) return t("onboarding.indexing");
    switch (ev.stage) {
      case "detect":
      case "detected":
        return t("index.stage_detect", { root: ev.root ?? "" });
      case "fts":
        return t("index.stage_fts");
      default:
        return t("onboarding.indexing");
    }
  })();

  return (
    <div className="mb-3 rounded-[11px] border border-edge-soft bg-fill px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="flex gap-1">
          <span className="thinking-dot h-2 w-2 rounded-full bg-accent" />
          <span className="thinking-dot h-2 w-2 rounded-full bg-accent" />
          <span className="thinking-dot h-2 w-2 rounded-full bg-accent" />
        </span>
        <span className="truncate text-muted">{label}</span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-fill-2">
        <div className="h-full w-1/2 animate-pulse rounded-full bg-gradient-to-r from-accent to-accent-2" />
      </div>
    </div>
  );
}
