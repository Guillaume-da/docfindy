# DocFindy

Desktop file finder that searches **inside** your documents, not just their names. Type a word and it finds the PDF, Word file or note that contains it — instantly, locally, with no cloud upload. An optional Claude API key adds AI summaries, document Q&A and synonym-aware search.

![DocFindy main window](docs/screenshots/search.png)

## What it does

- **Search by content, not just filename.** SQLite FTS5 index, accent-insensitive (`resume` matches `résumé`), BM25-ranked. Text is extracted from **pdf, docx, odt** and plain-text formats (txt, md, csv, json, yaml, and common code extensions). Other indexed types — doc, rtf, epub, xlsx, pptx, images, audio, video — are searchable **by filename only**.
- **Instant, as you type.** The plain search path never calls a network service, so results appear while typing.
- **Local by default.** The index lives on your machine. Files are never uploaded anywhere unless you explicitly use an AI feature, which sends only the relevant document text.
- **Skips your secrets.** `.env*`, `id_rsa`, `id_ed25519`, `.pem`, `.key`, `.kdbx`, `.pfx`, `.p12`, `.ppk` are never indexed. System directories (`Windows`, `Program Files`, `AppData`, `$Recycle.Bin`, …) and dev noise (`node_modules`, `__pycache__`, `site-packages`, dot-directories) are skipped too.
- **Rich previews.** Documents render in place — docx keeps its formatting, tables and images — with quick actions to open the file or reveal it in your file manager.
- **Favourites.** Pin the files you keep coming back to.
- **Keyboard-driven.** `↑`/`↓` to move through results, `Enter` to open the selected one.
- **Light and dark themes**, plus a **bilingual UI** (English and Spanish), both switchable at runtime.

With a Claude API key you also get: AI summary of the previewed document, ask-a-question about the open document, and smart search that expands your query with synonyms and FR/EN translations before hitting the index.

**The API key is optional.** Without it, indexing, search, preview and open all work; only the AI panels are hidden.

## Screenshots

### First run

Pick the folders to index. The API key field can be left empty.

![Onboarding screen](docs/screenshots/onboarding.png)

### Light theme

Dark by default, light on demand — the toggle sits next to the language switch.

![Light theme](docs/screenshots/light-theme.png)

## Install

### Windows

No release has been published yet. In the meantime, build the installer yourself by pushing a `v*` tag or running the [build-windows workflow](../../actions/workflows/build-windows.yml) manually, then grab the `docfindy-windows-installer` artifact. Everything is bundled — no Python or Rust needed on the target machine.

