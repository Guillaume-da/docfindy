#!/usr/bin/env python3
"""DocFindy engine — document indexing sidecar.

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
import difflib
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path


# Force UTF-8 on stdout/stderr. When the sidecar's streams are pipes (as under
# Tauri), Python otherwise encodes with the locale codepage (cp1252 on Windows),
# which corrupts accented JSON and breaks the Rust UTF-8 reader.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass


def _fold(s: str) -> str:
    """Lowercase + strip diacritics — mirrors FTS5 'remove_diacritics 2'."""
    return "".join(c for c in unicodedata.normalize("NFKD", s.lower())
                   if not unicodedata.combining(c))


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

    # stale artifacts from the graphify era — these names are historical, they
    # are what is actually on disk from older versions, so they do not follow
    # the DocFindy rename
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


# --- structured extraction: heading-aware blocks for docx / odt -------------
# Each block is {"level": int, "text": str}; level 0 = body paragraph,
# 1..6 = heading depth. Consumed by cmd_blocks (preview outline) and, joined,
# by _extract_text (FTS / search / read_file).

_DOCX_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_ODT_T = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"


def _docx_para_text(para) -> str:
    parts = []
    for el in para.iter():
        if el.tag == f"{_DOCX_W}t" and el.text:
            parts.append(el.text)
        elif el.tag == f"{_DOCX_W}tab":
            parts.append("\t")
        elif el.tag in (f"{_DOCX_W}br", f"{_DOCX_W}cr"):
            parts.append("\n")
    return "".join(parts)


def _docx_para_level(para) -> int:
    pPr = para.find(f"{_DOCX_W}pPr")
    if pPr is None:
        return 0
    style = pPr.find(f"{_DOCX_W}pStyle")
    if style is not None:
        val = style.get(f"{_DOCX_W}val", "") or ""
        m = re.match(r"(?i)(?:heading|titre|title)\s*(\d)", val)
        if m:
            return min(int(m.group(1)), 6)
        if re.fullmatch(r"(?i)title|titre", val):
            return 1
    olvl = pPr.find(f"{_DOCX_W}outlineLvl")
    if olvl is not None:
        try:
            return min(int(olvl.get(f"{_DOCX_W}val", "0")) + 1, 6)
        except ValueError:
            pass
    return 0


def _docx_blocks(path: Path, max_chars: int) -> list[dict]:
    import zipfile
    import xml.etree.ElementTree as ET
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    blocks, total = [], 0
    for para in root.iter(f"{_DOCX_W}p"):
        text = _docx_para_text(para)
        if not text.strip():
            continue
        blocks.append({"level": _docx_para_level(para), "text": text})
        total += len(text)
        if total > max_chars:
            break
    return blocks


# --- rich HTML rendering: faithful docx preview (formatting/tables/images) --
# Produces a sanitized HTML fragment from a whitelist of tags we emit
# ourselves; all document text is escaped, so it is safe to inject with
# dangerouslySetInnerHTML on the front end.

_R_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_A_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_IMG_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp",
}
_JC_ALIGN = {
    "center": "center", "right": "right", "end": "right",
    "both": "justify", "distribute": "justify",
}


def _docx_rels(z) -> dict:
    import xml.etree.ElementTree as ET
    rels: dict[str, str] = {}
    try:
        root = ET.fromstring(z.read("word/_rels/document.xml.rels"))
    except Exception:  # noqa: BLE001 — no rels = no images/links
        return rels
    for rel in root:
        rid, target = rel.get("Id"), rel.get("Target")
        if rid and target:
            rels[rid] = target
    return rels


def _run_wrappers(rPr):
    """(open_tags, close_tags) for a run's bold/italic/underline/etc."""
    if rPr is None:
        return "", ""
    W, opens, closes = _DOCX_W, [], []

    def wrap(tag):
        opens.append(f"<{tag}>")
        closes.insert(0, f"</{tag}>")

    if rPr.find(f"{W}b") is not None:
        wrap("strong")
    if rPr.find(f"{W}i") is not None:
        wrap("em")
    u = rPr.find(f"{W}u")
    if u is not None and (u.get(f"{W}val") or "single") != "none":
        wrap("u")
    if rPr.find(f"{W}strike") is not None:
        wrap("s")
    va = rPr.find(f"{W}vertAlign")
    if va is not None:
        v = va.get(f"{W}val")
        if v == "superscript":
            wrap("sup")
        elif v == "subscript":
            wrap("sub")
    return "".join(opens), "".join(closes)


