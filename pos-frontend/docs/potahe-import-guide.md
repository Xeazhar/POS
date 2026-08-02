# Ulam / potahe menu import guide

Use this when loading menu items for a **Restaurant / carinderia** branch in CalePOS.

## IDs for Power BI / tracking

| Field | Example | Use |
|-------|---------|-----|
| `product_code` | `0001` | Easy tracking number per branch (auto-assigned) |
| `product_id` | UUID | Stable join key in Power BI / sales lines |
| `sku` | `ULAM-ADOB` | Business key for CSV import matching |
| `branch_id` | UUID | Filter / relate by store |
| `transaction_id` | UUID | Join line items to invoices |

**Do not invent IDs in import files.** Import with `sku`. Export from **Reports → Price Listing / Catalog** for Power BI.

## Steps

1. In **Manager → Branches**, set the branch type to **Restaurant / carinderia**.
2. Run the SQL migration `migrate_ulam_ordering.sql` in Supabase (adds menu kinds, budget price, dine-in/takeout).
3. Assign a cashier to that branch.
4. Open **Manager → Data**, select the restaurant branch.
5. Import a CSV or XLSX file (sample: `/samples/potahe-menu-import.csv`).
6. On the cashier POS, tap **Today’s potahe** to mark what was cooked that day.

## Required columns (import)

| Column | Example | Notes |
|--------|---------|--------|
| `name` | `Adobo` | Dish name shown on POS |
| `sku` | `ULAM-ADOB` | Unique per branch (business key) |
| `category` | `Meat` | Meat, Veggie, Pancit, Drink, Rice, Extra |
| `price` | `70` | Regular PHP price |

## Optional columns

| Column | Example | Notes |
|--------|---------|--------|
| `menuKind` | `meat` | `meat` \| `veggie` \| `pancit` \| `drink` \| `rice` \| `extra` (inferred from category if omitted) |
| `budgetPrice` | `55` | Budget tier for meat/veggie ulam only |
| `barcode` | `480100099001` | Optional for restaurant |
| `availableToday` | `true` / `false` | Default `true` (on the menu today) |

## Item categories

- **Meat** ulam — regular + optional budget price (e.g. ₱70 / ₱55)
- **Veggie** ulam — regular + optional budget price
- **Pancit** — flat price (no budget tier)
- **Drink** — flat price
- **Rice** / **Extra** — flat price; rice is optional with ulam orders

## Ordering on POS

Cashiers can sell rice only, 1 ulam ± rice, 2 ulams ± rice, or any item standalone.

- Meat/veggie lines get a **Regular / Budget** toggle (per item; pricing is the sum of chosen tiers).
- When exactly **2 ulams** are in the cart, a badge shows **Meat+Meat**, **Meat+Veggie**, or **Veggie+Veggie** for reference only (not a flat combo price).
- **Dine-in / Takeout** is tracking only — no fee.

## Notes

- Restaurant sales do **not** deduct inventory stock.
- Cashiers turn dishes **On/Off** daily without re-importing.
- Managers edit prices from **Data**, **Menu**, or the branch dashboard.
