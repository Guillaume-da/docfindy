import { useMemo } from "react";

// Dependency-free syntax highlighting for the preview pane. A per-line regex
// tokenizer with a small keyword set per language family — good enough for a
// read-only preview, no npm dependency needed. Token colors live in
// index.css (.tok-*) so they follow the light/dark theme.

type TokType = "k" | "s" | "n" | "c" | "t";
interface Token {
  type: TokType;
  text: string;
}

interface Lang {
  keywords: Set<string>;
  lineComments: string[];
  blockComment?: [string, string];
  caseInsensitive?: boolean;
  hasBacktick?: boolean;
  htmlTags?: boolean;
}

const CLIKE_KW = new Set(
  (
    "abstract as async await break case catch class const continue debugger default delete do else enum export extends " +
    "false finally fn for from function get if impl implements import in instanceof interface let loop match mod mut new " +
    "null of private protected public pub readonly return self set static struct super switch this throw true try type " +
    "typeof undefined unsafe use var void while yield string number boolean any unknown never namespace declare package " +
    "int long float double char short byte boolean final synchronized volatile transient native goto func go chan defer " +
    "map range select fallthrough"
  ).split(" "),
);

const PY_KW = new Set(
  (
    "and as assert async await break class continue def del elif else except finally for from global if import in is " +
    "lambda None nonlocal not or pass raise return True False try while with yield self match case"
  ).split(" "),
);

const SQL_KW = new Set(
  (
    "select from where insert into values update set delete create table view index drop alter add join inner left right " +
    "outer full on as and or not null primary key foreign references group by order having limit offset distinct union all " +
    "case when then else end exists between like in is asc desc count sum avg min max"
  ).split(" "),
);

const SH_KW = new Set(
  (
    "if then else elif fi for while until do done case esac function in echo exit return local export readonly shift " +
    "break continue true false set unset source"
  ).split(" "),
);

const DATA_KW = new Set("true false null yes no on off".split(" "));

const LANGS: Record<string, Lang> = {
  clike: {
    keywords: CLIKE_KW,
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    hasBacktick: true,
  },
  python: { keywords: PY_KW, lineComments: ["#"] },
  shell: { keywords: SH_KW, lineComments: ["#"] },
  sql: {
    keywords: SQL_KW,
    lineComments: ["--"],
    blockComment: ["/*", "*/"],
    caseInsensitive: true,
  },
  css: { keywords: new Set(), lineComments: [], blockComment: ["/*", "*/"] },
  html: {
    keywords: new Set(),
    lineComments: [],
    blockComment: ["<!--", "-->"],
    htmlTags: true,
  },
  data: { keywords: DATA_KW, lineComments: ["#"] },
  ruby: { keywords: PY_KW, lineComments: ["#"] },
};

const LANG_BY_EXT: Record<string, string> = {
  js: "clike", jsx: "clike", ts: "clike", tsx: "clike", java: "clike",
  c: "clike", cpp: "clike", h: "clike", go: "clike", rs: "clike", php: "clike",
  py: "python",
  sh: "shell",
  sql: "sql",
  css: "css",
  html: "html", htm: "html", xml: "html",
  json: "data", yaml: "data", yml: "data", toml: "data", ini: "data",
  rb: "ruby",
};

export function langForExt(ext: string): string | null {
  return LANG_BY_EXT[ext] ?? null;
}

function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegex(lang: Lang): RegExp {
  const parts: string[] = [];
  if (lang.blockComment) {
    const [o, c] = lang.blockComment.map(esc);
    parts.push(`${o}[\\s\\S]*?${c}`, `${o}.*$`); // closed on the line, or opens
  }
  for (const lc of lang.lineComments) parts.push(`${esc(lc)}.*$`);
  parts.push(`"(?:[^"\\\\]|\\\\.)*"?`, `'(?:[^'\\\\]|\\\\.)*'?`);
  if (lang.hasBacktick) parts.push("`(?:[^`\\\\]|\\\\.)*`?");
  if (lang.htmlTags) parts.push("</?[A-Za-z][\\w.-]*|/?>");
  parts.push("0[xX][0-9a-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?");
  parts.push("[A-Za-z_$][\\w$]*");
  return new RegExp(parts.join("|"), "g");
}

function classify(match: string, lang: Lang): TokType {
  const c0 = match[0];
  if (lang.blockComment && match.startsWith(lang.blockComment[0])) return "c";
  if (lang.lineComments.some((lc) => match.startsWith(lc))) return "c";
  if (c0 === '"' || c0 === "'" || c0 === "`") return "s";
  if (lang.htmlTags && (c0 === "<" || c0 === "/" || c0 === ">")) return "k";
  if (c0 >= "0" && c0 <= "9") return "n";
  const word = lang.caseInsensitive ? match.toLowerCase() : match;
  return lang.keywords.has(word) ? "k" : "t";
}

interface LineState {
  inBlock: boolean;
}

function tokenizeLine(line: string, lang: Lang, state: LineState): Token[] {
  const out: Token[] = [];
  let rest = line;

  // finish an open block comment from a previous line
  if (state.inBlock && lang.blockComment) {
    const end = rest.indexOf(lang.blockComment[1]);
    if (end === -1) {
      return [{ type: "c", text: rest }];
    }
    const upto = end + lang.blockComment[1].length;
    out.push({ type: "c", text: rest.slice(0, upto) });
    rest = rest.slice(upto);
    state.inBlock = false;
  }

  const re = buildRegex(lang);
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) {
    if (m.index > last) out.push({ type: "t", text: rest.slice(last, m.index) });
    const type = classify(m[0], lang);
    out.push({ type, text: m[0] });
    // a block comment that opened but did not close spills to the next lines
    if (
      type === "c" &&
      lang.blockComment &&
      m[0].startsWith(lang.blockComment[0]) &&
      !m[0].endsWith(lang.blockComment[1])
    ) {
      state.inBlock = true;
    }
    last = m.index + m[0].length;
  }
  if (last < rest.length) out.push({ type: "t", text: rest.slice(last) });
  return out;
}

const MAX_LINES = 1500;

export default function CodeView({ text, ext }: { text: string; ext: string }) {
  const lines = useMemo(() => {
    const lang = LANGS[LANG_BY_EXT[ext] ?? "data"];
    const state: LineState = { inBlock: false };
    return text
      .split(/\r?\n/)
      .slice(0, MAX_LINES)
      .map((l) => tokenizeLine(l, lang, state));
  }, [text, ext]);

  return (
    <div className="overflow-x-auto rounded-[13px] border border-edge-soft bg-panel font-mono text-[12.5px] leading-[1.7]">
      <div className="min-w-max px-0 py-3">
        {lines.map((toks, i) => (
          <div key={i} className="flex">
            <span className="w-12 shrink-0 select-none pr-4 text-right text-muted-2/70">
              {i + 1}
            </span>
            <span className="whitespace-pre pr-5">
              {toks.map((tk, j) =>
                tk.type === "t" ? (
                  tk.text
                ) : (
                  <span key={j} className={`tok-${tk.type}`}>
                    {tk.text}
                  </span>
                ),
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
