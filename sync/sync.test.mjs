import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRows, parseCSV } from './lib/csv.mjs';
import {
  parsePrice, parseQuantity, parseBool, cleanSku, normalize, validateHeaders,
  compileCategoryRules, deriveCategory, isInStock, isPublishable,
} from './lib/normalize.mjs';
import { makerInfo } from './lib/assets.mjs';
import { run } from './sync.mjs';

const SYNC_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(SYNC_DIR, 'fixtures', 'sample-export.csv');
const CONFIG = JSON.parse(readFileSync(join(SYNC_DIR, 'config.json'), 'utf8'));
const CATS = JSON.parse(readFileSync(join(SYNC_DIR, 'categories.json'), 'utf8'));

/* The fixture mirrors a real Ricochet export: apostrophe-guarded SKUs, an
   almost-empty Category column, dead Brand/Supplier/Department columns, price
   under "Agreed Price", availability as a text Inventory status, and the
   "Consignor" / "Consignor %" header pair that squash to the same key. */
const HEADER = readFileSync(FIXTURE, 'utf8').split('\n')[0];
const row = (sku, name, price, qty, status, consignor = 'Example Maker Co.', category = '') =>
  `1,'${sku},,${name},${category},,,,,70%,${price},${price},6.000%,,,${consignor},,2026-03-04,${qty},"${status}",70`;

/* ---------------------------------------------------------------- csv ---- */

test('parses quoted commas, escaped quotes and CRLF', () => {
  const rows = parseRows('a,b\r\n"x,y","he said ""hi"""\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x,y', 'he said "hi"']]);
});

test('parses a newline inside a quoted field', () => {
  assert.deepEqual(parseRows('a,b\n"line1\nline2",z'), [['a', 'b'], ['line1\nline2', 'z']]);
});

test('strips a BOM and ignores trailing blank lines', () => {
  const { headers, records } = parseCSV('﻿SKU,Price\nA-1,5\n\n');
  assert.deepEqual(headers, ['SKU', 'Price']);
  assert.equal(records.length, 1);
});

test('column keys ignore case, spaces and punctuation', () => {
  const { records } = parseCSV('Qty On Hand,Sku #\n4,A-1');
  assert.equal(records[0].qtyonhand, '4');
  assert.equal(records[0].sku, 'A-1');
});

test('colliding headers resolve leftmost-wins, so Consignor beats Consignor %', () => {
  // Both squash to `consignor`. Ricochet ships them in this order in every export.
  const { records } = parseCSV('Consignor,"Consignor %"\nBridget Coral,70');
  assert.equal(records[0].consignor, 'Bridget Coral');
});

/* ---------------------------------------------------------- normalize ---- */

test('parses currency formatting', () => {
  assert.equal(parsePrice('$1,240.00'), 1240);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(undefined), null);
  assert.ok(Number.isNaN(parsePrice('call for price')));
});

test('blank quantity is unknown, not zero', () => {
  assert.equal(parseQuantity(''), null);
  assert.equal(parseQuantity('3.0'), 3);
  assert.ok(Number.isNaN(parseQuantity('many')));
});

test('unrecognised publish values stay null rather than defaulting to true', () => {
  assert.equal(parseBool('yes'), true);
  assert.equal(parseBool('no'), false);
  assert.equal(parseBool('maybe'), null);
});

test("strips Ricochet's apostrophe SKU guard without touching the digits", () => {
  assert.equal(cleanSku("'004001", CONFIG), '004001');
  assert.equal(cleanSku('  01W003 ', CONFIG), '01W003');
  assert.equal(cleanSku("'004001", { skuCleanup: { stripLeadingApostrophe: false } }), "'004001");
});

test('missing required columns are named', () => {
  const { keys } = parseCSV('Name,Quantity\nMug,5');
  const check = validateHeaders(keys, CONFIG);
  assert.deepEqual(check.missing, ['sku', 'price']);
});

test('"Agreed Price" satisfies the price requirement', () => {
  const { keys } = parseCSV('SKU,Name,"Agreed Price"\nA-1,Mug,5');
  assert.equal(validateHeaders(keys, CONFIG).ok, true);
});

test('rejects rows without a SKU, and duplicate SKUs, keeping the rest', () => {
  const { records } = parseCSV('SKU,Name,"Agreed Price"\nA-1,Mug,5\n,Orphan,5\nA-1,Dupe,5\nA-2,Bowl,7');
  const { rows, rejected } = normalize(records, CONFIG);
  assert.deepEqual(rows.map((r) => r.sku), ['A-1', 'A-2']);
  assert.equal(rejected.length, 2);
  assert.match(rejected[1].reason, /duplicate SKU/);
});

