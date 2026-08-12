# Archived: restaurant / carinderia features

**Status:** disabled in app (`RESTAURANT_FEATURES_ENABLED = false` in
`src/utils/features.js`). Active product focus: **meat + retail** POS only.

## What was archived (not deleted)

- Branch type `restaurant` (create/edit + network catalog toggle hidden)
- Auth / branch loads coerce `branch_type` → `retail` while the flag is off
- Menu / potahe / “available today” / Edit menu flows on POS
- Dine-in / takeout, budget price tiers, ulam combo detection in cart UI
- Restaurant-specific inventory/import/catalog copy and filters

## Still in the codebase (safe to revive)

| Area | Location |
|------|----------|
| Feature gate | `src/utils/features.js` |
| Ulam / plate math (also used by retail `lineTotal`) | `src/utils/ulam.js` — **do not delete** |
| Schema | `migrate_restaurant_branch.sql`, `migrate_ulam_ordering.sql`, `migrate_catalog_branch_type.sql` |
| UI gates | `POS.jsx`, `Cart.jsx`, `Products.jsx`, `Dashboard.jsx`, `Branches.jsx`, catalogs, etc. |

Historical transactions may still store `order_type`, `ulam_combo`, `price_tier` —
reports leave those columns alone.

## How to restore

1. Set `RESTAURANT_FEATURES_ENABLED = true` in `src/utils/features.js`
2. Redeploy frontend
3. Optionally set `branches.branch_type = 'restaurant'` for carinderia branches again
4. Confirm Network catalog “Restaurant / potahe” tab and Branches type select reappear

## DB note

Existing `restaurant` rows in `branches` / `catalog_products` are unchanged. The app
simply ignores that type until the flag is flipped back on.
