# Findy

AI file-finding agent for the desktop. Chat with it in English or Spanish, it finds any file on your machine via a local [graphify](https://graphify.net) knowledge graph, shows the path, previews the document, and opens it in your browser.

## Architecture

- **Tauri 2** (Rust) — shell, Claude API client with tool-use loop, OS keychain storage
- **findy-engine** (Python sidecar) — graphify wrapper: builds and queries the knowledge graph (`graphifyy` on PyPI). AST extraction is deterministic, no LLM key needed for indexing.
- **rtk** (Rust sidecar) — [Rust Token Killer](https://github.com/rtk-ai/rtk): compresses filesystem probe output before it enters the Claude context (60-90% token savings)
- **caveman** — [terse-output prompt rules](https://github.com/JuliusBrussee/caveman) baked into the agent system prompt (~65% output-token savings)
- **React + Tailwind 4** — chat UI, EN/ES toggle, integrated preview pane

## Agent tools

| Tool | Purpose |
|------|---------|
| `graph_vocab` | vocabulary of graph node labels (query expansion, cross-language) |
| `graph_query` | ranked BFS/DFS traversal over the knowledge graph |
| `fs_probe` | rtk-compressed filename scan fallback |
| `show_file` | display file in the preview pane |

## Dev (Linux/WSL)

```bash
# prerequisites: rust, node 18+, python 3.10+, Tauri Linux deps
python3 -m venv engine/.venv && engine/.venv/bin/pip install graphifyy
npm install
npm run tauri dev
```

The dev sidecar shims in `src-tauri/binaries/` forward to `engine/.venv`. Override with `FINDY_ENGINE="/path/python /path/main.py"`.

## Windows installer

GitHub Actions (`.github/workflows/build-windows.yml`) builds:
1. `findy-engine.exe` (PyInstaller onefile)
2. `rtk.exe` (cargo install)
3. NSIS installer via `tauri build`

Trigger on tag `v*` or manually. Artifact: `findy-windows-installer`.

## Settings & data

- API key: OS keychain (Windows Credential Manager), file fallback
- Settings: `<config>/com.guillaume.findy/settings.json`
- Index: `<data>/com.guillaume.findy/graphify-out/graph.json` + `files.json`
