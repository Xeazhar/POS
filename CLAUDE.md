# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CalePOS — offline-first, multi-branch point of sale for retail and meat counters (₱), built for the Philippines with BIR fiscal-readiness controls (sequential OR numbering, immutable sales records, void/audit logging). Proprietary, authored by Jazper Bustria — see `LICENSE`.

The runnable app is entirely inside `pos-frontend/`; the repo root only holds the license and top-level docs.

## Commands

All commands run from `pos-frontend/`, not the repo root.

```bash
cd pos-frontend
npm install
npm run dev       # local dev server (Vite)
npm run build     # production bundle
npm run preview   # serve the production build + PWA locally
npm run lint      # ESLint (flat config, eslint.config.js)
```

There is no test suite/framework configured in this repo (no `*.test.*`/`*.spec.*` files, no test script). Verify changes via `npm run lint`, `npm run build`, and manual exercise through `npm run dev`.

Env vars go in `pos-frontend/.env.local` (copy from `.env.example`): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` are required to talk to a real backend. Without them, the app falls back to an in-memory offline demo mode (`npm run dev` only — production builds refuse demo login unless `VITE_ALLOW_DEMO=true`).

Database is Supabase Postgres + RLS. Schema lives in `pos-frontend/supabase/schema.sql`; incremental changes are `pos-frontend/supabase/migrate_*.sql`, applied by hand in the Supabase SQL editor (no migration runner) — check file comments for ordering/dependencies before applying.

## Architecture

**There is an existing, actively-maintained architecture doc — read `pos-frontend/docs/CODEMAP.md` before making non-trivial changes.** It documents the full route map, store ownership, feature data-flow diagrams (POS sale, day-end, promos, refunds, offline sync), a "what file do I edit for X" cheat sheet, and an in-progress backlog item (multi-concurrent promos) with an implementation sketch. Keep it updated when you change flows it documents.

Summary of the layering (detail in CODEMAP.md):

```
src/App.jsx              routes + role/module gates (RequireModule)
  → src/components/shared/Shell.jsx   sidebar (constants/nav.js), logout, sync chip
  → src/pages/*, src/pages/manager/*  feature entry points; most orchestration lives here
    → src/stores/posStore.js          useAuthStore, useCartStore, useProductStore, useInventoryStore (Zustand)
    → src/stores/syncStore.js         online/queue status only
      → src/lib/api.js                ONLY place that talks to Supabase directly (queries, RPC, mapping)
      → src/offline/*                 IndexedDB (Dexie) + outbox queue + replay engine
```

Rule of thumb enforced throughout the codebase: UI/pages never call Supabase directly — always through `src/lib/api.js`. Everything else (stores, offline queue) sits between pages and that boundary.

**Offline-first is a real first-class flow, not a cache.** Writes go: UI action → local Dexie write / `enqueue(QUEUE_TYPES.*)` → IndexedDB, then a connectivity watcher (`src/offline/connectivity.js`) triggers `syncEngine.syncBranch()` which pushes the queue FIFO (stopping at first failure, preserving order) and then pulls remote state. `pullFromRemote` deliberately never overwrites local stock counts while stock-affecting queue items are still pending — those counts are locally owned until pushed. See `src/offline/queueTypes.js` for the op catalog and `src/offline/syncEngine.js` for push/pull semantics.

**Roles & permissions**: five roles (`cashier`, `supervisor`, `manager`, `admin`, `master`) with default module lists in `src/utils/roles.js` (`DEFAULTS`), overridable per-user via a `permissions[]` array. `canAccessModule(user, moduleId)` is the single check used by both route gates (`App.jsx`) and sidebar visibility (`constants/nav.js`) — keep them in sync when adding a module. The database still enforces branch access independently via Postgres RLS (`current_staff_branch()` for staff, `is_manager()` for cross-branch manager access), so UI gating is not the security boundary.

**Errors**: user-facing errors go through the catalog in `src/utils/errors.js` (`appError(code, detail)`), coded by area (`AUTH`, `SALE`, `INV`, `DEV`, `SYNC`, `DATA`, `TILL`, `PRINT`, `GEN`). Codes are shown to staff so they can quote them to support — keep codes stable, change message text freely, add new codes rather than reusing one across unrelated failures.

**Auth session**: Supabase auth token lives in `sessionStorage` only (not `localStorage`), plus a "browser closed" flag so closing the tab forces re-login while a reload does not — see `src/lib/supabase.js` and `src/offline/sessionLifecycle.js`. Don't reintroduce localStorage-persisted auth tokens.

## Versioning (required on every commit)

`pos-frontend/package.json` `version` is the **single source of truth**. `vite.config.js`
bakes it into the bundle (`__APP_VERSION__`), `src/utils/version.js` exposes it, the Shell
sidebar shows it as `vX.Y.Z`, and `audit_events.app_version` records it. Never hardcode a
version anywhere else — `VITE_APP_VERSION` exists only as a build-time override.

**Every commit that changes app behaviour must bump the version and add a `CHANGELOG.md`
entry**, in the same commit as the change:

- **MAJOR** — staff need retraining, or fiscal output changes (receipt format, tax
  computation, OR numbering). These need a heads-up before deploy.
- **MINOR** — new capability, existing behaviour unchanged.
- **PATCH** — bug fix, copy, styling.

Docs-only, comment-only, or refactor-with-no-behaviour-change commits don't need a bump.

Write CHANGELOG entries for the person running the store, not for a developer: what changed
for them and what they must do differently. Call out anything that changes what a customer
pays or what prints on a receipt — explicitly, not buried in a list.

Distinct from `/version.json`, which carries a per-**build** token used to detect a deploy
under an open tab (`src/hooks/useAppVersion.js`). Two deploys of the same release are still
different bundles, so that token must stay build-based, not semver-based.

## Notable non-obvious conventions

- `cash_drawer_entries` is the current table name for what used to be `petty_cash`; `src/lib/api.js` falls back to the legacy name until `migrate_rename_petty_cash_to_cash_drawer_entries.sql` has been applied to a given environment — check both when touching cash-drawer/petty-cash code.
- Restaurant-type branches (`branchType === 'restaurant'`) get different nav labels/order and menu-pricing logic (`src/utils/ulam.js` handles ulam/budget-tier combo detection) vs. retail branches — don't assume retail terminology (SKU/barcode) applies everywhere.
- Supervisor-gated actions (void line, price override, etc.) go through `src/components/shared/SupervisorApprove.jsx`; managers can "approve as manager" cross-branch per `migrate_manager_can_approve_any_branch.sql`.
- Never put the Supabase **service role** key in frontend code or Cloudflare env — only the publishable/anon key; access control is RLS, not key secrecy.
- **Network catalog (`catalog_products`) vs. a branch's live product (`products`) are different tables** — `manager/Data.jsx`'s `ManagerNetworkCatalog` edits the shared template (`api.updateCatalogProduct`), which sets defaults for *future* adoptions and does **not** change a product a branch already adopted. **Exception:** the "Discountable" toggle specifically also cascades to every branch that already adopted the item (`api.cascadeDiscountEligibleToBranches`, matched via `products.catalog_product_id`), because that's the page managers actually use for this and a silent no-op there was a real bug. Other fields (price, name, etc.) are still template-only — use that branch's own Catalog/Inventory page (`Products.jsx` for managers, `SupervisorCatalogAdopt.jsx` for supervisors, both via `api.updateProductRow`) to change those on an already-adopted item.
- `api.updateProductRow`'s payload only includes `discount_eligible` when the caller explicitly passes `discountEligible` — a partial update (e.g. a stock-only adjustment) must never silently clear it. Any *other* field added to that function later needs the same guard, or a caller that only means to touch one field will blank out the rest.