test('duplicate detection runs on the cleaned SKU, not the raw cell', () => {
  const { records } = parseCSV("SKU,Name,\"Agreed Price\"\n'A-1,Mug,5\nA-1,Dupe,5");
  const { rows, rejected } = normalize(records, CONFIG);
  assert.deepEqual(rows.map((r) => r.sku), ['A-1']);
  assert.match(rejected[0].reason, /duplicate SKU/);
});

/* --------------------------------------------------------- categories ---- */

test('derives a category from the product name, form factor before theme', () => {
  const rules = compileCategoryRules(CATS);
  assert.equal(deriveCategory('Photo Magnet - Washington Monument', rules), 'Magnets');
  assert.equal(deriveCategory('Sun Twirls Earrings', rules), 'Jewelry');
  assert.equal(deriveCategory('Greeting Card - Cherry Blossom', rules), 'Cards & Stationery');
});

test('word boundaries keep "card" out of "cardigan" and "ring" out of "Key rings"', () => {
  const rules = compileCategoryRules(CATS);
  assert.equal(deriveCategory('Chunky Cardigan', rules), 'Apparel');
  assert.equal(deriveCategory('Key rings', rules), 'Accessories');
});

test("falls back to the maker's default only when no keyword matched", () => {
  const rules = compileCategoryRules(CATS);
  assert.equal(deriveCategory('AP OCTAGONAL BLUE/BLUE', rules, 'Hector Zarate'), 'Jewelry');
  assert.equal(deriveCategory('Talavera Cup', rules, 'Hector Zarate'), 'Home & Kitchen');
  assert.equal(deriveCategory('AP OCTAGONAL BLUE/BLUE', rules, 'Nobody In Particular'), null);
});

test("a real Category in the export always beats the derived one", () => {
  const { records } = parseCSV('SKU,Name,"Agreed Price",Category\nA-1,Sun Twirls Earrings,10,Wood Stud');
  const { rows } = normalize(records, CONFIG, { categoryRules: compileCategoryRules(CATS) });
  assert.equal(rows[0].category, 'Wood Stud');
  assert.equal(rows[0].categorySource, 'ricochet');
});

/* ------------------------------------------------------- availability ---- */

test('the Inventory status decides availability, not the quantity alone', () => {
  const mk = (status, quantity) => ({ status, quantity, published: null });
  assert.equal(isInStock(mk('In Stock', 6), CONFIG), true);
  assert.equal(isInStock(mk('Low Stock', 1), CONFIG), true);
  assert.equal(isInStock(mk('Paid', 0), CONFIG), false);
  assert.equal(isInStock(mk('Picked Up', 0), CONFIG), false);
  assert.equal(isInStock(mk('Sold', 0), CONFIG), false);
  assert.equal(isPublishable(mk('Out of Stock', 0), CONFIG), false);
});

test('with no status column at all it falls back to quantity', () => {
  assert.equal(isInStock({ status: null, quantity: 0 }, CONFIG), false);
  assert.equal(isInStock({ status: null, quantity: 3 }, CONFIG), true);
});

test('the "In stock" column is read as the intake date, not a stock flag', () => {
  const { records } = parseCSV('SKU,Name,"Agreed Price","In stock",Inventory\nA-1,Mug,10,2026-08-21,"In Stock"');
  const { rows } = normalize(records, CONFIG);
  assert.equal(rows[0].addedAt, '2026-08-21');
  assert.equal(rows[0].status, 'In Stock');
});

test('price bands in config cover the range without gaps or overlap', () => {
  const bands = CONFIG.catalog.priceBands;
  assert.ok(bands.length);
  assert.equal(bands[0].min, undefined);              // open at the bottom
  assert.equal(bands[bands.length - 1].max, undefined); // open at the top
  bands.slice(0, -1).forEach((b, i) => assert.equal(b.max, bands[i + 1].min));
});

/* -------------------------------------------------------------- maker ---- */

test('maker lookup is case-insensitive and misses cleanly', () => {
  const makers = new Map([['bridget coral', { name: 'Bridget Coral', loc: 'Washington, DC' }]]);
  assert.equal(makerInfo('BRIDGET CORAL', makers).loc, 'Washington, DC');
  assert.equal(makerInfo('Someone Else', makers), null);
  assert.equal(makerInfo(null, makers), null);
});

/* ------------------------------------------------------------ the run ---- */

/** A throwaway site root + state dir, so tests never touch data/products.json.
 *  Photos are required here even though launch config allows placeholders —
 *  the hold-back path is the one worth testing. */
