import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getTheme, onThemeChange, toggleTheme } from "../theme";
import { MoonIcon, SunIcon } from "./icons";

export default function ThemeToggle() {
  const { t } = useTranslation();
  const theme = useSyncExternalStore(onThemeChange, getTheme);
  const dark = theme === "dark";

  return (
    <button
      onClick={toggleTheme}
      title={dark ? t("theme.toLight") : t("theme.toDark")}
      className="grid h-[34px] w-[34px] place-items-center rounded-[9px] bg-fill-2 text-muted transition hover:bg-fill-hover hover:text-txt"
    >
      {dark ? (
        <SunIcon className="h-[17px] w-[17px]" />
      ) : (
        <MoonIcon className="h-[17px] w-[17px]" />
      )}
    </button>
  );
}
