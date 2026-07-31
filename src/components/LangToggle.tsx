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
    <div className="flex gap-0.5 rounded-[9px] bg-fill-2 p-0.5">
      {(["en", "es"] as const).map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          className={
            "rounded-[7px] px-3 py-[5px] text-xs font-semibold uppercase tracking-tight transition " +
            (lang === l
              ? "bg-fill-hover text-accent shadow-[0_1px_3px_rgba(0,0,0,0.15)]"
              : "text-muted hover:text-txt")
          }
        >
          {l}
        </button>
      ))}
    </div>
  );
}