function sandbox({ images = [], config = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'giftsie-sync-'));
  const root = join(dir, 'site');
  const state = join(dir, 'state');
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'images', 'products'), { recursive: true });
  for (const sku of images) writeFileSync(join(root, 'images', 'products', `${sku}.jpg`), 'not-really-a-jpeg');

  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    ...CONFIG,
    assets: { ...CONFIG.assets, requireImageToPublish: true },
    ...config,
  }));

  const csvPath = join(dir, 'export.csv');
  cpSync(FIXTURE, csvPath);

  return {
    dir, root, csvPath,
    opts: { root, stateDir: state, configPath, csv: csvPath, dryRun: false, force: false, deploy: false },
    feed: () => JSON.parse(readFileSync(join(root, 'data', 'products.json'), 'utf8')),
    store: () => JSON.parse(readFileSync(join(state, 'catalog.json'), 'utf8')),
    writeCSV: (text) => writeFileSync(csvPath, text),
  };
}

test('holds back in-stock items that have no photo on file', async () => {
  const s = sandbox();
  const rep = await run(s.opts);

  // Five rows are sellable (1005 is Out of Stock, 1006 is Paid)...
  assert.equal(rep.counts.publishable, 5);
  // ...but with no images on disk, none of them ship.
  assert.equal(rep.counts.published, 0);
  assert.equal(rep.counts.heldBack, 5);
  assert.equal(s.feed().products.length, 0);
});

test('placeholder mode publishes everything sellable instead of holding it back', async () => {
  const s = sandbox({ config: { assets: { ...CONFIG.assets, requireImageToPublish: false } } });
  const rep = await run(s.opts);

  assert.equal(rep.counts.published, 5);
  assert.equal(rep.counts.heldBack, 0);
  assert.ok(s.feed().products.every((p) => p.imageFallback.startsWith('images/placeholders/')));
});

test('joins images by SKU and publishes only those', async () => {
  const s = sandbox({ images: ['GFT-1001', 'GFT-1002', 'GFT-1005'] });
  const rep = await run(s.opts);

  assert.equal(rep.counts.published, 2); // 1005 has a photo but is Out of Stock
  assert.equal(rep.counts.heldBack, 3);

  const feed = s.feed();
  assert.deepEqual(feed.products.map((p) => p.sku), ['GFT-1001', 'GFT-1002']);
  assert.equal(feed.products[0].image, 'images/products/GFT-1001.jpg');
  assert.equal(feed.products[0].maker, 'Example Maker Co.');
  assert.equal(feed.products[0].makerLoc, null); // not in makers.json — a clean miss, not a crash
  assert.equal(feed.source, 'ricochet-csv');
});

test('the feed carries everything a product card renders', async () => {
  const s = sandbox({ images: ['GFT-1001'] });
  await run(s.opts);
  const p = s.feed().products[0];
  // Name, price, quantity, stock status, consignor, description — plus the
  // intake date the "just in" facet needs and the SKU the photo is keyed on.
  for (const field of ['sku', 'name', 'price', 'quantity', 'status', 'maker', 'description', 'addedAt', 'category'])
    assert.ok(field in p, `feed is missing ${field}`);
  assert.equal(p.quantity, 6);
  assert.equal(p.status, 'In Stock');
  assert.equal(p.description, 'Stoneware, dishwasher safe');
  assert.equal(p.addedAt, '2026-03-04');
});

test('the feed publishes the facet definitions from config', async () => {
  const s = sandbox({ images: ['GFT-1001'] });
  await run(s.opts);
  const f = s.feed().facets;
  assert.ok(Array.isArray(f.priceBands) && f.priceBands.length);
  assert.equal(typeof f.newArrivalDays, 'number');
});

test('the image join uses the cleaned SKU, so a photo named without the apostrophe matches', async () => {
  const s = sandbox({ images: ['GFT-1007'] });
  await run(s.opts);
  const candle = s.feed().products.find((p) => p.sku === 'GFT-1007');
  assert.equal(candle.name, 'Candle, 8oz "Cherry Blossom"');
  assert.equal(candle.category, 'Candles & Fragrance');
  assert.equal(candle.image, 'images/products/GFT-1007.jpg');
});

test('Low Stock ships, and is flagged so the card can say so', async () => {
  const s = sandbox({ images: ['GFT-1004'] });
  await run(s.opts);
  const cardSet = s.feed().products.find((p) => p.sku === 'GFT-1004');
  assert.equal(cardSet.lowStock, true);
  assert.equal(cardSet.category, 'Cards & Stationery');
});

