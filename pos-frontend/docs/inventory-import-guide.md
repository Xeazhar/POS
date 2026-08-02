# Inventory import guide (retail)

Use this when loading or restocking products for a **Retail** branch in CalePOS.

## IDs for Power BI / tracking

| Field | Example | Use |
|-------|---------|-----|
| `product_code` | `0001` | Easy tracking number per branch (auto-assigned) |
| `product_id` | UUID | Stable join key in Power BI / sales lines |
| `sku` | `GRO-SUG-1` | Business key for CSV import matching |
| `branch_id` | UUID | Filter / relate by store |

**Do not invent IDs in import files.** Import with `sku` (and barcode). After import, export from **Reports → Price Listing / Catalog** (includes `product_code` + `product_id`).

## Steps

1. In **Manager → Branches**, confirm the branch type is **Retail** (default).
2. Open **Manager → Data**, select that branch.
3. Import a CSV or XLSX file (sample: `/samples/inventory-import.csv`).
4. Review the preview (creates vs restocks vs skipped), then commit.
5. Optionally export from **Reports → Price Listing / Catalog** for Power BI (`product_code` + `product_id`).

## Required columns (import)

| Column | Example | Notes |
|--------|---------|--------|
| `name` | `White Sugar 1kg` | Shown on POS / receipts |
| `sku` | `GRO-SUG-1` | Unique per branch (business key) |
| `barcode` | `4801000000011` | Digits only; unique per branch |
| `price` | `65` | PHP selling price |
| `stock` | `24` | Quantity to **add** on import |

## Optional columns

| Column | Example | Notes |
|--------|---------|--------|
| `category` | `Groceries` | e.g. Groceries, Bakery, Meat |
| `pricingMode` | `pc` or `kg` | Default `pc`. Use `kg` for weighed meat |
| `lowStockAt` | `5` | Low-stock threshold (default 5) |

## How restock works

- If SKU or barcode already exists in that branch, the import **updates** name/price/category and **adds** the file’s `stock` to on-hand quantity (it does not replace stock).
- New SKUs create the product (system assigns `product_id`), then apply the stock as a restock movement.

## Tips

- Keep barcodes unique. Duplicate rows in the same file are skipped.
- For meat sold by weight, set `pricingMode` to `kg` and enter stock in kilograms (decimals OK).
- After import, cashiers sell from **POS**; managers adjust stock from **Inventory** or day-end workflows.

## Sample import rows

```csv
name,sku,barcode,category,pricingMode,price,stock,lowStockAt
White Sugar 1kg,GRO-SUG-1,4801000000011,Groceries,pc,65,24,5
Pork Belly,MEA-BELLY,4801000000042,Meat,kg,320,12.5,3
Pandesa,BAK-PAN,4801000000073,Bakery,pc,8,80,20
```
