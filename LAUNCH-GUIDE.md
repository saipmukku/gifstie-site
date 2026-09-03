# giftsie — Website Launch Guide

## What's in this folder
- `index.html` — the full site prototype (Home, Catalog, Gallery, Makers, My Story, About/Contact). Open it in any browser.
- `images/` — logo + wordmark SVGs, and `placeholders/` shown until real photos are added.

## 1. Add your real photos
All image slots are generic and numbered. Drop photos into `images/` with these exact names — they appear automatically (numbered placeholders show until then):

| Filename | Where it appears |
|---|---|
| `photo-1.jpg` … `photo-6.jpg` | Gallery + Instagram strip (photo-1 is also the home hero) |
| `photo-7.jpg` | Custom-gifts section on Home |
| `photo-8.jpg` | Gallery only |
| `founder.jpg` | Founder portrait (My Story) |
| `maker-1.jpg` … `maker-6.jpg` | Maker cards (Makers page; #1–#3 also on Home) |
| `product-1.jpg` … `product-12.jpg` | Catalog demo cards (Shopify supplies real ones at launch) |

Maker names, bios, product names and prices are likewise generic (`Maker #N`, `Product #N`, `$ —`) — edit the `MAKERS` and `PRODUCTS` arrays near the bottom of `index.html` to fill them in.

## 2. Moving to your Shopify domain
The prototype is designed to convert 1:1 into a Shopify Online Store 2.0 theme:

1. In Shopify admin: **Online Store → Themes** — either customize a free theme (e.g. *Dawn*) using this design as the spec, or have the prototype converted into Liquid templates (each page here maps to a Shopify template: `index`, `collection`, `page.gallery`, `page.makers`, `page.story`, `page.contact`).
2. The demo "Add to bag" buttons become real Shopify cart buttons; the cart in the header becomes `{{ cart.item_count }}`.
3. The contact and maker-application forms become Shopify `{% form 'contact' %}` blocks — submissions arrive at your store email, no extra service needed.
4. Point your domain in **Settings → Domains**.

## 3. The catalog: Ricochet CSV → website

The catalog on the site today is **real giftsie inventory** — 1,415 in-stock items
from 30 makers, published from a Ricochet product export. The site is browse-only:
it shows what is on the shelves and drives a visit, it does not sell online.

```
Ricochet export (.csv)  →  node sync/sync.mjs  →  data/products.json  →  the website
```

**To refresh the catalog (about 90 seconds):**
1. In Ricochet, export the product list to CSV.
2. Run the sync:
   ```bash
   node sync/sync.mjs --csv "~/Downloads/Products <timestamp>.csv"
   ```
   Add `--dry-run` first to see what would change without writing anything.
3. Commit the updated `data/products.json` and push — Vercel redeploys.

The job treats every export as the full authoritative snapshot. It validates the
columns, **aborts rather than let a truncated export empty the website**, soft-deletes
SKUs that fall out of the export instead of dropping them (consignment stock turns
over fast, and hard deletes would strand links), and prints exactly what changed.

**Why CSV and not the Shopify bridge.** Ricochet publishes no merchant API, and its
Shopify add-on is a paid premium add-on that also requires a Shopify plan above Basic
— roughly \$150–200/month for a site with no online checkout. The CSV path costs
nothing and works today. The page still supports Shopify: if `shopifyDomain` and
`storefrontToken` are ever filled into `SITE_CONFIG`, the Storefront API takes
priority automatically and the static feed becomes the fallback. That is the upgrade
path the day checkout is wanted, and it needs no rewrite.

**Photos are a separate problem from data.** A CSV cannot carry images and the export
has no image column at all. Photos live in `images/products/<SKU>.jpg` and are joined
by SKU at sync time — see `images/products/README.md`, which also maps each SKU prefix
to its maker so photography can be batched one consignor at a time. Items with no photo
render a line-art glyph for their category rather than a blank box.

**Two data cleanups in Ricochet are worth more than any code change:**
- **`Category`** is filled on ~1% of items, so site navigation is currently derived from
  product names by a keyword ruleset. Filling it in Ricochet makes navigation
  authoritative and retires the ruleset.
- **`Short description`** is filled on ~18% of items. It is the only product copy that
  exists, and it is what shows when a customer hovers a card.

Ricochet docs: https://help.ricoconsign.com/en/articles/9658115-shopify-integration

## 4. Email domain & newsletter
- Buy/attach your domain in Shopify, then set up branded email (e.g. `hello@giftsie.shop`) via **Settings → Notifications → Sender email** with Google Workspace or Zoho Mail handling the mailbox.
- The newsletter form on the site is ready to wire to **Shopify Email** (free tier included) or **Mailchimp** — Ricochet also syncs customer emails to Mailchimp natively, so in-store and online lists can merge.
- Update the placeholder `hello@giftsie.shop` links in `index.html` once the address is live.

## 5. Social integrations
- Instagram/TikTok/Facebook links are in the footer and Home page (update handles if needed).
- For a live Instagram feed replacing the static grid, install a Shopify app like *Instafeed* and drop it into the "Follow along" section.

## 6. Meta (Facebook/Instagram) analytics
The site has a built-in **Meta Pixel** integration — set `metaPixelId` in `SITE_CONFIG` (`index.html`) to your Pixel ID from Meta Events Manager (Business Suite → Events Manager → Data sources). Once set, the site automatically reports:

- **PageView** on load and on every page change (Home → Catalog etc.)
- **AddToCart** when a visitor clicks a product's buy button
- **InitiateCheckout** when the Bag button is clicked
- **Lead** on every form submit (newsletter, contact, maker application)

Recommended Meta setup, in order of impact:
1. **Meta Pixel on this site** (above) — free traffic analytics + builds retargeting audiences from day one.
2. **Shopify's "Facebook & Instagram" sales channel app** once on Shopify — adds the server-side Conversions API (more reliable than browser-only pixels post-iOS14), syncs the product catalog to Meta, and enables **Instagram/Facebook Shop tabs and product tagging** — every synced Ricochet product becomes taggable in giftsie's Instagram posts.
3. **Advantage+ catalog ads** — retarget visitors with the exact products they viewed, fed by the catalog sync.
4. Add a **cookie-consent notice** before launch since the Pixel sets tracking cookies.

## 7. Placeholders to replace before launch
- Real hours, phone number, founder name and story text (marked *replace* in italics on the page)
- Google Maps embed (instructions shown in the map slot on the About/Contact page)
- Maker bios/photos for new makers (template cards on the Makers page)
