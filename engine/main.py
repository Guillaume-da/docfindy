#!/usr/bin/env python3
"""Findy engine — document indexing sidecar.

JSON-over-stdout CLI consumed by the Tauri (Rust) core. Every subcommand
prints exactly one JSON document on stdout; errors go to stderr with a
non-zero exit code.

The index is a single SQLite FTS5 database (content.db): file names AND
extracted text content (pdf/docx/odt/plain text), accent-insensitive,
BM25-ranked. files.json keeps the flat file inventory for content_search
and the UI.

Subcommands:
  detect  --path P [--path P2 ...]                 corpus summary per root
  build   --out DIR --path P [--path P2 ...]       full index build
  update  --out DIR                                incremental rebuild
  text    --path F [--max-chars N]                 extract text of one file
  search  --out DIR --needle S [--path F]          literal content search
  fts     --out DIR --query Q [--limit N]          ranked name+content search
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _emit(obj: dict) -> None:
    json.dump(obj, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


def _fail(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    sys.exit(code)


def _progress(stage: str, **extra) -> None:
    """Progress events on stderr as JSON lines; Rust forwards them to the UI."""
    print(json.dumps({"stage": stage, **extra}, ensure_ascii=False),
          file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# file walker — what gets indexed at all
# ---------------------------------------------------------------------------

# Windows system dirs — never useful in a personal file index, and huge.
# Matched by name at any depth, so they apply both to a C:\ root and to
# AppData nested under a C:\Users\<name> root.
SYSTEM_DIRS = {
    "windows", "program files", "program files (x86)", "programdata",
    "appdata", "$recycle.bin", "system volume information",
    "recovery", "perflogs", "onedrivetemp",
}

# Dev noise; hidden dirs (leading dot: .git, .venv, .cache, ...) are skipped
# by rule, these are the non-dotted stragglers.
NOISE_DIRS = {"node_modules", "__pycache__", "site-packages", "venv"}

SKIP_FILES = {"desktop.ini", "thumbs.db", ".ds_store"}

# Never index secrets, by name prefix or suffix; counted as skipped_sensitive.
SENSITIVE_PREFIXES = (".env", "id_rsa", "id_ed25519", "id_ecdsa")
SENSITIVE_SUFFIXES = {".pem", ".key", ".kdbx", ".pfx", ".p12", ".ppk"}

DOCUMENT_SUFFIXES = {
    ".pdf", ".docx", ".doc", ".odt", ".rtf", ".txt", ".md", ".markdown",
    ".epub", ".xlsx", ".xls", ".ods", ".csv", ".pptx", ".ppt", ".odp",
}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp",
                  ".ico", ".tif", ".tiff", ".heic"}
VIDEO_SUFFIXES = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm"}
AUDIO_SUFFIXES = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus"}
CODE_SUFFIXES = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go", ".java", ".c",
    ".cpp", ".h", ".sh", ".html", ".htm", ".css", ".xml", ".sql", ".php",
    ".rb", ".json", ".yaml", ".yml", ".toml", ".ini", ".log",
}

CATEGORY_BY_SUFFIX: dict[str, str] = {}
for _sfx, _cat in [(DOCUMENT_SUFFIXES, "document"), (IMAGE_SUFFIXES, "image"),
                   (VIDEO_SUFFIXES, "video"), (AUDIO_SUFFIXES, "audio"),
                   (CODE_SUFFIXES, "code")]:
    for _s in _sfx:
        CATEGORY_BY_SUFFIX[_s] = _cat

CATEGORIES = ("document", "image", "video", "audio", "code")


def _skip_dir(name: str) -> bool:
    n = name.lower()
    return (n.startswith(".") or n in SYSTEM_DIRS or n in NOISE_DIRS
            or n.endswith("_venv") or n.endswith("_env"))


def _is_sensitive(name: str) -> bool:
    n = name.lower()
    return (n.startswith(SENSITIVE_PREFIXES)
            or Path(n).suffix in SENSITIVE_SUFFIXES)


def _collect(root: Path) -> tuple[list[dict], int]:
    """Inventory of indexable files under root: (files, sensitive_count)."""
    files: list[dict] = []
    sensitive = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not _skip_dir(d)]
        for fn in filenames:
            if fn.lower() in SKIP_FILES:
                continue
            if _is_sensitive(fn):
                sensitive += 1
                continue
            cat = CATEGORY_BY_SUFFIX.get(Path(fn).suffix.lower())
            if not cat:
                continue
            fp = Path(dirpath) / fn
            try:
                st = fp.stat()
            except OSError:
                continue
            files.append({"path": str(fp), "name": fn, "category": cat,
                          "size": st.st_size, "mtime": int(st.st_mtime)})
    return files, sensitive


# ---------------------------------------------------------------------------
# detect
# ---------------------------------------------------------------------------

def cmd_detect(args: argparse.Namespace) -> None:
    out = []
    for p in args.path:
        root = Path(p).expanduser().resolve()
        if not root.exists():
            _fail(f"path not found: {root}")
        files, sensitive = _collect(root)
        counts: dict[str, int] = {}
        for f in files:
            counts[f["category"]] = counts.get(f["category"], 0) + 1
        out.append({
            "root": str(root),
            "total_files": len(files),
            "counts": counts,
            "skipped_sensitive": sensitive,
        })
    _emit({"roots": out})


# ---------------------------------------------------------------------------
# build / update
# ---------------------------------------------------------------------------

def _build(out_dir: Path, roots: list[Path]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    files_index: list[dict] = []
    for root in roots:
        _progress("detect", root=str(root))
        files, _sensitive = _collect(root)
        files_index += files
        _progress("detected", root=str(root), files=len(files))

    # dedupe by path (same file reachable from two roots)
    seen: set[str] = set()
    files_index = [f for f in files_index
                   if not (f["path"] in seen or seen.add(f["path"]))]

    (out_dir / "files.json").write_text(json.dumps({
        "roots": [str(r) for r in roots],
        "built_at": int(time.time()),
        "files": files_index,
    }, ensure_ascii=False), encoding="utf-8")

    _progress("fts", files=len(files_index))
    fts_docs = _build_fts(out_dir, files_index)

    # stale artifacts from the graphify era
    (out_dir / "graph.json").unlink(missing_ok=True)
    (out_dir / ".findy_extract.json").unlink(missing_ok=True)

    _emit({"ok": True, "files": len(files_index), "fts_docs": fts_docs,
           "seconds": round(time.time() - t0, 1)})


def cmd_build(args: argparse.Namespace) -> None:
    roots = [Path(p).expanduser().resolve() for p in args.path]
    for r in roots:
        if not r.exists():
            _fail(f"path not found: {r}")
    _build(Path(args.out), roots)


def cmd_update(args: argparse.Namespace) -> None:
    out_dir = Path(args.out)
    files_json = out_dir / "files.json"
    if not files_json.exists():
        _fail("no existing index: run build first")
    meta = json.loads(files_json.read_text(encoding="utf-8"))
    roots = [Path(r) for r in meta["roots"]]
    # cheap: the walk is fast, and _build_fts only re-extracts changed files
    _build(out_dir, roots)


# ---------------------------------------------------------------------------
# text extraction (agent read_file, preview, content search, FTS build)
# ---------------------------------------------------------------------------

TEXT_SUFFIXES = {
    ".txt", ".md", ".markdown", ".log", ".csv", ".json", ".yaml", ".yml",
    ".toml", ".ini", ".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go",
    ".java", ".c", ".cpp", ".h", ".sh", ".html", ".htm", ".css", ".xml",
    ".sql", ".php", ".rb",
}


def _extract_text(path: Path, max_chars: int) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError:
            return "(pdf text extraction unavailable: pypdf not installed)"
        try:
            reader = PdfReader(str(path))
            parts = []
            total = 0
            for i, page in enumerate(reader.pages):
                t = page.extract_text() or ""
                parts.append(f"[page {i + 1}]\n{t}")
                total += len(t)
                if total > max_chars:
                    break
            return "\n".join(parts)[:max_chars]
        except Exception as e:  # noqa: BLE001 — surface any parse error to the agent
            return f"(pdf extraction failed: {e})"
    if suffix == ".docx":
        try:
            import zipfile
            import xml.etree.ElementTree as ET
            w = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
            with zipfile.ZipFile(path) as z:
                root = ET.fromstring(z.read("word/document.xml"))
            paragraphs = []
            for para in root.iter(f"{w}p"):
                parts = []
                for el in para.iter():
                    if el.tag == f"{w}t" and el.text:
                        parts.append(el.text)
                    elif el.tag == f"{w}tab":
                        parts.append("\t")
                    elif el.tag in (f"{w}br", f"{w}cr"):
                        parts.append("\n")
                paragraphs.append("".join(parts))
            return "\n".join(paragraphs)[:max_chars]
        except Exception as e:  # noqa: BLE001 — surface any parse error to the agent
            return f"(docx extraction failed: {e})"
    if suffix == ".odt":
        try:
            import zipfile
            import xml.etree.ElementTree as ET
            t = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"

            def walk(el) -> str:
                out = []
                if el.tag == f"{t}tab":
                    out.append("\t")
                elif el.tag == f"{t}line-break":
                    out.append("\n")
                elif el.tag == f"{t}s":
                    n = el.get(f"{t}c")
                    out.append(" " * (int(n) if n and n.isdigit() else 1))
                if el.text:
                    out.append(el.text)
                for child in el:
                    out.append(walk(child))
                    if child.tail:
                        out.append(child.tail)
                return "".join(out)

            with zipfile.ZipFile(path) as z:
                root = ET.fromstring(z.read("content.xml"))
            blocks = [walk(p) for p in root.iter()
                      if p.tag in (f"{t}p", f"{t}h")]
            return "\n".join(blocks)[:max_chars]
        except Exception as e:  # noqa: BLE001 — surface any parse error to the agent
            return f"(odt extraction failed: {e})"
    if suffix in TEXT_SUFFIXES or not suffix:
        try:
            return path.read_text(encoding="utf-8", errors="replace")[:max_chars]
        except OSError as e:
            return f"(read failed: {e})"
    return f"(no text extraction for {suffix} files)"


def cmd_text(args: argparse.Namespace) -> None:
    p = Path(args.path).expanduser()
    if not p.is_file():
        _fail(f"not a file: {p}")
    _emit({"path": str(p), "text": _extract_text(p, args.max_chars)})


# ---------------------------------------------------------------------------
# FTS5 content index (names + extracted text, accent-insensitive, BM25)
# ---------------------------------------------------------------------------

# suffixes whose *content* goes into the FTS index; every file's *name* is
# indexed regardless, so images/videos stay findable by filename.
FTS_CONTENT_SUFFIXES = TEXT_SUFFIXES | {".pdf", ".docx", ".odt"}
FTS_MAX_CHARS = 300_000
FTS_MAX_FILE_BYTES = 50_000_000  # don't extract from files beyond 50 MB


def _fts_connect(out_dir: Path):
    import sqlite3
    db = sqlite3.connect(out_dir / "content.db")
    db.execute("CREATE TABLE IF NOT EXISTS meta("
               "path TEXT PRIMARY KEY, mtime INTEGER, size INTEGER)")
    db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5("
               "path UNINDEXED, name, text, "
               "tokenize='unicode61 remove_diacritics 2')")
    return db


def _build_fts(out_dir: Path, files: list[dict]) -> int:
    """Upsert one row per indexed file; re-extract only changed files.

    Extraction-failure sentinels from _extract_text (short parenthesized
    strings) are dropped so they never pollute search results.
    """
    db = _fts_connect(out_dir)
    old = {p: sig for p, sig in
           db.execute("SELECT path, mtime || ':' || size FROM meta")}
    now: set[str] = set()
    changed = 0
    for f in files:
        p = f["path"]
        now.add(p)
        sig = f"{f['mtime']}:{f['size']}"
        if old.get(p) == sig:
            continue
        fp = Path(p)
        text = ""
        if (fp.suffix.lower() in FTS_CONTENT_SUFFIXES
                and f["size"] <= FTS_MAX_FILE_BYTES):
            text = _extract_text(fp, FTS_MAX_CHARS)
            if text.startswith("(") and text.endswith(")") and len(text) < 200:
                text = ""
        db.execute("DELETE FROM docs WHERE path = ?", (p,))
        db.execute("INSERT INTO docs(path, name, text) VALUES (?, ?, ?)",
                   (p, f["name"], text))
        db.execute("INSERT INTO meta(path, mtime, size) VALUES (?, ?, ?) "
                   "ON CONFLICT(path) DO UPDATE SET "
                   "mtime = excluded.mtime, size = excluded.size",
                   (p, f["mtime"], f["size"]))
        changed += 1
        if changed % 50 == 0:
            _progress("fts", done=changed)
    for p in set(old) - now:
        db.execute("DELETE FROM docs WHERE path = ?", (p,))
        db.execute("DELETE FROM meta WHERE path = ?", (p,))
    db.commit()
    db.close()
    return changed


def cmd_fts(args: argparse.Namespace) -> None:
    out_dir = Path(args.out)
    if not (out_dir / "content.db").exists():
        _emit({"query": args.query, "hits": [],
               "note": "no content index: rebuild the index first"})
        return
    terms = [t for t in re.findall(r"\w+", args.query, re.UNICODE)
             if len(t) >= 2][:12]
    if not terms:
        _fail("empty query")
    # each term as a quoted prefix phrase — user text can't inject operators
    match = " OR ".join(f'"{t}"*' for t in terms)
    db = _fts_connect(out_dir)
    rows = db.execute(
        "SELECT docs.path, docs.name, bm25(docs, 0.0, 5.0, 1.0) AS rank, "
        "snippet(docs, 2, '[', ']', '…', 12), meta.size, meta.mtime "
        "FROM docs JOIN meta ON meta.path = docs.path "
        "WHERE docs MATCH ? ORDER BY rank LIMIT ?",
        (match, max(args.limit, 1))).fetchall()
    db.close()
    _emit({"query": args.query, "terms": terms, "hits": [
        {"path": r[0], "name": r[1], "score": round(-r[2], 3),
         "snippet": r[3], "size": r[4], "mtime": r[5]} for r in rows]})


# ---------------------------------------------------------------------------
# literal content search (exact locations: line / pdf page)
# ---------------------------------------------------------------------------

def cmd_search(args: argparse.Namespace) -> None:
    """Content search: literal needle, case-insensitive, line hits + snippets.

    Scope: a single file, or every indexed file (from files.json) when
    --path is omitted. PDFs searched via extracted text (page granularity).
    """
    needle = args.needle.lower()
    out_dir = Path(args.out)

    targets: list[Path] = []
    if args.path:
        targets = [Path(args.path).expanduser()]
    else:
        fj = out_dir / "files.json"
        if not fj.exists():
            _fail("no index: run build first")
        meta = json.loads(fj.read_text(encoding="utf-8"))
        targets = [Path(f["path"]) for f in meta["files"]]

    hits = []
    for f in targets:
        if len(hits) >= args.limit:
            break
        if not f.is_file():
            continue
        if f.suffix.lower() == ".pdf":
            text = _extract_text(f, 400_000)
            page = 0
            for block in text.split("[page "):
                if "]" in block:
                    num, _, body = block.partition("]")
                    if num.strip().isdigit():
                        page = int(num.strip())
                    if needle in body.lower():
                        idx = body.lower().index(needle)
                        snippet = body[max(0, idx - 80): idx + 120].replace("\n", " ")
                        hits.append({"path": str(f), "page": page,
                                     "line": None, "snippet": snippet.strip()})
                        if len(hits) >= args.limit:
                            break
        elif f.suffix.lower() in (".docx", ".odt"):
            text = _extract_text(f, 400_000)
            # line numbers are paragraph indexes here — good enough to locate
            for i, line in enumerate(text.splitlines(), 1):
                if needle in line.lower():
                    hits.append({"path": str(f), "page": None,
                                 "line": i, "snippet": line.strip()[:200]})
                    if len(hits) >= args.limit:
                        break
        elif f.suffix.lower() in TEXT_SUFFIXES or not f.suffix:
            try:
                lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for i, line in enumerate(lines, 1):
                if needle in line.lower():
                    hits.append({"path": str(f), "page": None,
                                 "line": i, "snippet": line.strip()[:200]})
                    if len(hits) >= args.limit:
                        break
    _emit({"needle": args.needle, "hits": hits})


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(prog="findy-engine")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("detect")
    p.add_argument("--path", action="append", required=True)
    p.set_defaults(fn=cmd_detect)

    p = sub.add_parser("build")
    p.add_argument("--path", action="append", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_build)

    p = sub.add_parser("update")
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_update)

    p = sub.add_parser("text")
    p.add_argument("--path", required=True)
    p.add_argument("--max-chars", type=int, default=60_000)
    p.set_defaults(fn=cmd_text)

    p = sub.add_parser("search")
    p.add_argument("--out", required=True)
    p.add_argument("--needle", required=True)
    p.add_argument("--path")
    p.add_argument("--limit", type=int, default=30)
    p.set_defaults(fn=cmd_search)

    p = sub.add_parser("fts")
    p.add_argument("--out", required=True)
    p.add_argument("--query", required=True)
    p.add_argument("--limit", type=int, default=10)
    p.set_defaults(fn=cmd_fts)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
