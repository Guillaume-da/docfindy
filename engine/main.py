#!/usr/bin/env python3
"""Findy engine — graphify wrapper sidecar.

JSON-over-stdout CLI consumed by the Tauri (Rust) core. Every subcommand
prints exactly one JSON document on stdout; errors go to stderr with a
non-zero exit code.

Subcommands:
  detect  --path P [--path P2 ...]                 corpus summary per root
  build   --out DIR --path P [--path P2 ...]       full index build
  update  --out DIR                                incremental rebuild (cached AST)
  vocab   --out DIR                                token vocabulary of node labels
  query   --out DIR --tokens "a b c" [--dfs] [--limit N]
"""

from __future__ import annotations

import argparse
import json
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


def _norm_id(path_like: str) -> str:
    return re.sub(r"[^a-z0-9_]", "_", path_like.lower())


CATEGORIES = ("code", "document", "paper", "image", "video")


def _detect_root(root: Path) -> dict:
    from graphify.detect import detect
    return detect(root)


# ---------------------------------------------------------------------------
# detect
# ---------------------------------------------------------------------------

def cmd_detect(args: argparse.Namespace) -> None:
    out = []
    for p in args.path:
        root = Path(p).expanduser().resolve()
        if not root.exists():
            _fail(f"path not found: {root}")
        d = _detect_root(root)
        counts = {c: len(d.get("files", {}).get(c, [])) for c in CATEGORIES}
        out.append({
            "root": str(root),
            "total_files": d.get("total_files", 0),
            "total_words": d.get("total_words", 0),
            "counts": {k: v for k, v in counts.items() if v},
            "skipped_sensitive": len(d.get("skipped_sensitive", [])),
        })
    _emit({"roots": out})


# ---------------------------------------------------------------------------
# build / update
# ---------------------------------------------------------------------------

def _file_nodes_for_root(root: Path, detect_json: dict) -> tuple[list, list, list]:
    """Synthesize one node per file + directory `contains` edges.

    graphify's AST pass only creates nodes for code entities; a file finder
    needs every file (PDF, image, doc, ...) to be a first-class node so the
    query matcher can hit on filenames.
    """
    type_map = {"code": "code", "document": "document", "paper": "paper",
                "image": "image", "video": "document"}
    nodes, edges, index = [], [], []
    seen_dirs: set[str] = set()

    for cat in CATEGORIES:
        for f in detect_json.get("files", {}).get(cat, []):
            fp = Path(f)
            try:
                rel = fp.relative_to(root)
            except ValueError:
                rel = Path(fp.name)
            fid = "file_" + _norm_id(str(rel))
            nodes.append({
                "id": fid,
                "label": fp.name,
                "file_type": type_map[cat],
                "source_file": str(fp),
                "source_location": str(fp),
                "source_url": None, "captured_at": None,
                "author": None, "contributor": None,
            })
            try:
                st = fp.stat()
                size, mtime = st.st_size, int(st.st_mtime)
            except OSError:
                size, mtime = 0, 0
            index.append({"path": str(fp), "name": fp.name,
                          "category": cat, "size": size, "mtime": mtime})

            # chain of directory nodes root -> ... -> file
            parent_id = None
            acc = Path()
            for part in rel.parts[:-1]:
                acc = acc / part
                did = "dir_" + _norm_id(str(acc))
                if did not in seen_dirs:
                    seen_dirs.add(did)
                    nodes.append({
                        "id": did, "label": part, "file_type": "concept",
                        "source_file": str(root / acc),
                        "source_location": str(root / acc),
                        "source_url": None, "captured_at": None,
                        "author": None, "contributor": None,
                    })
                    if parent_id:
                        edges.append(_edge(parent_id, did, str(root / acc)))
                parent_id = did
            if parent_id:
                edges.append(_edge(parent_id, fid, str(fp)))
    return nodes, edges, index


def _edge(src: str, dst: str, source_file: str) -> dict:
    return {"source": src, "target": dst, "relation": "references",
            "confidence": "EXTRACTED", "confidence_score": 1.0,
            "source_file": source_file, "source_location": None, "weight": 1.0}


