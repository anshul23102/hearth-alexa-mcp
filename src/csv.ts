/** Small RFC-4180 reader: quoted fields, escaped quotes, CRLF, stray BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const MAX_FIELD = 64 * 1024;

/**
 * Incremental CSV reader for large uploads: feed it chunks, get complete rows back, never hold
 * the whole file. A single field is capped so one hostile cell cannot exhaust memory.
 */
export class CsvStream {
  private row: string[] = [];
  private field = "";
  private quoted = false;
  private pendingQuote = false;
  private pendingCr = false;
  private first = true;
  truncatedFields = 0;

  push(chunk: string): string[][] {
    const out: string[][] = [];
    let src = chunk;
    if (this.first && src.length) { src = src.replace(/^\uFEFF/, ""); this.first = false; }
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (this.pendingCr) { this.pendingCr = false; if (c === "\n") continue; }
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (c === '"') { this.add('"'); continue; }
        this.quoted = false;
      }
      if (this.quoted) {
        if (c === '"') this.pendingQuote = true; else this.add(c);
      } else if (c === '"') this.quoted = true;
      else if (c === ",") { this.row.push(this.field); this.field = ""; this.overflowed = false; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r") this.pendingCr = true;
        this.row.push(this.field); this.field = ""; this.overflowed = false;
        if (this.row.some((f) => f.trim() !== "")) out.push(this.row);
        this.row = [];
      } else this.add(c);
    }
    return out;
  }

  end(): string[][] {
    const out: string[][] = [];
    if (this.pendingQuote) this.quoted = false;
    this.row.push(this.field);
    if (this.row.some((f) => f.trim() !== "")) out.push(this.row);
    this.row = []; this.field = "";
    return out;
  }

  private overflowed = false;
  private add(c: string) {
    if (this.field.length < MAX_FIELD) this.field += c;
    else if (!this.overflowed) { this.overflowed = true; this.truncatedFields++; }
  }
}
