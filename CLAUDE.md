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

**There is an existing, actively-maintained architecture doc — read** **`pos-frontend/docs/CODEMAP.md`** **before making non-trivial changes.** It documents the full route map, store ownership, feature data-flow diagrams (POS sale, day-end, promos, refunds, offline sync), a "what file do I edit for X" cheat sheet, and an in-progress backlog item (multi-concurrent promos) with an implementation sketch. Keep it updated when you change flows it documents.

Summary of the layering (detail in CODEMAP.md):

```text
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

## Documentation

`pos-frontend/docs/CODEMAP.md` is the project's detailed documentation hub. It contains the architecture, route map, store ownership, feature data flows, database-related information, permissions, security considerations, POS business rules, and guidance on which files to edit.

### Documentation Rules

* Read `pos-frontend/docs/CODEMAP.md` before making non-trivial changes.
* Use the relevant sections of `CODEMAP.md` rather than rediscovering project structure from scratch.
* Keep `CODEMAP.md` synchronized with the actual implementation.
* When a change introduces or modifies a persistent architecture, database, permission, security, data-flow, or POS business rule, update the relevant section of `CODEMAP.md` in the same task.
* Do not add historical conversation details, abandoned approaches, or temporary debugging information to `CODEMAP.md`.
* Documentation must describe the current implementation, not what the project used to do.
* If `CODEMAP.md` contradicts the implementation, verify the actual code and correct the documentation.
* Keep `CLAUDE.md` focused on critical rules and conventions; put detailed project knowledge in `CODEMAP.md`.
* Do not create additional documentation files for information that already belongs naturally in `CODEMAP.md` unless `CODEMAP.md` becomes too large to use efficiently.

## Task Workflow & Context Management

### Planning Before Implementation

For non-trivial tasks, separate investigation/planning from implementation.

**1. Investigate first**

* Inspect only the files relevant to the task.
* Read `pos-frontend/docs/CODEMAP.md` when the task affects architecture, data flow, routing, stores, offline sync, or multiple features.
* Understand the existing implementation and dependencies before editing.
* Identify the root cause or required changes.
* Do not modify files during investigation unless explicitly necessary.

**2. Create a concise implementation plan**

Before making changes, determine:

* Which files need to change.
* What needs to change and why.
* Any important risks, dependencies, or side effects.
* How the change will be verified.

Keep the plan focused on the requested task. Do not propose unrelated improvements.

**3. Implement**

* Make only the changes required by the plan.
* Do not expand the scope unless a necessary dependency or bug is discovered.
* Avoid modifying unrelated files.
* Preserve existing architecture and conventions unless the task explicitly requires changing them.

**4. Verify**

After implementation, run the smallest relevant verification:

* `npm run lint`
* `npm run build`
* Manual testing with `npm run dev` when appropriate.
* For database/RLS changes, verify the affected access paths and queries.

Report what changed and what verification was performed.

### When Planning Is Required

Use the investigation → plan → implementation workflow for:

* Database or schema changes.
* Authentication or authorization changes.
* RLS or security changes.
* Offline synchronization changes.
* New features.
* Multi-file changes.
* Complex bugs or bugs whose root cause is unclear.
* Changes with significant architectural or data-flow impact.
* Changes involving money, sales records, refunds, voids, inventory, pricing, taxes, OR numbering, audit logs, or other fiscal behavior.

For simple, localized changes such as:

* Tailwind/CSS adjustments.
* Copy/text changes.
* Typo fixes.
* Small UI changes.
* Obvious one-file bug fixes.

Implement directly without an unnecessary planning phase.

### Context Management

Keep Claude's context focused on the current task.

* Inspect only relevant files; do not scan the entire repository unless the task genuinely requires it.
* Do not repeatedly re-read large files or documentation that is not relevant to the current task.
* Do not investigate unrelated features while solving a scoped problem.
* Do not spawn subagents for simple or localized tasks.
* Use subagents only when parallel investigation provides a meaningful benefit.
* Prefer one focused investigation over multiple overlapping investigations.
* Prefer `/compact` after completing a major task before continuing with another related task.
* Prefer `/clear` or a fresh session when switching to an unrelated task rather than carrying unnecessary context forward.
* Preserve important project knowledge in repository documentation rather than relying on conversation history.
* Do not add historical conversation details to `CLAUDE.md` unless they represent a persistent project rule or convention.

### Scope Control

Every task should have a clear scope.

Before editing, identify:

1. The requested outcome.
2. The files/components likely involved.
3. The minimum changes required.

Do not:

* Refactor unrelated code.
* Rename unrelated variables or files.
* "Clean up" surrounding code unless necessary.
* Introduce new dependencies without a clear need.
* Modify database schema when the task can be solved without it.
* Change established behavior outside the requested scope.

If an unrelated issue is discovered, mention it separately rather than silently expanding the task.

### Security & Fiscal Changes

For changes involving authentication, authorization, RLS, payments, inventory, pricing, refunds, voids, taxes, OR numbering, audit logs, or sales records:

* Treat the database/RLS layer as the security boundary.
* Check both frontend permission gates and backend/RLS enforcement where applicable.
* Consider offline behavior and synchronization implications.
* Check whether the change affects auditability or immutable sales records.
* Consider whether the change affects what a customer pays or what appears on a receipt.
* Do not weaken an existing security or fiscal control merely to make a feature easier to implement.
* Verify the affected flow before considering the task complete.

## Versioning (required on every commit)

**The project is pre-1.0 (in testing, not live).** While the version starts with `0.`,
`IS_PRERELEASE` in `src/utils/version.js` is true and the app shows "In development / Not
for live sales" on the login screen and in the sidebar. This is derived from the version,
not a separate flag — cutting `1.0.0` removes both markers automatically. Do not bump to
1.0.0 until the system is trusted to handle real money.
Only update or increment Version from 0.1.0 to 0.2.0 when the user accepts and prompted to. do not automattically adjust or update the version number.

`pos-frontend/package.json` `version` is the **single source of truth**. `vite.config.js`
bakes it into the bundle (`__APP_VERSION__`), `src/utils/version.js` exposes it, the Shell
sidebar shows it as `vX.Y.Z`, and `audit_events.app_version` records it. Never hardcode a
version anywhere else — `VITE_APP_VERSION` exists only as a build-time override.

**Every commit that changes app behaviour must bump the version and add a** **`CHANGELOG.md`**
**entry**, in the same commit as the change:

* **MAJOR** — staff need retraining, or fiscal output changes (receipt format, tax
  computation, OR numbering). These need a heads-up before deploy.
* **MINOR** — new capability, existing behaviour unchanged.
* **PATCH** — bug fix, copy, styling.

Docs-only, comment-only, or refactor-with-no-behaviour-change commits don't need a bump.


Distinct from `/version.json`, which carries a per-**build** token used to detect a deploy
under an open tab (`src/hooks/useAppVersion.js`). Two deploys of the same release are still
different bundles, so that token must stay build-based, not semver-based.

## Notable non-obvious conventions

* `cash_drawer_entries` is the current table name for what used to be `petty_cash`; `src/lib/api.js` falls back to the legacy name until `migrate_rename_petty_cash_to_cash_drawer_entries.sql` has been applied to a given environment — check both when touching cash-drawer/petty-cash code.
* Restaurant-type branches (`branchType === 'restaurant'`) get different nav labels/order and menu-pricing logic (`src/utils/ulam.js` handles ulam/budget-tier combo detection) vs. retail branches — don't assume retail terminology (SKU/barcode) applies everywhere.
* Supervisor-gated actions (void line, price override, etc.) go through `src/components/shared/SupervisorApprove.jsx`; managers can "approve as manager" cross-branch per `migrate_manager_can_approve_any_branch.sql`.
* Never put the Supabase **service role** key in frontend code or Cloudflare env — only the publishable/anon key; access control is RLS, not key secrecy.
* **Network catalog (`catalog_products`) vs. a branch's live product (`products`) are different tables** — `manager/Data.jsx`'s `ManagerNetworkCatalog` edits the shared template (`api.updateCatalogProduct`), which sets defaults for *future* adoptions and does **not** change a product a branch already adopted. **Exception:** the "Discountable" toggle specifically also cascades to every branch that already adopted the item (`api.cascadeDiscountEligibleToBranches`, matched via `products.catalog_product_id`), because that's the page managers actually use for this and a silent no-op there was a real bug. Other fields (price, name, etc.) are still template-only — use that branch's own Catalog/Inventory page (`Products.jsx` for managers, `SupervisorCatalogAdopt.jsx` for supervisors, both via `api.updateProductRow`) to change those on an already-adopted item.
* `api.updateProductRow`'s payload only includes `discount_eligible` when the caller explicitly passes `discountEligible` — a partial update (e.g. a stock-only adjustment) must never silently clear it. Any *other* field added to that function later needs the same guard, or a caller that only means to touch one field will blank out the rest.
