import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import {
  getFavorites,
  isFavorite,
  onFavoritesChange,
  toggleFavorite,
} from "../favorites";
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

type SortMode = "relevance" | "recent" | "name";

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
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

const THUMB_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

function FileThumb({ name, path }: { name: string; path: string }) {
  const [broken, setBroken] = useState(false);
  if (!broken && THUMB_EXTS.has(extOf(name))) {
    return (
      <img
        src={convertFileSrc(path)}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        className="h-[44px] w-[44px] shrink-0 rounded-[12px] border border-edge-soft object-cover shadow-sm"
      />
    );
  }
  return <ExtBadge name={name} />;
}

function ExtBadge({ name }: { name: string }) {
  const ext = extOf(name);
  const style = EXT_STYLE[ext] ?? {
    label: (ext || "?").slice(0, 3).toUpperCase(),
    from: "#7A7A80",
    to: "#5A5A60",
  };
  return (
    <div
      className="grid h-[44px] w-[44px] shrink-0 place-items-center rounded-[12px] text-[10px] font-extrabold tracking-wide text-white"
      style={{
        background: `linear-gradient(135deg, ${style.from}, ${style.to})`,
        boxShadow:
          "0 5px 12px -7px rgba(0,0,0,0.8), inset 0 0.5px 0 rgba(255,255,255,0.3)",
      }}
    >
      {style.label}
    </div>
  );
}

