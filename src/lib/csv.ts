export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  // Every key of every row — a key that only appears on a later row would
  // otherwise be dropped from the export.
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    // Numbers stay numeric so Excel can total them; only text is quoted.
    if (typeof v === "number") return String(v);
    const s = String(v);
    // Neutralise spreadsheet formula injection (=, +, -, @, tab, CR).
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [
    headers.map(esc).join(","),
    ...rows.map((r) => headers.map((h) => esc(r[h])).join(",")),
  ].join("\r\n");
}

export function downloadCsv(rows: Record<string, unknown>[], filename: string) {
  // BOM so Excel opens Bangla/UTF-8 correctly
  const blob = new Blob(["\uFEFF" + toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
