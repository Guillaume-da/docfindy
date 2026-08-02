// Dev-only stand-in for the Tauri API so the UI can be previewed in a plain
// browser (`VITE_MOCK=1 npm run dev`). Never bundled in the real app: vite only
// aliases the Tauri modules to this file when VITE_MOCK is set.
//
// Everything below is invented sample data. Keep it that way — this file ships
// in a public repository, so no real paths, filenames or document contents.

interface MockFile {
  path: string;
  name: string;
  snippet: string;
  size: number;
  mtime: number;
  keywords: string;
  tldr: string;
  points: string[];
  text: string;
  html?: string;
}

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);
const HOME = "C:\\Users\\Sample\\Documents";

const FILES: MockFile[] = [
  {
    path: `${HOME}\\Sales\\Outreach Script.docx`,
    name: "Outreach Script.docx",
    snippet: "Good morning, I'm calling from Northwind Supplies about your…",
    size: 135_900,
    mtime: NOW - DAY,
    keywords: "outreach sales script calls suppliers",
    tldr: "A call script for the Northwind Supplies sales team, covering the opening, the service list and the closing question.",
    points: [
      "Opens by naming the company and the reason for the call",
      "Lists the three service lines to offer",
      "Ends on a request for a short follow-up call",
    ],
    text: "Good morning, I'm calling from Northwind Supplies.\nAm I speaking with the person who handles purchasing?\n\nWe work with mid-sized workshops and offer three things:\n\nBulk consumables on a monthly account, with next-day delivery.\n\nTool servicing and calibration, collected and returned on site.\n\nEquipment leasing with maintenance included.",
    html:
      '<h1>Outreach Script</h1>' +
      '<p style="text-align:center"><strong>Northwind Supplies</strong><br/><span class="docx-link">Sales team handbook</span></p>' +
      '<h2>Opening</h2>' +
      '<p>Good morning, I&#8217;m calling from <strong>Northwind Supplies</strong>. Am I speaking with the person who handles <em>purchasing</em>?</p>' +
      '<h2>Services offered</h2>' +
      '<ul class="docx-list">' +
      '<li><strong>Bulk consumables</strong> — monthly account, next-day delivery</li>' +
      '<li>Tool servicing &amp; calibration</li>' +
      '<li>Equipment leasing with maintenance included</li>' +
      '</ul>' +
      '<h2>Lead times</h2>' +
      '<table class="docx-table"><tbody>' +
      '<tr><td>Service</td><td>Lead time</td><td>From</td></tr>' +
      '<tr><td>Consumables</td><td>next day</td><td>£40/month</td></tr>' +
      '<tr><td>Calibration</td><td>3–5 days</td><td>£120/tool</td></tr>' +
      '</tbody></table>' +
      '<p class="docx-sp"></p>' +
      '<p>Would a ten-minute call later this week be useful?</p>',
  },
  {
    path: "C:\\Users\\Sample\\Downloads\\Outreach Script (1).docx",
    name: "Outreach Script (1).docx",
    snippet: "Good morning, I'm calling from Northwind Supplies…",
    size: 136_100,
    mtime: NOW - DAY,
    keywords: "outreach sales script calls suppliers",
    tldr: "A near-identical duplicate of the outreach script, saved separately in the Downloads folder.",
    points: ["Duplicate of the Documents copy", "Saved in Downloads"],
    text: "Good morning, I'm calling from Northwind Supplies…",
  },
  {
    path: `${HOME}\\Finance\\Q3 Financial Report.pdf`,
    name: "Q3 Financial Report.pdf",
    snippet: "[Revenue] grew 18% quarter over quarter, driven by EMEA…",
    size: 2_400_000,
    mtime: NOW - 4 * DAY,
    keywords: "financial report revenue finance q3",
    tldr: "Quarterly financial report showing 18% revenue growth and improved operating margin, led by the EMEA region.",
    points: [
      "Revenue up 18% quarter over quarter",
      "EMEA was the strongest performing region",
      "Operating margin improved to 24%",
      "Enterprise accounts continued to expand",
    ],
    text: "Q3 2026 Financial Report\n\nRevenue grew 18% quarter over quarter, driven by strong performance in the EMEA region and expanding enterprise accounts.\n\nOperating margin improved to 24%, up from 21% in Q2. Cash reserves remain healthy at €12.4M.",
  },
  {
    path: `${HOME}\\Legal\\Contract — Acme Corp.docx`,
    name: "Contract — Acme Corp.docx",
    snippet: "This agreement governs the licensing of the DocFindy platform…",
    size: 320_000,
    mtime: NOW - 16 * DAY,
    keywords: "contract legal acme licensing agreement",
    tldr: "A 24-month renewable licensing agreement between DocFindy and Acme Corporation, covering data residency terms.",
    points: [
      "24-month term, renewable",
      "Covers licensing of the DocFindy platform",
      "Section 4 addresses data residency",
    ],
    text: "Licensing Agreement\n\nThis agreement governs the licensing of the DocFindy platform to Acme Corporation for a term of 24 months, renewable.\n\nSection 4 covers data residency and requires all indexed content to remain within the EU.",
  },
  {
    path: `${HOME}\\Design\\Design Mockups.fig`,
    name: "Design Mockups.fig",
    snippet: "Full redesign of the search results screen in the light theme…",
    size: 14_300_000,
    mtime: NOW - 2 * DAY,
    keywords: "design mockups figma ui search screen",
    tldr: "Figma file with the redesigned search and preview screens in the Apple-inspired theme.",
    points: ["Spotlight-style search field", "Results list with rich previews", "AI summary preview pane"],
    text: "Design Mockups\n\nFull redesign of the search results screen in the Apple-inspired theme.",
  },
  {
    path: "C:\\Users\\Sample\\Projects\\docfindy\\README.md",
    name: "README.md",
    snippet: "DocFindy indexes your files locally and finds them [instantly]…",
    size: 4_200,
    mtime: NOW - DAY,
    keywords: "readme markdown docfindy docs",
    tldr: "Project README describing DocFindy's local-first architecture.",
    points: ["Local SQLite FTS5 index", "Tauri + React front end"],
    text: "# DocFindy\n\nAI file-finding agent for the desktop.\n\n## Features\n\n- **Instant search** by name or content\n- *AI summaries* of any document\n- Light and dark themes\n\n> Local-first: your files never leave your machine.\n\n`npm run tauri dev` to start.",
  },
  {
    path: `${HOME}\\Finance\\clients.csv`,
    name: "clients.csv",
    snippet: "name;country;revenue — 42 rows of [client] accounts…",
    size: 8_100,
    mtime: NOW - 3 * DAY,
    keywords: "csv clients finance accounts",
    tldr: "Client accounts export with country and revenue columns.",
    points: ["42 client rows", "Semicolon-delimited"],
    text: 'name;country;revenue\n"Acme Corp";France;120000\n"Globex ""EU""";Spain;98000\nInitech;Germany;87500',
  },
  {
    path: "C:\\Users\\Sample\\Projects\\docfindy\\src\\theme.ts",
    name: "theme.ts",
    snippet: "export function toggleTheme() { setTheme(getTheme() === …",
    size: 1_400,
    mtime: NOW - DAY,
    keywords: "typescript code theme toggle",
    tldr: "Theme store: persists light/dark in localStorage.",
    points: ["Dark by default", "DOM event on change"],
    text: '// Light/dark theme, persisted in localStorage.\nexport type Theme = "light" | "dark";\n\nconst KEY = "docfindy.theme"; /* storage key */\n\nexport function getTheme(): Theme {\n  return localStorage.getItem(KEY) === "light" ? "light" : "dark";\n}\n\nexport function setTheme(theme: Theme) {\n  localStorage.setItem(KEY, theme);\n  // 0x1F318 = 🌘\n  window.dispatchEvent(new CustomEvent("docfindy-theme-change"));\n}',
  },
];

