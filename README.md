# Findy

AI file-finding agent for the desktop. Chat with it in English or Spanish, it finds any document on your machine by name or content (SQLite FTS5 index), shows the path, previews the document, and opens it in your browser.

## Architecture

- **Tauri 2** (Rust) — shell, Claude API client with tool-use loop, OS keychain storage
- **findy-engine** (Python sidecar) — document indexer: walks the chosen roots (system dirs and dev noise excluded), extracts text from pdf/docx/odt/plain files, and maintains a SQLite FTS5 index (accent-insensitive, BM25-ranked). Only dependency: pypdf.
- **rtk** (Rust sidecar) — [Rust Token Killer](https://github.com/rtk-ai/rtk): compresses filesystem probe output before it enters the Claude context (60-90% token savings)
- **caveman** — [terse-output prompt rules](https://github.com/JuliusBrussee/caveman) baked into the agent system prompt (~65% output-token savings)
- **React + Tailwind 4** — chat UI, EN/ES toggle, integrated preview pane

## Agent tools

| Tool | Purpose |
|------|---------|
| `doc_search` | SQLite FTS5 full-text search over file names + content (pdf/docx/odt/text), accent-insensitive, BM25-ranked — primary search tool |
| `fs_probe` | rtk-compressed filename scan fallback |
| `content_search` | literal term lookup with exact line/page locations |
| `read_file` | text extraction (txt/code/pdf/docx/odt) for syntheses |
| `show_file` | display file in the preview pane |

## Dev (Linux/WSL)

```bash
# prerequisites: rust, node 18+, python 3.10+, Tauri Linux deps
python3 -m venv engine/.venv && engine/.venv/bin/pip install pypdf
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
- Index: `<data>/com.guillaume.findy/graphify-out/content.db` + `files.json`