test('skips an identical file, and runs it anyway under --force', async () => {
  const s = sandbox({ images: ['GFT-1001'] });
  await run(s.opts);

  const second = await run(s.opts);
  assert.equal(second.status, 'skipped');
  assert.deepEqual(second.wrote, []);

  const forced = await run({ ...s.opts, force: true });
  assert.equal(forced.status, 'applied');
  assert.equal(forced.counts.added, 0); // same data — nothing new
});

test('aborts when the export loses more rows than the guard allows', async () => {
  const s = sandbox({ images: ['GFT-1001'] });
  await run(s.opts); // baseline: 7 rows

  s.writeCSV(HEADER + '\n' + row('GFT-1001', 'Hand-thrown Mug', '32.00', 6, 'In Stock') + '\n');
  await assert.rejects(() => run(s.opts), /fell 85.7%|past the 40% guard/);

  // the site was left untouched
  assert.equal(s.feed().products.length, 1);
  assert.equal(s.store().lastRun.csvRows, 7);
});

test('--force overrides the guard when the drop is real', async () => {
  const s = sandbox({ images: ['GFT-1001'] });
  await run(s.opts);
  s.writeCSV(HEADER + '\n' + row('GFT-1001', 'Hand-thrown Mug', '32.00', 6, 'In Stock') + '\n');

  const rep = await run({ ...s.opts, force: true });
  assert.equal(rep.status, 'applied');
  assert.equal(rep.counts.missing, 0); // only 1001 was ever published, and it stayed
});

test('a SKU that leaves the export is unpublished, not deleted', async () => {
  const s = sandbox({ images: ['GFT-1001', 'GFT-1002'] });
  await run(s.opts);
  assert.equal(s.feed().products.length, 2);

  // 1002 sells out and drops off the report; pad the file so the guard stays quiet
  s.writeCSV([
    HEADER,
    row('GFT-1001', 'Hand-thrown Mug', '32.00', 6, 'In Stock'),
    row('GFT-1003', 'Union Station Tea Towel', '24.00', 12, 'In Stock'),
    row('GFT-1004', 'Letterpress Card Set', '18.50', 9, 'In Stock', 'Anacostia Press'),
    row('GFT-1007', 'Candle', '28.00', 20, 'In Stock', 'Shaw Candle Co.'),
    row('GFT-1008', 'Wool Scarf', '78.00', 2, 'In Stock', 'Blue Ridge Fibers'),
  ].join('\n') + '\n'); // five rows of seven — inside the 40% drop guard

  const rep = await run(s.opts);
  assert.equal(rep.counts.missing, 1);
  assert.deepEqual(rep.missing.map((m) => m.sku), ['GFT-1002']);

  const record = s.store().records['GFT-1002'];
  assert.ok(record, 'the record survives');
  assert.equal(record.isPublished, false);
  assert.ok(record.missingSince);
  assert.equal(s.feed().products.length, 1);
});

test('an item that sells mid-day becomes unpublished without leaving the export', async () => {
  const s = sandbox({ images: ['GFT-1001'] });
  await run(s.opts);
  assert.equal(s.feed().products.length, 1);

  // Same row, now marked Paid — Ricochet keeps it in the report.
  s.writeCSV(readFileSync(FIXTURE, 'utf8').replace('6,"In Stock",70', '0,"Paid",70'));
  const rep = await run(s.opts);

  assert.equal(rep.counts.missing, 0); // it never left the file
  assert.equal(s.feed().products.length, 0);
  assert.equal(s.store().records['GFT-1001'].isPublished, false);
});

test('reports price and quantity changes', async () => {
  const s = sandbox({ images: ['GFT-1001'] });
  await run(s.opts);

  s.writeCSV(readFileSync(FIXTURE, 'utf8').replace('70%,32.00,32.00', '70%,36.00,36.00').replace('2026-03-04,6', '2026-03-04,4'));
  const rep = await run(s.opts);

  assert.equal(rep.counts.changed, 1);
  const fields = rep.changed[0].deltas.map((d) => d.field).sort();
  assert.deepEqual(fields, ['price', 'quantity']);
  assert.equal(s.feed().products[0].price, 36);
});

test('dry run writes nothing', async () => {
  const s = sandbox({ images: ['GFT-1001'] });
  const rep = await run({ ...s.opts, dryRun: true });

  assert.equal(rep.counts.published, 1);
  assert.deepEqual(rep.wrote, []);
  assert.throws(() => s.store()); // no state file was created
});

test('aborts on a header the mapping does not cover', async () => {
  const s = sandbox();
  s.writeCSV('Widget Code,Name,"Agreed Price"\nA-1,Mug,5\n');
  await assert.rejects(() => run(s.opts), /missing required column\(s\): sku/);
});
