# Product photos — drop them here

**The filename is the SKU.** That is the entire contract between this folder and
the catalog: the sync job indexes this directory once per run and joins each
photo to its product by name.

```
images/products/<SKU>.<ext>
```

## Rules

- **Use the cleaned SKU — no apostrophe.** Ricochet exports SKUs as `'004001`;
  the leading apostrophe is Excel's text guard and is stripped on ingest.
  The file must be `004001.jpg`, never `'004001.jpg`.
- **Extensions:** `jpg`, `jpeg`, `png`, `webp`, `avif`. If a SKU has more than
  one, the first in that order wins.
- **Matching ignores case.** `01W003.JPG` and `01w003.jpg` both match SKU `01W003`.
- **Alternate shots are ignored, not broken.** A `-2`, `-3` … suffix
  (`004001-2.jpg`) sits alongside the primary without confusing the join, so you
  can stage extra angles here before the site ever uses them.
- **Nothing else needs touching.** No manifest, no config edit. Add the file,
  re-run the sync, the photo appears.

## What happens when a photo is missing

Today: the card renders a **line-art glyph for its category** and makes no
network request. Nothing 404s and nothing looks broken — but nothing looks like
the actual product either.

When real photography exists and unphotographed items should be held back from
the site instead, flip one flag:

```json
// sync/config.json
"assets": { "requireImageToPublish": true }
```

The sync then reports every held-back SKU by name so you know exactly what is
missing.

## Sourcing photos by maker — the SKU prefix tells you who made it

The first three SKU characters map **1:1 onto the consignor**. Every prefix
count matches its consignor count exactly, so you can hand a maker their own
prefix and ask for their product shots, or batch a shoot one consignor at a
time.

| Prefix | Consignor | Items in export | In stock |
|---|---|---|---|
| `00H` | Harmonized Treasures LLC | 341 | 330 |
| `000` | (house stock — no consignor) | 208 | 172 |
| `004` | Bridget Coral | 207 | 141 |
| `00D` | Violet Red Studio LLC | 181 | 181 |
| `007` | Heidi Pix LLC | 76 | 70 |
| `00J` | Hector Zarate | 63 | 44 |
| `008` | X40 Designs LLC | 56 | 56 |
| `00K` | Beasties and Besties LLC | 46 | 46 |
| `006` | Ramuri LLC | 45 | 42 |
| `005` | Mimonovas El Gocho Express LLC | 36 | 29 |
| `00C` | Mimi Fekade | 36 | 32 |
| `002` | Smell of Love Candles LLC | 34 | 21 |
| `00I` | Dagmar Tawil | 33 | 25 |
| `00Z` | Circle Time Books LLC | 30 | 30 |
| `009` | Claudia Alvarez | 25 | 25 |
| `00E` | Faith and Grace Co LLC | 22 | 20 |
| `01W` | JustAlly LLC | 22 | 21 |
| `003` | Mola Creative Studio LLC | 18 | 18 |
| `00F` | Vida Dulce Imports DBAKVZ Designs LLC | 18 | 18 |
| `00Y` | Sofia Cecilia Essence LLC | 18 | 9 |
| `01U` | Neighborgoods LLC | 16 | 13 |
| `01H` | Julie Gross | 15 | 15 |
| `01I` | Mann Made Designs | 12 | 12 |
| `00A` | Nancy Viso | 11 | 11 |
| `00G` | Chic and Etnic LLC | 11 | 11 |
| `00R` | Patsy Cahill | 10 | 7 |
| `01V` | IndiBlossom LLC | 6 | 6 |
| `00M` | Mimi Marchese | 4 | 4 |
| `00W` | The Black Swan Company LLC | 3 | 3 |
| `00L` | Patricia Guisandes | 2 | 2 |
| `01K` | Liana Miranda | 1 | 1 |

Photos live here and never travel through the Ricochet CSV — a spreadsheet
cannot carry binaries, and the export has no image column at all. This folder is
the permanent home for the half of the catalog that Ricochet will never send.
