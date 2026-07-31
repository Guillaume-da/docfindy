// Pinned files, persisted in localStorage. Same pattern as theme.ts: a DOM
// event lets components subscribe via useSyncExternalStore.

export interface Favorite {
  path: string;
  name: string;
}

const KEY = "docfindy.favorites";
const EVENT = "docfindy-favorites-change";

// useSyncExternalStore needs a stable snapshot between changes.
let cache: Favorite[] | null = null;

export function getFavorites(): Favorite[] {
  if (!cache) {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
      cache = Array.isArray(raw)
        ? raw.filter((f): f is Favorite => !!f && typeof f.path === "string")
        : [];
    } catch {
      cache = [];
    }
  }
  return cache;
}

export function isFavorite(path: string): boolean {
  return getFavorites().some((f) => f.path === path);
}

export function toggleFavorite(fav: Favorite) {
  const list = getFavorites();
  const next = isFavorite(fav.path)
    ? list.filter((f) => f.path !== fav.path)
    : [...list, fav];
  localStorage.setItem(KEY, JSON.stringify(next));
  cache = next;
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function onFavoritesChange(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
