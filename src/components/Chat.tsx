import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { getFavorites, isFavorite, onFavoritesChange, toggleFavorite } from "../favorites";
import {
  CopyIcon,
  FolderIcon,
  MailIcon,
  OpenIcon,
  SearchGlyph,
  SearchIcon,
  StarIcon,
} from "./icons";

interface Hit {
  path: string;
  name: string;
  score: number;
  snippet: string;
  size?: number;
  mtime?: number;
}

interface SearchResult {
  hits: Hit[];
  note?: string;
}

// Colored extension badge, keyed off the file type — mirrors the design mock.
const EXT_STYLE: Record<string, { label: string; from: string; to: string }> = {
  doc: { label: "DOC", from: "#0A84FF", to: "#0A6CFF" },
  docx: { label: "DOC", from: "#0A84FF", to: "#0A6CFF" },
  pdf: { label: "PDF", from: "#FF3B30", to: "#D70015" },
  fig: { label: "FIG", from: "#AF52DE", to: "#8944AB" },
  xls: { label: "XLS", from: "#34C759", to: "#248A3D" },
  xlsx: { label: "XLS", from: "#34C759", to: "#248A3D" },
  csv: { label: "CSV", from: "#34C759", to: "#248A3D" },
  ppt: { label: "PPT", from: "#FF9500", to: "#C93400" },
  pptx: { label: "PPT", from: "#FF9500", to: "#C93400" },
  png: { label: "IMG", from: "#FF2D55", to: "#D30F45" },
  jpg: { label: "IMG", from: "#FF2D55", to: "#D30F45" },
  jpeg: { label: "IMG", from: "#FF2D55", to: "#D30F45" },
  gif: { label: "IMG", from: "#FF2D55", to: "#D30F45" },
  txt: { label: "TXT", from: "#8E8E93", to: "#636366" },
  md: { label: "MD", from: "#8E8E93", to: "#636366" },
};

