import { useMemo } from "react";
import { useTranslation } from "react-i18next";

// Renders CSV/TSV previews as a table. Small hand-rolled parser (quoted
// fields, "" escapes); delimiter is \t for .tsv, otherwise whichever of
// ; or , is most frequent on the first line (French CSVs use ;).

const MAX_ROWS = 200;
const MAX_COLS = 40;

function parseDsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) return rows;
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export default function CsvTable({ text, ext }: { text: string; ext: string }) {
  const { t } = useTranslation();

  const { header, body, truncated } = useMemo(() => {
    let delim = ",";
    if (ext === "tsv") {
      delim = "\t";
    } else {
      const first = text.slice(0, text.indexOf("\n") + 1 || text.length);
      if ((first.match(/;/g) ?? []).length > (first.match(/,/g) ?? []).length) {
        delim = ";";
      }
    }
    const rows = parseDsv(text, delim).filter((r) =>
      r.some((c) => c.trim() !== ""),
    );
    const truncated = rows.length > MAX_ROWS;
    const limited = rows.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS));
    return {
      header: limited[0] ?? [],
      body: limited.slice(1),
      truncated,
    };
  }, [text, ext]);

  if (header.length === 0) return null;

  const cellCls =
    "border-b border-edge-soft px-3 py-1.5 text-left align-top max-w-[320px] truncate";

  return (
    <div className="overflow-auto rounded-[13px] border border-edge-soft bg-panel">
      <table className="w-full border-collapse text-[12.5px] leading-relaxed">
        <thead>
          <tr className="bg-fill">
            {header.map((h, i) => (
              <th
                key={i}
                className={`${cellCls} font-semibold text-txt-strong`}
                title={h}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i} className="odd:bg-transparent even:bg-fill/40">
              {header.map((_, j) => (
                <td key={j} className={`${cellCls} text-txt-mid`} title={r[j]}>
                  {r[j] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <div className="border-t border-edge-soft px-3 py-2 text-[11px] text-muted-2">
          {t("preview.rowsShown", { count: MAX_ROWS })}
        </div>
      )}
    </div>
  );
}
