// Light/dark theme, persisted in localStorage and applied via a `.light` class
// on <html>. Dark is the default. A DOM event lets components re-render on
// change without a global store.

export type Theme = "light" | "dark";

const KEY = "docfindy.theme";
const EVENT = "docfindy-theme-change";

export function getTheme(): Theme {
  return localStorage.getItem(KEY) === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("light", theme === "light");
}

export function setTheme(theme: Theme) {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function toggleTheme() {
  setTheme(getTheme() === "dark" ? "light" : "dark");
}

export function onThemeChange(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

// Apply the saved theme as early as possible to avoid a flash.
applyTheme(getTheme());