Once a release exists, it will be on the [releases page](https://github.com/Guillaume-da/docfindy/releases).

### Build from source

Prerequisites: Rust, Node 18+, Python 3.10+, and the [Tauri system dependencies](https://tauri.app/start/prerequisites/) for your platform.

```bash
git clone https://github.com/Guillaume-da/docfindy.git
cd docfindy

python3 -m venv engine/.venv
engine/.venv/bin/pip install pypdf

npm install
npm run tauri dev      # development
npm run tauri build    # production bundle
```

## How it works

| Layer | Role |
|-------|------|
| **Tauri 2** (Rust) | App shell, Claude API client with a tool-use loop, OS keychain access, sidecar orchestration |
| **docfindy-engine** (Python sidecar) | Walks the chosen roots, extracts text from pdf/docx/odt/plain files, maintains the SQLite FTS5 index. Only dependency: `pypdf` |
| **rtk** (Rust sidecar) | [Rust Token Killer](https://github.com/rtk-ai/rtk) — compresses filesystem probe output before it enters the Claude context (60-90% fewer tokens) |
| **caveman** | [Terse-output prompt rules](https://github.com/JuliusBrussee/caveman) baked into the agent system prompt (~65% fewer output tokens) |
| **React 19 + Tailwind 4** | Search UI, rich preview pane, theme and EN/ES toggles |

The frontend can also run standalone in a browser: `src/dev/tauri-mock.ts` stubs the Tauri commands with sample data, which is handy for UI work without a Rust rebuild.

```bash
VITE_MOCK=1 npm run dev
```

### Agent tools

When the AI agent runs, it has these tools available:

| Tool | Purpose |
|------|---------|
| `doc_search` | FTS5 full-text search over names + content — the primary search tool |
| `fs_probe` | rtk-compressed filename scan, used as a fallback |
| `content_search` | Literal term lookup with exact line/page locations |
| `read_file` | Text extraction (txt/code/pdf/docx/odt) for syntheses |
| `show_file` | Display a file in the preview pane |

### Engine CLI

The sidecar is a plain JSON-over-stdout CLI and can be driven directly, which is handy for debugging:

```bash
engine/.venv/bin/python engine/main.py build  --out <index-dir> --path ~/Documents
engine/.venv/bin/python engine/main.py fts    --out <index-dir> --query "budget"
engine/.venv/bin/python engine/main.py detect --path ~/Documents
```

Subcommands: `detect`, `build`, `update`, `text`, `blocks`, `search`, `fts`.

In development, the shims in `src-tauri/binaries/` forward to `engine/.venv`. Override the resolved engine with:

```bash
DOCFINDY_ENGINE="/path/to/python /path/to/main.py" npm run tauri dev
```

## Configuration & data

| What | Where |
|------|-------|
| API key | OS keychain (Windows Credential Manager, macOS Keychain, Secret Service), with a `0600` file fallback in the config dir for headless/WSL setups |
| Settings | `<config>/com.guillaume.docfindy/settings.json` |
| Index | `<data>/com.guillaume.docfindy/graphify-out/content.db` + `files.json` |

On Linux that resolves to `~/.config/…` and `~/.local/share/…`; on Windows to `%APPDATA%`.

> `graphify-out` is a historical directory name from an earlier iteration of the project. It is only a path, and renaming it would move every existing user's index, so it has been left alone for now.

### Migration from Findy

The app was renamed from Findy to DocFindy. That changed the bundle identifier, which in turn changed both paths above **and** the keychain service name — so without help, an upgrade would silently lose settings, the whole index and the stored API key.

`src-tauri/src/migrate.rs` runs at startup and moves all three from the old `com.guillaume.findy` names. It merges entry by entry rather than moving whole directories, because the webview creates its own caches under the new identifier before the migration runs. It is a no-op on fresh installs and after the first successful run, and if a move fails the old data is left in place rather than half-copied.

## Windows installer build

`.github/workflows/build-windows.yml` builds, on a `v*` tag or manual dispatch:

1. `docfindy-engine.exe` — PyInstaller onefile
2. `rtk.exe` — `cargo install`
3. The NSIS installer — `tauri build`

Artifact: `docfindy-windows-installer`.

## Troubleshooting

**Nothing is found even though the file exists.** Check that its folder is in your indexed roots (⚙ → folders), and that the file type is supported. Rebuild with ⚙ → rebuild index after adding folders.

**AI panels are missing.** No API key is set. Add one in ⚙; instant search works without it.

**Blank window or GPU warnings on WSL.** WSLg has no working DRI3 device. Run with software rendering:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 npm run tauri dev
```

**Engine not found.** In development the shims expect `engine/.venv`. Create it as shown above, or point `DOCFINDY_ENGINE` at your interpreter.

## Project layout

```
engine/          Python indexing sidecar (main.py, engine.spec)
src/             React frontend (components/, i18n/)
src-tauri/src/   Rust core
  claude.rs        Claude API client + tool-use loop
  commands.rs      Tauri commands exposed to the frontend
  engine.rs        Sidecar resolution and execution
  migrate.rs       Pre-rename data migration
  secrets.rs       Keychain + file fallback
  rtk.rs           rtk-compressed filesystem probe
```

---

Made by G. Dall'Olmo.
