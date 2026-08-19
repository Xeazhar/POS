# CalePOS load test

`pos-checkout.js` simulates concurrent cashier terminals ringing sales against the
**POS-Stress test** Supabase project — the same `resolve_pin_login` → password grant →
`complete_sale` sequence `completeSale()` in `src/lib/api.js` uses (its primary path since
`migrate_complete_sale_rpc.sql`: one atomic RPC does till check + invoice allocation + transaction
insert + item inserts + stock movements + audit event server-side, instead of 4 separate
round trips), so it exercises real contention on `allocate_invoice_number`'s per-branch row lock,
not a synthetic approximation.

It targets `SUPABASE_URL` from `pos-frontend/.env.test` — only ever the dedicated load-test
project, never `calepos-dev`/`calepos-staging`/production, because those credentials simply
aren't in that file.

## Setup (once)

1. `npm run setup:load-test` (repo root: `pos-frontend/`) — provisions the 7 branches + 28
   staff accounts and writes their login codes/PINs into `.env.test`. See the root
   `docs/CODEMAP.md` "Load-test user provisioning" section.
2. Install [k6](https://k6.io) — a separate binary, not an npm package:
   - Windows: `winget install k6` or `choco install k6`
   - macOS: `brew install k6`
   - Linux: see <https://grafana.com/docs/k6/latest/set-up/install-k6/>

## Running

```bash
# Full ramp through 28 -> 50 -> 100 -> 200 concurrent cashiers (~12 min)
k6 run loadtest/pos-checkout.js

# Pin one concurrency level for a focused run
k6 run -e LEVEL=100 loadtest/pos-checkout.js
k6 run -e LEVEL=200 -e DURATION=5m loadtest/pos-checkout.js
```

Or via npm, from `pos-frontend/`:

```bash
npm run loadtest              # full ramp
npm run loadtest -- -e LEVEL=50
```

## What it does

- **Setup (once, before any VU):** logs in as each branch's supervisor, seeds 15 generic
  products per branch (skipped if that branch already has products — safe to re-run), and
  seeds one active item_pct promo per branch covering that branch's discount-eligible
  products (skipped if an active promo already exists) — seeded directly, bypassing the
  create/approve dual-control flow, same shortcut the product seeding takes.
- **Per VU:** logs in once as one of the 28 cashier accounts (cycles through them by VU
  number, so multiple VUs land on the same branch at higher concurrency — that's
  deliberate, it's what actually contends on `branches.invoice_next`), then loops: ring a 1-3
  line sale (payment method randomized 70% cash / 20% card / 10% e-wallet; a line lands
  under the branch's promo whenever its product is one of the discount-eligible ones),
  then independently rolls the sale into exactly one of — void (5%), a partial or full
  item refund (5%, 50/50 split; a full-items refund auto-voids, matching
  `refund_sale_items`' own behaviour), or stays a plain completed sale — sleeps 0.3-1s,
  repeats.
- Custom metrics: `checkout_duration`, `complete_sale_duration` (same span as
  `checkout_duration` now that checkout is one round trip — kept as a separate metric name
  since that's what the perf task asked for), `void_duration`, `refund_duration`,
  `login_duration`, `checkout_errors`, `invoice_numbers_allocated`, `voids_processed`,
  `partial_refunds_processed`, `full_item_refunds_processed`, `cash_sales`, `card_sales`,
  `ewallet_sales`, `promo_lines_sold`, `deadlock_retries` (Postgres 40P01 on
  `complete_sale` — see `migrate_complete_sale_rpc.sql`; retried once, same as
  `completeSale()` in `src/lib/api.js`), plus k6's standard `http_req_duration` /
  `http_req_failed`. `summaryTrendStats` includes p99 for visibility (not gated).
- Thresholds (fail the run if breached): `http_req_failed` rate < 2%, checkout p95 < 2s,
  login p95 < 1.5s. Adjust in `pos-checkout.js`'s `options.thresholds` for your own bar.

## After a run

Sales/voids/invoice numbers pile up in `POS-Stress test` — that's expected, it's a throwaway
project. Nothing here ever touches `calepos-dev`/`calepos-staging`/production.

To reset between runs without recreating the project: re-run the SQL in
`supabase/wipe_non_user_data.sql` against `POS-Stress test` (truncates sales/inventory/
promos/shifts, keeps staff/branches) — or just let sales accumulate; invoice numbers and
`client_id` dedup mean repeat runs don't collide.
