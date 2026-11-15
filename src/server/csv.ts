/** Minimal CSV reading and writing (RFC 4180: quoted fields, doubled quotes, CRLF or LF). */
import { Invalid } from "./errors";

export const MAX_CSV_BYTES = 2_000_000;

/** Parse CSV text into rows of cells. Blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (quoted) throw new Invalid("The file has a quote that is never closed.");
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/**
 * Parse a CSV file whose first row is a header. Header names are matched
 * ignoring case, spaces and underscores, so "Unit Price" matches "unit_price".
 * Returns one object per row with the requested columns ("" when absent).
 */
export function readCsvRecords<K extends string>(
  text: string,
  columns: readonly K[],
  required: readonly K[],
): Record<K, string>[] {
  if (text.length > MAX_CSV_BYTES) throw new Invalid("The file is too large (2 MB at most).");
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Invalid("The file is empty.");
  const norm = (s: string) => s.toLowerCase().replace(/[\s_]/g, "");
  const index = new Map(header.map((name, i) => [norm(name), i]));
  for (const column of required) {
    if (!index.has(norm(column))) throw new Invalid(`The file needs a "${column}" column in its first row.`);
  }
  return rows.map((cells) => {
    const record = {} as Record<K, string>;
    for (const column of columns) {
      const i = index.get(norm(column));
      record[column] = i === undefined ? "" : (cells[i] ?? "").trim();
    }
    return record;
  });
}

function cell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // A cell starting with = + - @ is run as a formula by spreadsheet apps.
  // Plain numbers are left alone so negative amounts stay numbers.
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Serialize rows to CSV text with a header row. */
export function toCsv<T extends object>(columns: readonly (keyof T & string)[], rows: readonly T[]): string {
  const lines = [columns.join(","), ...rows.map((row) => columns.map((c) => cell(row[c])).join(","))];
  return `${lines.join("\r\n")}\r\n`;
}