function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("[") && part.endsWith("]") ? (
          <mark
            key={index}
            className="rounded bg-accent/20 px-0.5 text-txt-strong"
          >
            {part.slice(1, -1)}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

function folderName(path: string) {
  const parts = path.split(/[\\/]/);
  return parts.length >= 2 ? parts[parts.length - 2] : path;
}

function fmtSize(size?: number) {
  if (size == null) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
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
  const [sortMode, setSortMode] = useState<SortMode>("relevance");
  const [smartTerms, setSmartTerms] = useState<string[] | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; hit: Hit } | null>(
    null,
  );
  const favorites = useSyncExternalStore(onFavoritesChange, getFavorites);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const suggestions = (() => {
    const value: unknown = t("chat.suggestions", { returnObjects: true });
    return Array.isArray(value) ? (value as string[]) : [];
  })();

  const displayedHits = useMemo(() => {
    if (sortMode === "relevance") return hits;
    const sorted = [...hits];
    if (sortMode === "recent") {
      sorted.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    } else {
      sorted.sort((a, b) =>
        (a.name || baseName(a.path)).localeCompare(
          b.name || baseName(b.path),
          i18n.language,
          { sensitivity: "base" },
        ),
      );
    }
    return sorted;
  }, [hits, sortMode, i18n.language]);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    setSel(0);
  }, [sortMode]);

  async function smartSearch() {
    const query = q.trim();
    if (!query || busy) return;
    const id = ++seq.current;
    setBusy(true);
    setSmartTerms(null);
    setNote(null);
    try {
      const result = await invoke<SearchResult & { expanded?: string[] }>(
        "smart_search",
        { query },
      );
      if (id !== seq.current) return;
      setHits(result.hits ?? []);
      setSmartTerms(result.expanded ?? []);
      setSel(0);
    } catch (error) {
      if (id !== seq.current) return;
      setNote(
        String(error).includes("no_api_key")
          ? t("chat.smartNoKey")
          : String(error),
      );
    } finally {
      if (id === seq.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (displayedHits.length === 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel, displayedHits.length]);

  useEffect(() => {
    const query = q.trim();
    setSmartTerms(null);
    if (!query) {
      seq.current += 1;
      setHits([]);
      setNote(null);
      setBusy(false);
      setSel(0);
      return;
    }
    const id = ++seq.current;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const result = await invoke<SearchResult>("quick_search", { query });
        if (id !== seq.current) return;
        setHits(result.hits ?? []);
        setNote(result.note ?? null);
        setSel(0);
      } catch (error) {
        if (id !== seq.current) return;
        setHits([]);
        setNote(String(error));
      } finally {
        if (id === seq.current) setBusy(false);
      }
    }, 190);
    return () => clearTimeout(timer);
  }, [q]);

  function pick(hit: Hit) {
    setActivePath(hit.path);
    onShowFile(hit.path);
  }

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

  const favSet = new Set(favorites.map((favorite) => favorite.path));
  const hasQuery = !!q.trim();

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 bg-titlebar/25 px-[22px] pb-4 pt-4">
        <div className="relative flex items-center">
          <SearchIcon className="pointer-events-none absolute left-4 h-[19px] w-[19px] text-muted-2" />
          <input
            ref={searchRef}
            autoFocus
            value={q}
            onChange={(event) => setQ(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && displayedHits.length > 0) {
                event.preventDefault();
                setSel((current) =>
                  Math.min(current + 1, displayedHits.length - 1),
                );
              } else if (event.key === "ArrowUp" && displayedHits.length > 0) {
                event.preventDefault();
                setSel((current) => Math.max(current - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (displayedHits[sel]) pick(displayedHits[sel]);
              } else if (event.key === "Escape" && q) {
                event.preventDefault();
                setQ("");
              }
            }}
            placeholder={t("chat.placeholder")}
            aria-label={t("chat.placeholder")}
            className="w-full rounded-[15px] border border-edge-soft bg-fill py-[14px] pl-[46px] pr-[112px] text-[16px] tracking-tight text-txt shadow-[0_10px_35px_-28px_rgba(0,0,0,0.9)] outline-none transition placeholder:text-muted-2 focus:border-accent/40 focus:bg-fill-2 focus:shadow-[0_0_0_4px_rgba(10,132,255,0.16)]"
          />
          <div className="absolute right-3 flex items-center gap-1.5">
            {busy && <span className="thinking-dot h-2 w-2 rounded-full bg-accent" />}
            {hasQuery ? (
              <button
                onClick={smartSearch}
                disabled={busy}
                title={t("chat.smart")}
                aria-label={t("chat.smart")}
                className="grid h-7 w-7 place-items-center rounded-[8px] bg-accent/12 text-[14px] transition hover:bg-accent/20 hover:scale-105 disabled:opacity-40"
              >
                ✨
              </button>
            ) : (
              <kbd
                className="rounded-md border border-edge bg-fill-2 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-muted-2"
                title={t("chat.searchShortcut")}
              >
                Ctrl K
              </kbd>
            )}
            {q && (
              <button
                onClick={() => setQ("")}
                title={t("chat.clear")}
                aria-label={t("chat.clear")}
                className="grid h-7 w-7 place-items-center rounded-[8px] bg-fill-2 text-[16px] leading-none text-muted-2 transition hover:bg-fill-hover hover:text-txt"
              >
                ×
              </button>
            )}
          </div>
        </div>
      </div>

      {hasQuery && (displayedHits.length > 0 || busy) && (
        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-edge-soft bg-panel/25 px-[18px] py-2.5">
          <div className="flex items-center gap-2 text-[11.5px] font-semibold text-muted">
            <span>{t("chat.results", { count: displayedHits.length })}</span>
            {busy && <span className="text-accent">· {t("chat.thinking")}</span>}
          </div>
          <div
            className="flex items-center rounded-[9px] bg-fill p-0.5"
            role="group"
            aria-label={t("chat.sort")}
          >
            {(["relevance", "recent", "name"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setSortMode(mode)}
                className={
                  "rounded-[7px] px-2.5 py-1 text-[10.5px] font-semibold transition " +
                  (sortMode === mode
                    ? "bg-fill-hover text-txt-strong shadow-sm"
                    : "text-muted-2 hover:text-txt")
                }
                aria-pressed={sortMode === mode}
              >
                {t(`chat.${mode}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-edge-soft px-[14px] py-3.5">
        {!hasQuery && (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <div className="relative mb-3.5 grid h-24 w-24 place-items-center">
              <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle,rgba(10,132,255,0.22),transparent_70%)] halo-pulse" />
              <div className="grid h-[72px] w-[72px] place-items-center rounded-[22px] border border-white/10 bg-gradient-to-br from-accent to-accent-2 shadow-[0_14px_30px_-10px_rgba(10,132,255,0.55)]">
                <SearchGlyph className="h-[34px] w-[34px]" />
              </div>
            </div>
            <h1 className="text-[27px] font-bold tracking-tight text-txt-strong">
              {t("chat.emptyTitle")}
            </h1>
            <p className="mt-2 max-w-[420px] text-[14px] leading-relaxed text-muted">
              {t("chat.empty")}
            </p>
            {suggestions.length > 0 && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {suggestions.map((label) => (
                  <button
                    key={label}
                    onClick={() => setQ(label)}
                    className="rounded-full border border-edge bg-fill px-4 py-2 text-[12.5px] font-medium text-muted transition hover:-translate-y-px hover:bg-fill-hover hover:text-txt"
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
                  {favorites.map((favorite) => (
                    <button
                      key={favorite.path}
                      onClick={() => {
                        setActivePath(favorite.path);
                        onShowFile(favorite.path);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setMenu({
                          x: event.clientX,
                          y: event.clientY,
                          hit: {
                            path: favorite.path,
                            name: favorite.name,
                            score: 0,
                            snippet: "",
                          },
                        });
                      }}
                      className="flex w-full items-center gap-2.5 rounded-[11px] border border-edge-soft bg-panel-2 px-3 py-2 text-left transition hover:bg-fill-hover"
                      title={favorite.path}
                    >
                      <span className="scale-[0.72]">
                        <ExtBadge name={favorite.name} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-txt">
                        {favorite.name}
                      </span>
                      <span className="max-w-[140px] truncate text-[11px] text-muted-2">
                        {folderName(favorite.path)}
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
              <div className="mb-2.5 flex flex-wrap items-center gap-1.5 px-1 text-[10px] text-muted">
                <span className="font-semibold text-accent">
                  ✨ {t("chat.smartTerms")}:
                </span>
                {smartTerms.map((term, index) => (
                  <span key={index} className="rounded-full bg-pill px-2 py-0.5">
                    {term}
                  </span>
                ))}
              </div>
            )}

            {!busy && displayedHits.length === 0 && !note && (
              <div className="px-6 py-16 text-center">
                <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl border border-edge bg-panel text-muted-2">
                  <SearchIcon className="h-5 w-5" />
                </div>
                <div className="mb-1 text-[15px] font-semibold text-txt-strong">
                  {t("chat.noResultsTitle")}
                </div>
                <div className="text-[13px] text-muted-2">{t("chat.noResults")}</div>
              </div>
            )}

            <div ref={listRef} className="space-y-2" role="listbox">
              {displayedHits.map((hit, index) => {
                const opened = activePath === hit.path;
                const focused = sel === index;
                const name = hit.name || baseName(hit.path);
                const size = fmtSize(hit.size);
                return (
                  <button
                    key={hit.path}
                    data-idx={index}
                    role="option"
                    aria-selected={focused}
                    aria-current={opened ? "true" : undefined}
                    onFocus={() => setSel(index)}
                    onMouseEnter={() => setSel(index)}
                    onClick={() => {
                      setSel(index);
                      pick(hit);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenu({ x: event.clientX, y: event.clientY, hit });
                    }}
                    className={
                      "group relative block w-full overflow-hidden rounded-[14px] border px-[13px] py-3 text-left transition duration-150 " +
                      (opened
                        ? "border-accent/55 bg-row-selected shadow-[0_10px_30px_-24px_rgba(10,132,255,0.95)]"
                        : focused
                          ? "border-accent/25 bg-fill-2 ring-1 ring-inset ring-accent/20"
                          : "border-edge-soft bg-panel-2 hover:-translate-y-px hover:border-edge hover:bg-fill-hover")
                    }
                    title={hit.path}
                  >
                    {opened && (
                      <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-accent" />
                    )}
                    <div className="flex items-start gap-[13px]">
                      <FileThumb name={name} path={hit.path} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1 truncate text-[13.5px] font-semibold tracking-tight text-txt-strong">
                            {name}
                          </div>
                          {opened && (
                            <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-accent">
                              {t("chat.opened")}
                            </span>
                          )}
                          {favSet.has(hit.path) && (
                            <StarIcon className="h-3 w-3 shrink-0 text-accent" filled />
                          )}
                        </div>
                        {hit.snippet && (
                          <div className="mt-1 max-h-[36px] overflow-hidden text-[12.5px] leading-[18px] text-muted">
                            <Snippet text={hit.snippet} />
                          </div>
                        )}
                        <div className="mt-2 flex min-w-0 items-center gap-2 text-[10.5px] font-medium text-muted-2">
                          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-pill px-2 py-[3px] pl-[7px]">
                            <FolderIcon className="h-[11px] w-[11px] shrink-0" />
                            <span className="truncate">{folderName(hit.path)}</span>
                          </span>
                          {size && <span className="shrink-0">{size}</span>}
                          {hit.mtime && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="shrink-0">
                                {new Date(hit.mtime * 1000).toLocaleDateString(
                                  i18n.language,
                                )}
                              </span>
                            </>
                          )}
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
