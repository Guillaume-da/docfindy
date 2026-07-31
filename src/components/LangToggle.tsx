import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../types";

export default function LangToggle({
  settings,
  onChanged,
}: {
  settings: AppSettings | null;
  onChanged: (s: AppSettings) => void;
}) {
  const { i18n } = useTranslation();
  const lang = (settings?.lang as string) || i18n.language || "en";

  async function setLang(next: "en" | "es") {
    i18n.changeLanguage(next);
    // Never invent the rest of the settings here: a literal fallback would
    // write roots: [] over a configured index. When the caller has no
    // settings to hand, read what is on disk before touching one field.
    const base = settings ?? (await invoke<AppSettings>("get_settings"));
    const s = { ...base, lang: next } as AppSettings;
    await invoke("save_settings", { settings: s });
    onChanged(s);
  }

  return (
    <div className="flex overflow-hidden rounded-lg border border-edge text-xs font-semibold">
      {(["en", "es"] as const).map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          className={
            "px-3 py-1.5 uppercase transition " +
            (lang === l
              ? "bg-gradient-to-r from-accent to-accent-2 text-ink"
              : "bg-panel-2 text-muted hover:text-txt")
          }
        >
          {l}
        </button>
      ))}
    </div>
  );
}