def _docx_rich(path: Path, max_chars: int) -> str | None:
    """Faithful HTML fragment for a .docx: formatting, lists, tables, images."""
    import base64
    import html as htmlmod
    import zipfile
    import xml.etree.ElementTree as ET

    W = _DOCX_W
    try:
        with zipfile.ZipFile(path) as z:
            root = ET.fromstring(z.read("word/document.xml"))
            rels = _docx_rels(z)
            media: dict[str, str | None] = {}
            budget = [6_000_000]  # total base64-inlined image bytes
            total = [0]

            def img_uri(rid):
                if rid in media:
                    return media[rid]
                media[rid] = None
                target = rels.get(rid)
                if not target:
                    return None
                if target.startswith("/"):
                    name = target[1:]
                elif target.startswith("word/"):
                    name = target
                else:
                    name = "word/" + target
                ext = os.path.splitext(name)[1].lower()
                mime = _IMG_MIME.get(ext)
                if not mime:
                    return None
                try:
                    data = z.read(name)
                except KeyError:
                    return None
                if len(data) > 3_000_000 or len(data) > budget[0]:
                    return None
                budget[0] -= len(data)
                uri = "data:%s;base64,%s" % (
                    mime, base64.b64encode(data).decode("ascii"))
                media[rid] = uri
                return uri

            def run_html(r):
                o, c = _run_wrappers(r.find(f"{W}rPr"))
                inner = []
                for el in r.iter():
                    tag = el.tag
                    if tag == f"{W}t" and el.text:
                        inner.append(htmlmod.escape(el.text))
                        total[0] += len(el.text)
                    elif tag == f"{W}tab":
                        inner.append("<span class=\"docx-tab\"></span>")
                    elif tag in (f"{W}br", f"{W}cr"):
                        inner.append("<br/>")
                    elif tag == f"{_A_NS}blip":
                        uri = img_uri(el.get(f"{_R_NS}embed"))
                        if uri:
                            inner.append(
                                '<img class="docx-img" src="%s" alt=""/>' % uri)
                if not inner:
                    return ""
                return o + "".join(inner) + c

            def para_inner(p):
                parts = []
                for child in p:
                    ct = child.tag
                    if ct == f"{W}r":
                        parts.append(run_html(child))
                    elif ct == f"{W}hyperlink":
                        seg = "".join(run_html(r)
                                      for r in child.findall(f"{W}r"))
                        if not seg:
                            continue
                        href = rels.get(child.get(f"{_R_NS}id") or "")
                        if href and href.startswith(
                                ("http://", "https://", "mailto:")):
                            parts.append(
                                '<a href="%s" target="_blank" '
                                'rel="noreferrer">%s</a>'
                                % (htmlmod.escape(href, quote=True), seg))
                        else:
                            parts.append("<span class=\"docx-link\">%s</span>"
                                         % seg)
                return "".join(parts)

            def para_html(p):
                """(is_list_item, html_fragment)."""
                pPr = p.find(f"{W}pPr")
                align = ""
                is_list = False
                if pPr is not None:
                    jc = pPr.find(f"{W}jc")
                    if jc is not None:
                        a = _JC_ALIGN.get(jc.get(f"{W}val") or "")
                        if a:
                            align = ' style="text-align:%s"' % a
                    is_list = pPr.find(f"{W}numPr") is not None
                content = para_inner(p)
                if is_list:
                    return True, content
                if not content.strip():
                    return False, '<p class="docx-sp"></p>'
                level = _docx_para_level(p)
                if 1 <= level <= 6:
                    return False, "<h%d%s>%s</h%d>" % (
                        level, align, content, level)
                return False, "<p%s>%s</p>" % (align, content)

            def table_html(tbl):
                rows = []
                for tr in tbl.findall(f"{W}tr"):
                    cells = []
                    for tc in tr.findall(f"{W}tc"):
                        span = 1
                        tcPr = tc.find(f"{W}tcPr")
                        if tcPr is not None:
                            gs = tcPr.find(f"{W}gridSpan")
                            if gs is not None:
                                try:
                                    span = int(gs.get(f"{W}val", "1"))
                                except ValueError:
                                    span = 1
                        body = []
                        for p in tc.findall(f"{W}p"):
                            _, frag = para_html(p)
                            body.append(frag)
                        attr = ' colspan="%d"' % span if span > 1 else ""
                        cells.append("<td%s>%s</td>" % (attr, "".join(body)))
                    rows.append("<tr>%s</tr>" % "".join(cells))
                return ('<table class="docx-table"><tbody>%s</tbody></table>'
                        % "".join(rows))

            out = []
            open_list = False
            body = root.find(f"{W}body")
            if body is None:
                return None
            for child in body:
                tag = child.tag
                if tag == f"{W}p":
                    li, frag = para_html(child)
                    if li:
                        if not open_list:
                            out.append("<ul class=\"docx-list\">")
                            open_list = True
                        out.append("<li>%s</li>" % frag)
                    else:
                        if open_list:
                            out.append("</ul>")
                            open_list = False
                        out.append(frag)
                elif tag == f"{W}tbl":
                    if open_list:
                        out.append("</ul>")
                        open_list = False
                    out.append(table_html(child))
                if total[0] > max_chars:
                    break
            if open_list:
                out.append("</ul>")
            html = "".join(out)
            return html or None
    except Exception:  # noqa: BLE001 — any parse error: caller falls back
        return None