def _ast_extract(root: Path, detect_json: dict) -> dict:
    from graphify.extract import collect_files, extract
    code_files: list[Path] = []
    for f in detect_json.get("files", {}).get("code", []):
        p = Path(f)
        code_files.extend(collect_files(p) if p.is_dir() else [p])
    if not code_files:
        return {"nodes": [], "edges": [], "input_tokens": 0, "output_tokens": 0}
    return extract(code_files, cache_root=root)


def _link_entities_to_files(ast_nodes: list, file_nodes_by_src: dict) -> list:
    """`references` edge file-node -> AST entity node, keyed on source_file."""
    edges = []
    for n in ast_nodes:
        src = n.get("source_file")
        if not src:
            continue
        fid = file_nodes_by_src.get(str(Path(src)))
        if fid:
            edges.append(_edge(fid, n["id"], str(src)))
    return edges


def _build(out_dir: Path, roots: list[Path]) -> None:
    from graphify.build import build_from_json
    from graphify.cluster import cluster
    from graphify.export import to_json

    out_dir.mkdir(parents=True, exist_ok=True)
    all_nodes, all_edges, files_index = [], [], []
    t0 = time.time()

    for root in roots:
        _progress("detect", root=str(root))
        d = _detect_root(root)
        _progress("detected", root=str(root),
                  files=d.get("total_files", 0), words=d.get("total_words", 0))

        fnodes, fedges, index = _file_nodes_for_root(root, d)
        _progress("ast", root=str(root))
        ast = _ast_extract(root, d)

        by_src = {n["source_file"]: n["id"] for n in fnodes}
        link_edges = _link_entities_to_files(ast.get("nodes", []), by_src)

        all_nodes += fnodes + ast.get("nodes", [])
        all_edges += fedges + ast.get("edges", []) + link_edges
        files_index += index
        _progress("root_done", root=str(root),
                  nodes=len(fnodes) + len(ast.get("nodes", [])))

    # dedupe nodes by id (same file reachable from two roots)
    seen: set[str] = set()
    nodes = [n for n in all_nodes if not (n["id"] in seen or seen.add(n["id"]))]

    extraction = {"nodes": nodes, "edges": all_edges, "hyperedges": [],
                  "input_tokens": 0, "output_tokens": 0}
    (out_dir / ".findy_extract.json").write_text(
        json.dumps(extraction, ensure_ascii=False), encoding="utf-8")

    _progress("graph")
    # root=None: file nodes carry absolute paths on purpose — the app opens
    # them directly. Multi-root corpora have no single relativization base.
    G = build_from_json(extraction, directed=False)
    if G.number_of_nodes() == 0:
        _fail("graph is empty: no supported files found")
    communities = cluster(G)

    graph_path = out_dir / "graph.json"
    graph_path.unlink(missing_ok=True)  # bypass #479 shrink guard: full rebuild is authoritative
    to_json(G, communities, str(graph_path))

    (out_dir / "files.json").write_text(json.dumps({
        "roots": [str(r) for r in roots],
        "built_at": int(time.time()),
        "files": files_index,
    }, ensure_ascii=False), encoding="utf-8")

    _emit({"ok": True, "nodes": G.number_of_nodes(),
           "edges": G.number_of_edges(),
           "communities": len(communities),
           "files": len(files_index), "seconds": round(time.time() - t0, 1)})


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
    # AST extraction is cached per file by graphify (cache_root), so a
    # rebuild only re-parses changed code files; file nodes are cheap.
    _build(out_dir, roots)


# ---------------------------------------------------------------------------
# vocab
# ---------------------------------------------------------------------------

def _load_graph(out_dir: Path) -> dict:
    gp = out_dir / "graph.json"
    if not gp.exists():
        _fail("no graph found: run build first")
    return json.loads(gp.read_text(encoding="utf-8"))


