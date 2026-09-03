/* RFC 4180 CSV parsing. No dependencies — a Ricochet export is small enough
   that streaming buys nothing, and a vendored parser can't break on an update. */

/** Split raw CSV text into rows of string cells. Handles quoted fields,
 *  escaped quotes, embedded newlines, CRLF/CR/LF terminators, and a BOM. */
export function parseRows(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let dirty = false; // this row has content (guards against a trailing newline)

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c !== '"') { field += c; continue; }
      if (text[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }

    if (c === '"') { quoted = true; dirty = true; continue; }
    if (c === ',') { row.push(field); field = ''; dirty = true; continue; }

    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (dirty || row.length > 1) rows.push(row);
      row = []; field = ''; dirty = false;
      continue;
    }

    field += c;
    dirty = true;
  }

  if (dirty || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Column headers vary between Ricochet report screens ("SKU", "Sku #",
 *  "Item SKU"). Compare on a squashed key so aliases don't need every variant. */
export const columnKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Parse CSV text into records.
 * @returns {{headers: string[], keys: string[], records: object[]}}
 *   `records` are keyed by squashed column key; `headers` keeps the originals
 *   so error messages can quote what was actually in the file.
 */
export function parseCSV(text) {
  const rows = parseRows(text);
  if (!rows.length) return { headers: [], keys: [], records: [] };

  const headers = rows[0].map((h) => h.trim());
  const keys = headers.map(columnKey);
  const records = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // A row of nothing but empty cells is padding, not data.
    if (cells.every((c) => c.trim() === '')) continue;

    const rec = { __row: r + 1 }; // 1-indexed, counting the header — matches a spreadsheet
    for (let c = 0; c < keys.length; c++) {
      if (!keys[c]) continue;
      // Squashing collides on real Ricochet headers: "Consignor" and
      // "Consignor %" both key to `consignor`. Leftmost column wins, so the
      // named field beats the trailing percentage rather than being
      // overwritten by it.
      if (Object.hasOwn(rec, keys[c])) continue;
      rec[keys[c]] = (cells[c] ?? '').trim();
    }
    records.push(rec);
  }

  return { headers, keys, records };
}

/** First alias present in the record, or undefined. */
export function pick(rec, aliases) {
  for (const a of aliases) {
    const k = columnKey(a);
    if (rec[k] !== undefined && rec[k] !== '') return rec[k];
  }
  return undefined;
}

/** Whether any of `aliases` exists as a column at all (even if every cell is blank). */
export function hasColumn(keys, aliases) {
  return aliases.some((a) => keys.includes(columnKey(a)));
}
