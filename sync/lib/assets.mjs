/* Step 5: join CSV rows to things a CSV can never carry — photos and maker
   copy. Both live in this repo, keyed by SKU and by maker name, and are
   written once per product rather than re-exported nightly. */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const normKey = (s) => String(s).trim().toLowerCase();

/**
 * Index the product image directory once: normalised SKU → site-relative path.
 * Filenames are `<SKU>.<ext>`; a `<SKU>-2.jpg` style suffix is ignored so
 * alternate shots can sit alongside the primary without confusing the join.
 */
export function indexImages(root, config) {
  const dir = join(root, config.assets.dir);
  const index = new Map();
  if (!existsSync(dir)) return index;

  const allowed = new Set(config.assets.extensions.map((e) => '.' + e.toLowerCase()));

  for (const file of readdirSync(dir)) {
    const ext = extname(file).toLowerCase();
    if (!allowed.has(ext)) continue;
    const key = normKey(basename(file, extname(file)));
    if (!key || index.has(key)) continue; // first match wins, extensions in config order
    index.set(key, `${config.assets.dir}/${file}`);
  }
  return index;
}

/** Site-relative image path for a SKU, or null when nothing is on file. */
export function imageFor(sku, index) {
  return index.get(normKey(sku)) ?? null;
}

/** Deterministic placeholder, so a card never renders as a blank box in a preview. */
export function placeholderFor(i, config) {
  const n = (i % config.assets.placeholderCount) + 1;
  return `images/placeholders/product-${n}.svg`;
}

/**
 * Maker directory: name → { loc, bio, ... }. Ricochet carries a brand/consignor
 * string and nothing else, so location comes from here.
 */
export function loadMakers(syncDir) {
  const path = join(syncDir, 'makers.json');
  if (!existsSync(path)) return new Map();
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : (parsed.makers ?? []);
  return new Map(list.filter((m) => m?.name).map((m) => [normKey(m.name), m]));
}

export function makerInfo(name, makers) {
  if (!name) return null;
  return makers.get(normKey(name)) ?? null;
}
