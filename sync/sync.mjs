#!/usr/bin/env node
/* ============================================================================
   giftsie — Ricochet CSV → site catalog sync
   Each export is treated as the full authoritative snapshot, never a delta.

     1 receive    checksum; skip if identical to the last run
     2 validate   required columns present, types parse, row count sane
     3 guard      abort if rows dropped more than the configured share
     4 normalize  Ricochet columns → canonical product schema
     5 join       images by SKU, maker copy by name, from this repo
     6 diff       new / changed / missing vs the stored records
     7 upsert     missing SKUs are soft-deleted, not removed
     8 publish    rewrite data/products.json (+ optional deploy hook)
     9 record     counts, held-back SKUs and timings → state/last-run.json

   Usage:  node sync/sync.mjs --csv <export.csv> [--dry-run] [--force]
                              [--deploy] [--json] [--root <dir>]
   Exit:   0 applied or skipped · 1 aborted · 2 bad usage
============================================================================ */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCSV } from './lib/csv.mjs';
import { validateHeaders, normalize, isPublishable, isLowStock, compileCategoryRules } from './lib/normalize.mjs';
import { indexImages, imageFor, placeholderFor, loadMakers, makerInfo } from './lib/assets.mjs';
import { loadStore, saveJSON, diff, upsert } from './lib/store.mjs';

const SYNC_DIR = dirname(fileURLToPath(import.meta.url));

/* ---------- CLI ---------- */