def _tokens_of(label: str) -> list[str]:
    toks = []
    for c in re.findall(r"[^\W_]+", label or "", re.UNICODE):
        parts = re.findall(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+", c) or [c]
        toks += [p.lower() for p in parts if 2 <= len(p) <= 30]
    return toks


def cmd_vocab(args: argparse.Namespace) -> None:
    data = _load_graph(Path(args.out))
    vocab: set[str] = set()
    for n in data["nodes"]:
        vocab.update(_tokens_of(n.get("label", "")))
    _emit({"vocab": sorted(vocab)})


# ---------------------------------------------------------------------------
# query
# ---------------------------------------------------------------------------

def _resolve_path(node: dict, roots: list[Path]) -> tuple[str | None, int | None]:
    """Absolute path + optional line for a graph node.

    File/dir nodes carry absolute paths in source_location; AST entity nodes
    carry a root-relative source_file and 'L<num>' in source_location.
    """
    loc = node.get("source_location") or ""
    src = node.get("source_file") or ""
    line = None
    m = re.fullmatch(r"L(\d+)", loc)
    if m:
        line = int(m.group(1))
    elif loc and Path(loc).is_absolute():
        return loc, None
    if src:
        p = Path(src)
        if p.is_absolute():
            return str(p), line
        for r in roots:
            cand = r / p
            if cand.exists():
                return str(cand), line
        if roots:
            return str(roots[0] / p), line
    return (loc or None), line


def cmd_query(args: argparse.Namespace) -> None:
    out_dir = Path(args.out)
    data = _load_graph(out_dir)
    files_meta, roots = {}, []
    fj = out_dir / "files.json"
    if fj.exists():
        meta = json.loads(fj.read_text(encoding="utf-8"))
        files_meta = {f["path"]: f for f in meta["files"]}
        roots = [Path(r) for r in meta.get("roots", [])]

    tokens = [t.lower() for t in args.tokens.split() if t.strip()]
    if not tokens:
        _fail("empty token list")

    nodes = data["nodes"]
    edges = data.get("edges", data.get("links", []))

    # substring + IDF scoring (mirrors graphify's matcher)
    n_total = max(len(nodes), 1)
    df = {t: sum(1 for n in nodes if t in (n.get("label", "").lower())) for t in tokens}
    import math
    idf = {t: math.log(n_total / (1 + df[t])) + 1.0 for t in tokens}

    scored = []
    for n in nodes:
        lab = (n.get("label", "") or "").lower()
        s = sum(idf[t] for t in tokens if t in lab)
        if s > 0:
            scored.append((s, n))
    scored.sort(key=lambda x: -x[0])
    top = scored[: max(args.limit, 1)]

    # adjacency for 1-hop context
    adj: dict[str, list[tuple[str, str]]] = {}
    for e in edges:
        s, t = e.get("source"), e.get("target")
        rel = e.get("relation", "related")
        adj.setdefault(s, []).append((t, rel))
        adj.setdefault(t, []).append((s, rel))
    by_id = {n["id"]: n for n in nodes}

    results = []
    for score, n in top:
        neighbors = []
        stack = [(n["id"], 0)]
        seen = {n["id"]}
        max_depth = 3 if args.dfs else 1
        while stack and len(neighbors) < 12:
            nid, depth = stack.pop() if args.dfs else stack.pop(0)
            if depth >= max_depth:
                continue
            for other, rel in adj.get(nid, []):
                if other in seen:
                    continue
                seen.add(other)
                on = by_id.get(other)
                if on:
                    neighbors.append({"label": on.get("label"), "relation": rel})
                    stack.append((other, depth + 1))
        src, line = _resolve_path(n, roots)
        meta = files_meta.get(src or "", {})
        results.append({
            "id": n["id"], "label": n.get("label"), "score": round(score, 3),
            "file_type": n.get("file_type") or n.get("type"),
            "path": src, "line": line,
            "size": meta.get("size"), "mtime": meta.get("mtime"),
            "neighbors": neighbors,
        })
    _emit({"tokens": tokens, "results": results})


# ---------------------------------------------------------------------------
# text extraction (for agent summaries / content search on PDFs)
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

    p = sub.add_parser("vocab")
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_vocab)

    p = sub.add_parser("query")
    p.add_argument("--out", required=True)
    p.add_argument("--tokens", required=True)
    p.add_argument("--dfs", action="store_true")
    p.add_argument("--limit", type=int, default=8)
    p.set_defaults(fn=cmd_query)

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

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
