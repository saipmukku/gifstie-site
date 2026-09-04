/* Steps 6 & 7: diff against the durable record store, then upsert.
   A SKU that falls out of the export is soft-deleted (isPublished = false),
   never dropped — consignment stock turns over fast enough that hard deletes
   would strand links and lose the record of what was ever carried. */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = { version: 1, lastRun: null, records: {} };

/** Fields whose change is worth reporting (and worth a redeploy). */
const TRACKED = ['name', 'category', 'maker', 'price', 'quantity', 'status', 'isPublished', 'image'];

export function loadStore(path) {
  if (!existsSync(path)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { ...structuredClone(EMPTY), ...parsed, records: parsed.records ?? {} };
  } catch (e) {
    throw new Error(`catalog store at ${path} is unreadable (${e.message}). Fix or delete it before syncing.`);
  }
}

export function saveJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Compare incoming rows against the stored records.
 * @param {Map<string,object>} incoming  sku → enriched row
 * @returns {{added: object[], changed: object[], missing: object[], unchanged: number}}
 */
export function diff(store, incoming) {
  const added = [];
  const changed = [];
  const missing = [];
  let unchanged = 0;

  for (const [sku, row] of incoming) {
    const prev = store.records[sku];
    if (!prev) { added.push(row); continue; }

    const deltas = TRACKED
      .filter((f) => (prev[f] ?? null) !== (row[f] ?? null))
      .map((f) => ({ field: f, from: prev[f] ?? null, to: row[f] ?? null }));

    if (deltas.length) changed.push({ ...row, deltas });
    else unchanged++;
  }

  for (const [sku, prev] of Object.entries(store.records)) {
    // Already soft-deleted on an earlier run — not news.
    if (!incoming.has(sku) && prev.isPublished) missing.push(prev);
  }

  return { added, changed, missing, unchanged };
}

/** Apply the diff to the store in place, stamping first/last seen and soft-deletes. */
export function upsert(store, incoming, syncedAt) {
  for (const [sku, row] of incoming) {
    const prev = store.records[sku];
    store.records[sku] = {
      ...row,
      firstSeen: prev?.firstSeen ?? syncedAt,
      lastSeen: syncedAt,
      missingSince: null,
    };
  }

  for (const [sku, prev] of Object.entries(store.records)) {
    if (incoming.has(sku)) continue;
    store.records[sku] = {
      ...prev,
      isPublished: false,                          // soft delete — the record survives
      missingSince: prev.missingSince ?? syncedAt,
    };
  }

  return store;
}
