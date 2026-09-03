/* Step 2 (validate) + step 4 (normalize): Ricochet's columns → the canonical
   product schema, with every rejection recorded rather than silently dropped.

   Written against the real export, whose shape differs from the guess this
   pipeline was first built on in three ways that matter:
     · SKUs arrive as '004001 — a leading apostrophe is Excel's text guard.
     · There is no online/publish flag at all; availability lives in a text
       `Inventory` status column ("In Stock", "Paid", "Picked Up", …).
     · `Category` is populated on 19 of 1606 rows, so categories are derived
       from the product name until Ricochet's own field is filled in. */

import { pick, hasColumn } from './csv.mjs';

const TRUTHY = new Set(['yes', 'y', 'true', 't', '1', 'on', 'shopify', 'online', 'published', 'active']);
const FALSY = new Set(['no', 'n', 'false', 'f', '0', 'off', '', 'none', 'inactive']);

/** "'004001" → "004001". Ricochet writes SKUs apostrophe-prefixed so a
 *  spreadsheet keeps the leading zeros; the apostrophe is not part of the SKU
 *  and must not reach a URL, a filename or the image join. */
export function cleanSku(raw, config) {
  let s = String(raw ?? '').trim();
  if (config?.skuCleanup?.stripLeadingApostrophe !== false) s = s.replace(/^['`‘’]+/, '');
  return s.trim();
}

/** "$1,240.00" → 1240. Returns null when the cell is blank, NaN-safe. */
export function parsePrice(raw) {
  if (raw === undefined || raw === null) return null;
  const cleaned = String(raw).replace(/[$\s,]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/** Quantity may arrive as "3", "3.0", or "" (which reads as unknown, not zero). */
export function parseQuantity(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).replace(/[\s,]/g, ''));
  if (!Number.isFinite(n)) return NaN;
  return Math.trunc(n);
}

/** Tri-state on purpose: null means "the column said nothing", which is not "no". */
export function parseBool(raw) {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return null;
}

/* ------------------------------------------------------- categories ---- */

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compile sync/categories.json into ordered { category, re } matchers.
 * Boundaries are lookaround-based so "card" does not match "cardigan" while
 * keywords containing punctuation ("t-shirt", "d.c.") still work.
 */
export function compileCategoryRules(json) {
  const rules = (json?.rules ?? []).map((r) => ({
    category: r.category,
    re: new RegExp(`(?<![a-z0-9])(?:${r.match.map(esc).join('|')})(?![a-z0-9])`, 'i'),
  }));
  const makerDefaults = new Map(
    Object.entries(json?.makerDefaults ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v])
  );
  return { rules, makerDefaults };
}

/** First matching rule wins — form factor is ordered ahead of theme. Falls
 *  back to the maker's default category only when no keyword matched. */
export function deriveCategory(text, compiled, maker) {
  const rules = Array.isArray(compiled) ? compiled : (compiled?.rules ?? []);
  if (text) for (const r of rules) if (r.re.test(text)) return r.category;
  const defaults = Array.isArray(compiled) ? null : compiled?.makerDefaults;
  if (maker && defaults) return defaults.get(String(maker).trim().toLowerCase()) ?? null;
  return null;
}

/* --------------------------------------------------------- validate ---- */

/**
 * Validate the header row against config.required.
 * @returns {{ok: boolean, missing: string[]}}
 */
export function validateHeaders(keys, config) {
  const missing = config.required.filter(
    (field) => !hasColumn(keys, config.columns[field] ?? [field])
  );
  return { ok: missing.length === 0, missing };
}

/* -------------------------------------------------------- normalize ---- */

/**
 * Map raw CSV records to canonical rows.
 * @param {object[]} records
 * @param {object} config
 * @param {{categoryRules?: {category: string, re: RegExp}[]}} [ctx]
 * @returns {{rows: object[], rejected: {row: number, sku: string|null, reason: string}[]}}
 */
export function normalize(records, config, ctx = {}) {
  const cols = config.columns;
  const rules = config.catalog.deriveCategories ? (ctx.categoryRules ?? null) : null;
  const rows = [];
  const rejected = [];
  const seen = new Map(); // sku → first row number, to catch duplicate SKUs

  for (const rec of records) {
    const row = rec.__row;
    const sku = cleanSku(pick(rec, cols.sku), config);

    if (!sku) {
      rejected.push({ row, sku: null, reason: 'no SKU' });
      continue;
    }
    if (seen.has(sku)) {
      rejected.push({ row, sku, reason: `duplicate SKU (first seen on row ${seen.get(sku)})` });
      continue;
    }

    const name = (pick(rec, cols.name) ?? '').trim();
    if (!name) {
      rejected.push({ row, sku, reason: 'no product name' });
      continue;
    }

    const price = parsePrice(pick(rec, cols.price));
    if (Number.isNaN(price)) {
      rejected.push({ row, sku, reason: `price is not a number: "${pick(rec, cols.price)}"` });
      continue;
    }

    const quantity = parseQuantity(pick(rec, cols.quantity));
    if (Number.isNaN(quantity)) {
      rejected.push({ row, sku, reason: `quantity is not a number: "${pick(rec, cols.quantity)}"` });
      continue;
    }

    seen.set(sku, row);

    const maker = (pick(rec, cols.maker) ?? '').trim();
    const description = (pick(rec, cols.description ?? []) ?? '').trim();
    const status = (pick(rec, cols.status ?? []) ?? '').trim() || null;
    /* Ricochet's "In stock" column is the intake DATE, not a flag — it is the
       only signal in the export for what is new on the shelves. */
    const addedAt = (pick(rec, cols.addedAt ?? []) ?? '').trim() || null;

    const rawCategory = (pick(rec, cols.category) ?? '').trim();
    const derivedMaker = maker && maker.toLowerCase() !== 'giftsie' ? maker : null;
    const derived = rawCategory ? null : deriveCategory(`${name} ${description}`, rules, derivedMaker);

    rows.push({
      sku,
      name,
      category: rawCategory || derived || config.catalog.defaultCategory,
      categorySource: rawCategory ? 'ricochet' : derived ? 'derived' : 'default',
      maker: maker && maker.toLowerCase() !== 'giftsie' ? maker : null,
      description: description || null,
      price,
      quantity,
      status,
      addedAt,
      published: parseBool(pick(rec, cols.published)),
      row,
    });
  }

  return { rows, rejected };
}

/** Availability, decided by the Inventory status column when the export has
 *  one. Status is the truthful signal: every non-sellable Ricochet state
 *  ("Paid", "Sold", "Picked Up", "Out of Stock") also carries quantity 0,
 *  but the status says *why*, and quantity alone cannot. */
export function isInStock(row, config) {
  const ok = config.catalog.inStockStatuses;
  if (row.status && Array.isArray(ok) && ok.length) {
    return ok.some((s) => s.toLowerCase() === row.status.toLowerCase());
  }
  return row.quantity === null || row.quantity > 0;
}

export function isLowStock(row, config) {
  const low = config.catalog.lowStockStatuses ?? [];
  return !!row.status && low.some((s) => s.toLowerCase() === row.status.toLowerCase());
}

/**
 * Does this row belong on the website? Image availability is decided later
 * (step 5) — this is the Ricochet-side half of the decision only.
 */
export function isPublishable(row, config) {
  const { requirePublishedColumn, requireInStock } = config.catalog;
  if (requirePublishedColumn && row.published !== true) return false;
  if (requireInStock && !isInStock(row, config)) return false;
  return true;
}