def _odt_walk(el) -> str:
    out = []
    if el.tag == f"{_ODT_T}tab":
        out.append("\t")
    elif el.tag == f"{_ODT_T}line-break":
        out.append("\n")
    elif el.tag == f"{_ODT_T}s":
        n = el.get(f"{_ODT_T}c")
        out.append(" " * (int(n) if n and n.isdigit() else 1))
    if el.text:
        out.append(el.text)
    for child in el:
        out.append(_odt_walk(child))
        if child.tail:
            out.append(child.tail)
    return "".join(out)


def _odt_blocks(path: Path, max_chars: int) -> list[dict]:
    import zipfile
    import xml.etree.ElementTree as ET
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("content.xml"))
    blocks, total = [], 0
    for el in root.iter():
        if el.tag == f"{_ODT_T}h":
            try:
                lvl = min(int(el.get(f"{_ODT_T}outline-level", "1") or "1"), 6)
            except ValueError:
                lvl = 1
            text = _odt_walk(el)
            blocks.append({"level": lvl, "text": text})
        elif el.tag == f"{_ODT_T}p":
            text = _odt_walk(el)
            if not text.strip():
                continue
            blocks.append({"level": 0, "text": text})
        else:
            continue
        total += len(blocks[-1]["text"])
        if total > max_chars:
            break
    return blocks


def _blocks_of(path: Path, max_chars: int) -> list[dict] | None:
    """Heading-aware blocks for docx/odt, else None (caller uses flat text)."""
    suffix = path.suffix.lower()
    try:
        if suffix == ".docx":
            return _docx_blocks(path, max_chars)
        if suffix == ".odt":
            return _odt_blocks(path, max_chars)
    except Exception:  # noqa: BLE001 — fall back to flat text on any parse error
        return None
    return None


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
            return "\n".join(b["text"] for b in _docx_blocks(path, max_chars))[:max_chars]
        except Exception as e:  # noqa: BLE001 — surface any parse error to the agent
            return f"(docx extraction failed: {e})"
    if suffix == ".odt":
        try:
            return "\n".join(b["text"] for b in _odt_blocks(path, max_chars))[:max_chars]
        except Exception as e:  # noqa: BLE001 — surface any parse error to the agent
            return f"(odt extraction failed: {e})"
    if suffix in TEXT_SUFFIXES or not suffix:
        try:
            return path.read_text(encoding="utf-8", errors="replace")[:max_chars]
        except OSError as e:
            return f"(read failed: {e})"
    return f"(no text extraction for {suffix} files)"


