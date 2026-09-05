/**
 * Quote a value for a CSV cell. Cells that start with a formula trigger
 * (= + - @, or a tab/CR that spreadsheets strip before checking) are
 * prefixed with a single quote so Excel, Numbers and Sheets show them as
 * text instead of evaluating them. Page paths and referrers are attacker
 * controlled via /track, so the export must not become a formula vector.
 */
export function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function tableToCsv(rows: Iterable<Iterable<unknown>>): string {
  const lines: string[] = [];
  for (const row of rows) lines.push(Array.from(row, csvCell).join(','));
  return lines.join('\n');
}