function match(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return FILES.filter(
    (f) =>
      f.name.toLowerCase().includes(q) ||
      f.path.toLowerCase().includes(q) ||
      f.snippet.toLowerCase().includes(q) ||
      f.keywords.toLowerCase().includes(q),
  );
}

const settings = {
  lang: "en",
  roots: [HOME],
  provider: "anthropic",
  models: { anthropic: "claude-sonnet-5" },
};

const delay = <T,>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  switch (cmd) {
    case "get_settings":
      return delay(settings as T);
    case "has_api_key":
      return delay(true as T);
    case "provider_keys":
      return delay({ anthropic: true, openai: false, kimi: false } as T);
    case "list_models":
      return delay(
        (args?.provider === "openai"
          ? ["gpt-4.1", "gpt-4.1-mini", "gpt-4o"]
          : args?.provider === "kimi"
            ? ["kimi-latest", "moonshot-v1-128k"]
            : ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"]) as T,
      );
    case "open_provider_keys_page":
      return delay(undefined as T);
    case "index_status":
      return delay({ exists: true, files: 2174, roots: settings.roots } as T);
    case "quick_search":
    case "smart_search": {
      const q = String((args?.query as string) ?? "");
      const hits = match(q).map((f) => ({
        path: f.path,
        name: f.name,
        score: 1,
        snippet: f.snippet,
        size: f.size,
        mtime: f.mtime,
      }));
      const extra = cmd === "smart_search" ? { expanded: [q, "sales", "supplies"] } : {};
      return delay({ hits, ...extra } as T, 250);
    }
    case "read_preview": {
      const f = FILES.find((x) => x.path === args?.path) ?? FILES[0];
      const ext = f.path.toLowerCase().split(".").pop() ?? "";
      const kind =
        ext === "pdf" ? "pdf"
        : ["png", "jpg", "jpeg", "gif", "webp"].includes(ext) ? "image"
        : ext === "fig" ? "other"
        : "text";
      return delay({ kind, path: f.path, name: f.name, size: f.size, mtime: f.mtime, text: f.text, html: f.html } as T);
    }
    case "copy_file_to_clipboard":
      return delay(undefined as T);
    case "summarize_file": {
      const f = FILES.find((x) => x.path === args?.path) ?? FILES[0];
      return delay({ tldr: f.tldr, points: f.points } as T, 600);
    }
    case "ask_document":
      return delay({ answer: "Based on the document, the key point is the licensing term and data-residency clause." } as T, 500);
    default:
      return delay(undefined as T);
  }
}

export function convertFileSrc(path: string): string {
  return path;
}

export async function listen<T>(_event: string, _cb: (e: { payload: T }) => void): Promise<() => void> {
  return () => {};
}

export async function open(_opts?: unknown): Promise<string | null> {
  return HOME;
}

export async function openUrl(url: string): Promise<void> {
  window.open(url, "_blank");
}