def cmd_blocks(args: argparse.Namespace) -> None:
    p = Path(args.path).expanduser()
    if not p.is_file():
        _fail(f"not a file: {p}")
    blocks = _blocks_of(p, args.max_chars)
    if blocks is None:
        # not a structured format — hand back flat text, no outline
        _emit({"path": str(p), "blocks": [], "text": _extract_text(p, args.max_chars)})
        return
    out = {"path": str(p), "blocks": blocks,
           "text": "\n".join(b["text"] for b in blocks)[:args.max_chars]}
    if p.suffix.lower() == ".docx":
        html = _docx_rich(p, args.max_chars)
        if html:
            out["html"] = html
    _emit(out)


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
    # distinct folded words from file names — the vocabulary for typo-tolerant
    # (edit-distance) query expansion in cmd_fts.
    db.execute("CREATE TABLE IF NOT EXISTS name_tokens(token TEXT PRIMARY KEY)")
    return db


def _name_words(name: str) -> list[str]:
    """Folded word tokens of a file name, extension dropped, len >= 3.

    Splits on any non-alphanumeric (underscore included) to mirror FTS5's
    unicode61 tokenizer, so 'passeport_x.jpg' yields 'passeport', not one blob.
    """
    stem = name.rsplit(".", 1)[0] if "." in name else name
    return [t for t in re.findall(r"[^\W_]+", _fold(stem), re.UNICODE) if len(t) >= 3]


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
    # rebuild the name vocabulary wholesale — cheap, and keeps it exact after
    # additions and deletions alike.
    vocab: set[str] = set()
    for f in files:
        vocab.update(_name_words(f["name"]))
    db.execute("DELETE FROM name_tokens")
    db.executemany("INSERT OR IGNORE INTO name_tokens(token) VALUES (?)",
                   [(t,) for t in vocab])
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
    db = _fts_connect(out_dir)

    # Typo tolerance: for any term that isn't itself a known file-name word,
    # add the closest name-vocabulary words (edit-distance) as OR alternatives.
    # Exact/correct queries stay precise (their term is in the vocab -> no
    # expansion). "raport" -> "rapport", "facure" -> "facture".
    vocab = [r[0] for r in db.execute("SELECT token FROM name_tokens")]
    vocab_set = set(vocab)
    variants: list[str] = []
    seen_v: set[str] = set()
    for t in terms:
        folded = _fold(t)
        for cand in [folded] + (
            difflib.get_close_matches(folded, vocab, n=3, cutoff=0.74)
            if len(folded) >= 4 and folded not in vocab_set else []
        ):
            if cand and cand not in seen_v:
                seen_v.add(cand)
                variants.append(cand)
    # each variant as a quoted prefix phrase — user text can't inject operators
    match = " OR ".join(f'"{v}"*' for v in variants)
    rows = db.execute(
        "SELECT docs.path, docs.name, bm25(docs, 0.0, 5.0, 1.0) AS rank, "
        "snippet(docs, 2, '[', ']', '…', 12), meta.size, meta.mtime "
        "FROM docs JOIN meta ON meta.path = docs.path "
        "WHERE docs MATCH ? ORDER BY rank LIMIT ?",
        (match, max(args.limit, 1))).fetchall()
    db.close()
    _emit({"query": args.query, "terms": variants, "hits": [
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
    ap = argparse.ArgumentParser(prog="docfindy-engine")
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

    p = sub.add_parser("blocks")
    p.add_argument("--path", required=True)
    p.add_argument("--max-chars", type=int, default=200_000)
    p.set_defaults(fn=cmd_blocks)

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