function extOf(name: string) {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

const THUMB_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

// Image files show a real thumbnail; anything else (or a broken image) falls
// back to the colored extension badge.
function FileThumb({ name, path }: { name: string; path: string }) {
  const [broken, setBroken] = useState(false);
  if (!broken && THUMB_EXTS.has(extOf(name))) {
    return (
      <img
        src={convertFileSrc(path)}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        className="h-[42px] w-[42px] shrink-0 rounded-[11px] border border-edge-soft object-cover"
      />
    );
  }
  return <ExtBadge name={name} />;
}

function ExtBadge({ name }: { name: string }) {
  const ext = extOf(name);
  const s = EXT_STYLE[ext] ?? {
    label: (ext || "?").slice(0, 3).toUpperCase(),
    from: "#7A7A80",
    to: "#5A5A60",
  };
  return (
    <div
      className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[11px] text-[10px] font-extrabold tracking-wide text-white"
      style={{
        background: `linear-gradient(135deg, ${s.from}, ${s.to})`,
        boxShadow:
          "0 3px 8px -3px rgba(0,0,0,0.35), inset 0 0.5px 0 rgba(255,255,255,0.3)",
      }}
    >
      {s.label}
    </div>
  );
}

// FTS snippets mark matched terms with [ ]; render those highlighted.
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("[") && p.endsWith("]") ? (
          <mark
            key={i}
            className="rounded bg-accent/20 px-0.5 text-txt-strong"
          >
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

function folderName(path: string) {
  const parts = path.split(/[\\/]/);
  return parts.length >= 2 ? parts[parts.length - 2] : path;
}

export default function Chat({
  onShowFile,
}: {
  onShowFile: (path: string, summary?: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [smartTerms, setSmartTerms] = useState<string[] | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; hit: Hit } | null>(
    null,
  );
  const favorites = useSyncExternalStore(onFavoritesChange, getFavorites);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const suggestions = (() => {
    const s: unknown = t("chat.suggestions", { returnObjects: true });
    return Array.isArray(s) ? (s as string[]) : [];
  })();

  async function smartSearch() {
    const query = q.trim();
    if (!query || busy) return;
    const id = ++seq.current; // invalidate any pending instant search
    setBusy(true);
    setSmartTerms(null);
    setNote(null);
    try {
      const res = await invoke<SearchResult & { expanded?: string[] }>(
        "smart_search",
        { query },
      );
      if (id !== seq.current) return;
      setHits(res.hits ?? []);
      setSmartTerms(res.expanded ?? []);
      setSel(0);
    } catch (e) {
      if (id !== seq.current) return;
      setNote(
        String(e).includes("no_api_key") ? t("chat.smartNoKey") : String(e),
      );
    } finally {
      if (id === seq.current) setBusy(false);
    }
  }

  // keep the keyboard-selected result scrolled into view
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // search-as-you-type: debounced, with stale-response guarding
  useEffect(() => {
    const query = q.trim();
    setSmartTerms(null); // typing returns to plain instant search
    if (!query) {
      setHits([]);
      setNote(null);
      setBusy(false);
      return;
    }
    const id = ++seq.current;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const res = await invoke<SearchResult>("quick_search", { query });
        if (id !== seq.current) return; // a newer keystroke already fired
        setHits(res.hits ?? []);
        setNote(res.note ?? null);
        setSel(0);
      } catch (e) {
        if (id !== seq.current) return;
        setHits([]);
        setNote(String(e));
      } finally {
        if (id === seq.current) setBusy(false);
      }
    }, 160);
    return () => clearTimeout(timer);
  }, [q]);

  function pick(h: Hit) {
    setActivePath(h.path);
    onShowFile(h.path);
  }

  // Right-click quick actions on a result card.
  function menuItems(hit: Hit): MenuItem[] {
    const name = hit.name || baseName(hit.path);
    const pinned = isFavorite(hit.path);
    return [
      {
        label: t("menu.open"),
        icon: <OpenIcon className="h-[14px] w-[14px]" />,
        onClick: () => invoke("open_file", { path: hit.path }),
      },
      {
        label: t("menu.reveal"),
        icon: <FolderIcon className="h-[14px] w-[14px]" />,
        onClick: () => invoke("reveal_in_folder", { path: hit.path }),
      },
      {
        label: t("menu.copyPath"),
        icon: <CopyIcon className="h-[14px] w-[14px]" />,
        separator: true,
        onClick: () => navigator.clipboard.writeText(hit.path),
      },
      {
        label: t("menu.copyFile"),
        icon: <CopyIcon className="h-[14px] w-[14px]" />,
        onClick: async () => {
          try {
            await invoke("copy_file_to_clipboard", { path: hit.path });
          } catch {
            // unsupported platform — fall back to copying the path
            await navigator.clipboard.writeText(hit.path);
          }
        },
      },
      {
        label: t("menu.email"),
        icon: <MailIcon className="h-[14px] w-[14px]" />,
        onClick: () =>
          openUrl(
            `mailto:?subject=${encodeURIComponent(name)}&body=${encodeURIComponent(hit.path)}`,
          ),
      },
      {
        label: pinned ? t("menu.unpin") : t("menu.pin"),
        icon: <StarIcon className="h-[14px] w-[14px]" filled={pinned} />,
        separator: true,
        onClick: () => toggleFavorite({ path: hit.path, name }),
      },
    ];
  }

  const favSet = new Set(favorites.map((f) => f.path));
  const hasQuery = !!q.trim();

  return (
    <div className="flex h-full flex-col">
      {/* Spotlight-style search field */}
      <div className="flex-shrink-0 px-[22px] pb-4 pt-4">
        <div className="relative flex items-center">
          <SearchIcon className="pointer-events-none absolute left-4 h-[19px] w-[19px] text-muted-2" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, hits.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (hits[sel]) pick(hits[sel]);
              }
            }}
            placeholder={t("chat.placeholder")}
            className="w-full rounded-[13px] bg-fill py-[15px] pl-[46px] pr-[46px] text-[17px] tracking-tight text-txt outline-none transition placeholder:text-muted-2 focus:bg-fill-2 focus:shadow-[0_0_0_4px_rgba(10,132,255,0.22)]"
          />
          <div className="absolute right-3 flex items-center gap-1.5">
            {busy && (
              <span className="thinking-dot h-2 w-2 rounded-full bg-accent" />
            )}
            {hasQuery && (
              <button
                onClick={smartSearch}
                disabled={busy}
                title={t("chat.smart")}
                className="text-base transition hover:scale-110 disabled:opacity-40"
              >
                ✨
              </button>
            )}
            {q && (
              <button
                onClick={() => setQ("")}
                title={t("chat.clear")}
                className="grid h-6 w-6 place-items-center rounded-full bg-fill-2 text-[15px] leading-none text-muted-2 transition hover:bg-fill-hover"
              >
                ×
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Results / empty state */}
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-edge-soft px-[14px] py-3.5">
        {!hasQuery && (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <div className="relative mb-3.5 grid h-24 w-24 place-items-center">
              <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle,rgba(10,132,255,0.22),transparent_70%)] halo-pulse" />
              <div className="grid h-[72px] w-[72px] place-items-center rounded-[22px] bg-gradient-to-br from-accent to-accent-2 shadow-[0_14px_30px_-10px_rgba(10,132,255,0.55)]">
                <SearchGlyph className="h-[34px] w-[34px]" />
              </div>
            </div>
            <h1 className="text-[28px] font-bold tracking-tight text-txt-strong">
              {t("chat.emptyTitle")}
            </h1>
            <p className="mt-2 max-w-[420px] text-[15px] leading-relaxed text-muted">
              {t("chat.empty")}
            </p>
            {suggestions.length > 0 && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {suggestions.map((label) => (
                  <button
                    key={label}
                    onClick={() => setQ(label)}
                    className="rounded-full border border-edge bg-fill px-4 py-2 text-[13px] font-medium text-muted transition hover:-translate-y-px hover:bg-fill-hover hover:text-txt"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {favorites.length > 0 && (
              <div className="mt-8 w-full max-w-[440px]">
                <div className="mb-2.5 flex items-center justify-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-label">
                  <StarIcon className="h-3 w-3 text-accent" filled />
                  {t("chat.pinned")}
                </div>
                <div className="space-y-1.5">
                  {favorites.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => {
                        setActivePath(f.path);
                        onShowFile(f.path);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({
                          x: e.clientX,
                          y: e.clientY,
                          hit: { path: f.path, name: f.name, score: 0, snippet: "" },
                        });
                      }}
                      className="flex w-full items-center gap-2.5 rounded-[11px] border border-edge-soft bg-panel-2 px-3 py-2 text-left transition hover:bg-fill-hover"
                      title={f.path}
                    >
                      <span className="scale-[0.72]">
                        <ExtBadge name={f.name} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-txt">
                        {f.name}
                      </span>
                      <span className="max-w-[140px] truncate text-[11px] text-muted-2">
                        {folderName(f.path)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {hasQuery && (
          <>
            {note && (
              <div className="mb-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-500">
                {note}
              </div>
            )}

            {smartTerms && smartTerms.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-1 px-1 text-[10px] text-muted">
                <span className="font-semibold text-accent">
                  ✨ {t("chat.smartTerms")}:
                </span>
                {smartTerms.map((term, i) => (
                  <span
                    key={i}
                    className="rounded-full bg-pill px-2 py-0.5"
                  >
                    {term}
                  </span>
                ))}
              </div>
            )}

            {!busy && hits.length === 0 && !note && (
              <div className="px-6 py-16 text-center">
                <div className="mb-1 text-[15px] font-semibold text-txt-strong">
                  {t("chat.noResultsTitle")}
                </div>
                <div className="text-[13px] text-muted-2">
                  {t("chat.noResults")}
                </div>
              </div>
            )}

            <div ref={listRef} className="space-y-2">
              {hits.map((h, i) => {
                const active = activePath === h.path || sel === i;
                return (
                  <button
                    key={h.path}
                    data-idx={i}
                    onClick={() => {
                      setSel(i);
                      pick(h);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, hit: h });
                    }}
                    className={
                      "block w-full rounded-xl border px-[13px] py-3 text-left transition " +
                      (active
                        ? "border-transparent bg-row-selected shadow-[0_0_0_1.5px_#0A84FF]"
                        : "border-edge-soft bg-panel-2 hover:bg-fill-hover")
                    }
                  >
                    <div className="flex items-start gap-[13px]">
                      <FileThumb
                        name={h.name || baseName(h.path)}
                        path={h.path}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-txt-strong">
                            {h.name || baseName(h.path)}
                          </div>
                          {favSet.has(h.path) && (
                            <StarIcon
                              className="h-3 w-3 shrink-0 text-accent"
                              filled
                            />
                          )}
                          {h.mtime && (
                            <div className="shrink-0 text-[11px] font-medium text-muted-2">
                              {new Date(h.mtime * 1000).toLocaleDateString(
                                i18n.language,
                              )}
                            </div>
                          )}
                        </div>
                        {h.snippet && (
                          <div className="mt-1 truncate text-[12.5px] leading-snug text-muted">
                            <Snippet text={h.snippet} />
                          </div>
                        )}
                        <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full bg-pill px-2 py-[3px] pl-[7px]">
                          <FolderIcon className="h-[11px] w-[11px] shrink-0 text-muted-2" />
                          <span className="truncate text-[11px] font-medium text-muted-2">
                            {folderName(h.path)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.hit)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
