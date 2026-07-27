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

## 3. Ricochet catalog integration (important)
**Don't build a custom webhook — Ricochet has an official Shopify integration** (Premium paid add-on, requires a Shopify plan above Basic):

1. In Ricochet: **Preferences → Integrations → Shopify** → choose a plan and pay.
2. Ricochet support schedules a call and walks you through creating the Admin API access token (your Shopify login needs "Develop apps" permission).
3. Per item you want online, in Ricochet set: **Category** (= Shopify Product Type), **weight**, **at least one photo**, and toggle **Shopify ON**.
4. Items, prices, photos and stock then sync to Shopify automatically; online sales appear back in Ricochet (Shopify → Orders), and new customers flow into Ricochet.

Notes: returns are handled inside Shopify (restock manually); Ricochet rewards/consignor credit don't work as online currency.
Docs: https://help.ricoconsign.com/en/articles/9658115-shopify-integration

## 4. Email domain & newsletter
- Buy/attach your domain in Shopify, then set up branded email (e.g. `hello@giftsie.shop`) via **Settings → Notifications → Sender email** with Google Workspace or Zoho Mail handling the mailbox.
- The newsletter form on the site is ready to wire to **Shopify Email** (free tier included) or **Mailchimp** — Ricochet also syncs customer emails to Mailchimp natively, so in-store and online lists can merge.
- Update the placeholder `hello@giftsie.shop` links in `index.html` once the address is live.

## 5. Social integrations
- Instagram/TikTok/Facebook links are in the footer and Home page (update handles if needed).
- For a live Instagram feed replacing the static grid, install a Shopify app like *Instafeed* and drop it into the "Follow along" section.

## 6. Placeholders to replace before launch
- Real hours, phone number, founder name and story text (marked *replace* in italics on the page)
- Google Maps embed (instructions shown in the map slot on the About/Contact page)
- Maker bios/photos for new makers (template cards on the Makers page)