function parseArgs(argv) {
  const opts = { csv: null, root: resolve(SYNC_DIR, '..'), dryRun: false, force: false, deploy: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--csv') opts.csv = argv[++i];
    else if (a === '--root') opts.root = resolve(argv[++i]);
    else if (a === '--state') opts.stateDir = resolve(argv[++i]);
    else if (a === '--config') opts.configPath = resolve(argv[++i]);
    else if (a === '--categories') opts.categoriesPath = resolve(argv[++i]);
    else if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--deploy') opts.deploy = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!opts.csv && !a.startsWith('-')) opts.csv = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const USAGE = `giftsie catalog sync

  node sync/sync.mjs --csv <export.csv> [options]

  --csv <path>   Ricochet inventory export (required)
  --dry-run, -n  report what would change; write nothing
  --force        run even if the file is unchanged or the drop guard trips
  --deploy       POST the configured deploy hook when the catalog changed
  --json         emit the run report as JSON on stdout
  --root <dir>   site root (default: the folder containing sync/)
  --config <p>   alternate config.json
  --state <dir>  alternate state directory
`;

/* ---------- reporting ---------- */

const money = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toFixed(2)}`);

class Abort extends Error {}

function printReport(rep) {
  const L = console.log;
  L('');
  L(`  giftsie catalog sync — ${rep.syncedAt}`);
  L(`  ${rep.csv}`);
  L('  ' + '─'.repeat(60));

  if (rep.status === 'skipped') {
    L(`  unchanged since ${rep.previousRunAt ?? 'the last run'} — nothing to do.`);
    L('  (re-run with --force to sync it anyway)\n');
    return;
  }

  L(`  rows in file        ${rep.counts.csvRows}`);
  if (rep.counts.rejected) L(`  rejected            ${rep.counts.rejected}`);
  L(`  publishable         ${rep.counts.publishable}`);
  L(`  live on the site    ${rep.counts.published}`);
  if (rep.counts.heldBack) L(`  held back (no photo) ${rep.counts.heldBack}`);
  L('');
  L(`  category from Ricochet   ${rep.counts.categorised}`);
  L(`  category derived by rule ${rep.counts.categoryDerived}`);
  L(`  uncategorised            ${rep.counts.uncategorised}`);
  L('');
  L(`  new                 ${rep.counts.added}`);
  L(`  changed             ${rep.counts.changed}`);
  L(`  gone from export    ${rep.counts.missing}`);
  L(`  unchanged           ${rep.counts.unchanged}`);

  if (rep.heldBack.length) {
    L('');
    L('  Held back — published in Ricochet, no photo on file:');
    for (const p of rep.heldBack.slice(0, 20)) L(`    ${p.sku.padEnd(16)} ${p.name}`);
    if (rep.heldBack.length > 20) L(`    … and ${rep.heldBack.length - 20} more`);
    L(`  Drop photos in ${rep.assetDir}/<SKU>.jpg to bring these online.`);
  }

  if (rep.rejected.length) {
    L('');
    L('  Rejected rows:');
    for (const r of rep.rejected.slice(0, 10)) L(`    row ${String(r.row).padEnd(5)} ${r.reason}`);
    if (rep.rejected.length > 10) L(`    … and ${rep.rejected.length - 10} more`);
  }

  if (rep.changed.length) {
    L('');
    L('  Changes:');
    for (const c of rep.changed.slice(0, 15)) {
      const d = c.deltas
        .map((x) => (x.field === 'price' ? `price ${money(x.from)} → ${money(x.to)}` : `${x.field} ${x.from} → ${x.to}`))
        .join(', ');
      L(`    ${c.sku.padEnd(16)} ${d}`);
    }
    if (rep.changed.length > 15) L(`    … and ${rep.changed.length - 15} more`);
  }

  if (rep.missing.length) {
    L('');
    L('  Gone from the export — unpublished, records kept:');
    for (const m of rep.missing.slice(0, 15)) L(`    ${m.sku.padEnd(16)} ${m.name}`);
    if (rep.missing.length > 15) L(`    … and ${rep.missing.length - 15} more`);
  }

  L('');
  L(rep.dryRun ? '  DRY RUN — no files written.' : `  wrote ${rep.wrote.join(', ')}`);
  if (rep.deploy) L(`  deploy hook: ${rep.deploy}`);
  L('');
}

/* ---------- the run ---------- */

export async function run(opts) {
  const syncedAt = new Date().toISOString();
  const config = JSON.parse(readFileSync(opts.configPath ?? join(SYNC_DIR, 'config.json'), 'utf8'));

  /* Category rules are a stopgap for Ricochet's near-empty Category field.
     Missing file simply means no derivation — never a failure. */
  const catPath = opts.categoriesPath ?? join(SYNC_DIR, 'categories.json');
  const categoryRules = config.catalog.deriveCategories && existsSync(catPath)
    ? compileCategoryRules(JSON.parse(readFileSync(catPath, 'utf8')))
    : [];

  const stateDir = opts.stateDir ?? join(SYNC_DIR, 'state');
  const storePath = join(stateDir, 'catalog.json');
  const runPath = join(stateDir, 'last-run.json');
  const feedPath = join(opts.root, 'data', 'products.json');

  /* 1 — receive */
  if (!opts.csv) throw new Abort('no CSV given. Pass --csv <path>.');
  const csvPath = resolve(opts.csv);
  if (!existsSync(csvPath)) throw new Abort(`no such file: ${csvPath}`);

  const raw = readFileSync(csvPath);
  const checksum = createHash('sha256').update(raw).digest('hex');
  const store = loadStore(storePath);

  const base = {
    syncedAt,
    csv: csvPath,
    checksum,
    dryRun: opts.dryRun,
    assetDir: config.assets.dir,
    previousRunAt: store.lastRun?.at ?? null,
  };

  if (store.lastRun?.checksum === checksum && !opts.force) {
    return { ...base, status: 'skipped', counts: {}, heldBack: [], rejected: [], changed: [], missing: [], wrote: [] };
  }

  /* 2 — validate */
  const { keys, records, headers } = parseCSV(raw.toString('utf8'));
  if (!records.length) throw new Abort('the file has no data rows.');

  const check = validateHeaders(keys, config);
  if (!check.ok) {
    throw new Abort(
      `missing required column(s): ${check.missing.join(', ')}\n` +
        `  columns found: ${headers.join(' | ')}\n` +
        `  Add the real header name to sync/config.json → columns.`
    );
  }

  /* 4 — normalize (row-level validation lives here too) */
  const { rows, rejected } = normalize(records, config, { categoryRules });
  if (!rows.length) throw new Abort(`all ${records.length} row(s) were rejected — the mapping in sync/config.json is probably wrong.`);

  /* 3 — guard: never let a truncated export empty the website */
  const previousRows = store.lastRun?.csvRows ?? null;
  if (previousRows !== null && rows.length < config.guards.minRows) {
    throw new Abort(`only ${rows.length} valid row(s); minimum is ${config.guards.minRows}.`);
  }
  if (previousRows) {
    const dropPct = ((previousRows - rows.length) / previousRows) * 100;
    if (dropPct > config.guards.maxRowDropPercent) {
      const msg =
        `row count fell ${dropPct.toFixed(1)}% (${previousRows} → ${rows.length}), ` +
        `past the ${config.guards.maxRowDropPercent}% guard. The export looks truncated.`;
      if (!opts.force) throw new Abort(`${msg}\n  If the drop is real, re-run with --force.`);
      console.warn(`  ! ${msg} — overridden by --force`);
    }
  }

  /* 5 — join images and maker copy */
  const images = indexImages(opts.root, config);
  const makers = loadMakers(SYNC_DIR);
  const featured = new Set(config.catalog.featuredSkus.map((s) => String(s).trim().toLowerCase()));

  const incoming = new Map();
  const heldBack = [];

  for (const row of rows) {
    const image = imageFor(row.sku, images);
    const publishable = isPublishable(row, config);
    const blocked = publishable && config.assets.requireImageToPublish && !image;
    if (blocked) heldBack.push({ sku: row.sku, name: row.name });

    const maker = makerInfo(row.maker, makers);

    incoming.set(row.sku, {
      sku: row.sku,
      name: row.name,
      category: row.category,
      maker: row.maker,
      makerLoc: maker?.loc || null,
      description: row.description,
      price: row.price,
      quantity: row.quantity,
      status: row.status,
      addedAt: row.addedAt,
      lowStock: isLowStock(row, config),
      categorySource: row.categorySource,
      image,
      url: config.catalog.productUrlTemplate
        ? config.catalog.productUrlTemplate.replace('{sku}', encodeURIComponent(row.sku))
        : null,
      featured: featured.has(row.sku.toLowerCase()),
      isPublished: publishable && !blocked,
    });
  }

  /* 6 — diff */
  const delta = diff(store, incoming);

  /* 7 — upsert */
  upsert(store, incoming, syncedAt);

  const live = [...incoming.values()].filter((p) => p.isPublished);

  /* 8 — publish: rewrite the feed the site reads */
  const feed = {
    note: 'Generated by sync/sync.mjs from a Ricochet CSV export. Do not edit by hand — the next sync overwrites it.',
    generated: syncedAt,
    source: 'ricochet-csv',
    facets: {
      priceBands: config.catalog.priceBands ?? [],
      newArrivalDays: config.catalog.newArrivalDays ?? 0,
    },
    counts: { published: live.length, heldBack: heldBack.length, inExport: rows.length },
    products: live.map((p, i) => ({
      sku: p.sku,
      name: p.name,
      description: p.description,
      category: p.category,
      price: p.price,
      quantity: p.quantity,
      status: p.status,
      addedAt: p.addedAt,
      lowStock: p.lowStock,
      image: p.image,
      imageFallback: placeholderFor(i, config),
      maker: p.maker,
      makerLoc: p.makerLoc,
      url: p.url,
      featured: p.featured,
    })),
  };

  const counts = {
    csvRows: rows.length,
    rejected: rejected.length,
    publishable: rows.filter((r) => isPublishable(r, config)).length,
    published: live.length,
    heldBack: heldBack.length,
    categorised: rows.filter((r) => r.categorySource === 'ricochet').length,
    categoryDerived: rows.filter((r) => r.categorySource === 'derived').length,
    uncategorised: rows.filter((r) => r.categorySource === 'default').length,
    added: delta.added.length,
    changed: delta.changed.length,
    missing: delta.missing.length,
    unchanged: delta.unchanged,
  };

  const catalogChanged = counts.added + counts.changed + counts.missing > 0;
  const wrote = [];
  let deploy = null;

  if (!opts.dryRun) {
    saveJSON(feedPath, feed);
    wrote.push('data/products.json');

    store.lastRun = { at: syncedAt, checksum, csvRows: rows.length, published: live.length };
    saveJSON(storePath, store);
    wrote.push('sync/state/catalog.json');

    saveJSON(runPath, {
      at: syncedAt,
      csv: csvPath,
      checksum,
      counts,
      heldBack,
      rejected,
      changed: delta.changed.map((c) => ({ sku: c.sku, deltas: c.deltas })),
      missing: delta.missing.map((m) => ({ sku: m.sku, name: m.name })),
    });
    wrote.push('sync/state/last-run.json');

    /* the static-site stand-in for ISR revalidation */
    if (opts.deploy && config.deploy.hookUrl && catalogChanged) {
      const res = await fetch(config.deploy.hookUrl, { method: 'POST' });
      deploy = res.ok ? `triggered (${res.status})` : `FAILED (${res.status})`;
    } else if (opts.deploy && !catalogChanged) {
      deploy = 'skipped — nothing changed';
    } else if (opts.deploy) {
      deploy = 'skipped — no deploy.hookUrl in sync/config.json';
    }
  }

  return {
    ...base,
    status: 'applied',
    counts,
    catalogChanged,
    heldBack,
    rejected,
    changed: delta.changed,
    missing: delta.missing,
    wrote,
    deploy,
  };
}

/* ---------- entry point ---------- */

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`\n  ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (opts.help || !opts.csv) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 2);
  }

  try {
    const report = await run(opts);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    process.exit(0);
  } catch (e) {
    if (e instanceof Abort) {
      console.error(`\n  SYNC ABORTED — the site was left untouched.\n  ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}
