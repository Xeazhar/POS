# Changelog

Versions shown in the app's sidebar (`vX.Y.Z`). Source of truth is `package.json` —
bump it there and nowhere else; the UI, the bundle, and `audit_events.app_version`
all read from it.

**Currently pre-1.0: still in testing, not deployed for live trading.** While the version
starts with `0.`, the app shows an "In development / Not for live sales" marker on the login
screen and in the sidebar. Both disappear automatically at `1.0.0` — they key off the
version number, not a flag anyone has to remember to switch off. Cut `1.0.0` only when the
system is genuinely trusted to take real money.

**MAJOR** — staff need retraining, or fiscal output changes (receipt format, tax
computation, OR numbering).
**MINOR** — new capability, existing behaviour unchanged.
**PATCH** — bug fix, copy, styling.

---

## Unreleased

## 0.20.0 — 2026-08-14

### Added: Go-live checklist doc

`docs/GO_LIVE_CHECKLIST.md` — business/BIR/NPC, hosting, wipe, store setup, smoke test,
and ops reminders for before live sales.

### Added: Rearrange sidebar

Staff can drag sidebar tabs into any order (**Order** → Done, or Reset). Control sits at
the **bottom** of the sidebar (not above nav) so it is harder to misclick. Dragging shows
a floating card that follows the pointer; the list leaves a dashed placeholder where the
tab will land. Saved on this till per login (`localStorage`); permissions still decide
which tabs exist. Login landing path is unchanged.

**Branches** reorder uses the same floating-card drag (card follows pointer; dashed
placeholder in the grid). Open dashboard / Edit still click normally.

### Changed: Legal contact email

Terms, Privacy, and `LICENSE` contact address is `jazpera.bustria@gmail.com`
(`src/legal/meta.js`).

### Added: Terms and Conditions + Privacy Policy

Public `/legal/terms` and `/legal/privacy` (readable signed out or in, outside the
shift-gated Shell). Copy matches how CalePOS actually works: staff PINs, SC/PWD ID
notes, offline IndexedDB, BIR record retention, Supabase + Cloudflare processors,
RA 10173 rights. Linked from the login card and Settings → About.

### Added: Settings

Role-split Settings in the sidebar (not a Staff permission checkbox — every signed-in
role can open it). Manager/master: Business Information (`company_profile`), Tax & VAT
explainer (fixed 12%, not editable), Receipts & Invoices (read-only fiscal layout),
Session & Auto-lock (5 / 10 / 15 minutes, company-wide), Security Activity (10 per page),
Sync Status, About. Cashier/supervisor: Employee Information, Sync Status, About. Devices
stays its own `/settings/devices` module. PINs stay on Staff. No queue-wipe or local-DB
reset.

- **Auto-lock preference** — managers pick 5, 10, or 15 minutes
  (`company_profile.idle_lock_minutes`, `migrate_idle_lock_minutes.sql`). Floor 5, ceiling
  15, never off. Tills cache the last pulled value for offline use.
- **Security Activity** — 10 events per page with Previous / Next.
- **Manager/master Devices** — network table of till online/offline plus scanner / printer
  / drawer status per branch (cashier heartbeat). Enable/disable stays on the branch
  dashboard. Managers now get the `devices` module by default.

### Security hardening (audit follow-up)

- **Staff PIN reveal** — managers use `reveal_staff_pin()` RPC (`migrate_reveal_staff_pin.sql`)
  instead of a direct `staff` SELECT; supervisors no longer silently fall back when
  `branch_staff_roster()` is missing (STAFF01).
- **Turnstile** — removed `public/captcha.json`; production/staging require
  `VITE_TURNSTILE_SITEKEY` in the hosting dashboard (local dev keeps Cloudflare test key).
- **Idle lock** — clears the manager unlock PBKDF2 verifier from sessionStorage when the
  10-minute screen lock engages (stolen unlocked session must re-enter password).
- **Receipt browser print** — uses blob URL instead of `document.write`.
- **`audit_security.sql`** — smarter §4: excludes RLS helpers and trigger functions;
  flags only client-callable definer RPCs without auth patterns. **`migrate_security_definer_hardening_v1.sql`**
  adds auth to session, audit, price-change, and promo-expire RPCs.
- **Function `search_path`** — `migrate_function_search_path_v1.sql` pins
  `SET search_path = public` on nine invoker helpers/triggers that advisors flagged
  as mutable. Audit §7 reports any remaining unset paths.
- **Query/index hygiene** — `migrate_perf_fk_indexes_v1.sql` drops the duplicate
  `transactions (branch_id, client_id)` unique index and redundant product sku/barcode
  indexes, adds FK indexes on line items / audit / refunds / till actions, and wraps
  `auth.uid()` in `(select …)` on `read staff` and `read audit events`.
- **Offline OR reserve** — `migrate_offline_or_reserve.sql` adds `reserve_or_number` so
  a till-printed OR is accepted on sync without shrinking `branches.or_next`. Was missing
  from the apply order; Demo now has it.

### Fixed: browser “Save password?” on login and till credentials

Credential forms use masked `type="text"` (not `password`), honeypot decoy fields, and
read-only-until-focus so Chrome/Edge/LastPass stop offering autofill and save prompts on
login, lock screen, supervisor approval, and staff PIN entry.

### Fixed: revenue line chart Y-axis

Chart uses rounded peso ticks (₱0, ₱5k, ₱10k, …) with headroom above the peak so the
line no longer hugs the top edge on spike days.

### Fixed: revenue line chart width (supervisor → master dashboards)

`RevenueChart` now measures the full card column on first paint and on resize, so the plot
uses the wide left grid cell instead of staying at a fixed ~640px width.

### Changed: Google Sans typography + button tooltips

- App UI uses **Google Sans** (400/500/600/700) with clearer weight hierarchy: body 400,
  labels 500, controls 600, page titles 700.
- `PrimaryButton`, `SecondaryButton`, `ToggleSwitch`, and `IconButton` auto-set `title` /
  `data-tooltip` from label text or an explicit `tooltip` prop; shell icon controls updated.
- CSP `_headers` allow `fonts.googleapis.com` / `fonts.gstatic.com`.

### Security review (static)

- **Shell injection:** no server-side shell/exec in this repo; frontend is static JS only.
- **Offline lock PBKDF2** raised to **600,000** iterations (OWASP minimum); existing verifiers
  re-upgrade on successful unlock via `needsUpgrade`.
- **Webhooks:** no webhook/edge-function endpoints in the codebase — Supabase PostgREST + RPC only.
- **Raw HTML:** React has no `dangerouslySetInnerHTML`; print/PDF HTML uses `esc()` (now also
  escapes quotes). Receipt print uses blob URLs, not `document.write`.
- **Stored XSS:** user-facing strings render through React text nodes or `esc()` in print HTML;
  Turnstile `innerHTML = ''` is widget cleanup only.
- **CORS:** enforced on Supabase project settings (not in repo) — verify Dashboard → API allows
  only your deploy origins, not `*`.
- **API overfetch:** several `select('*')` paths remain in `api.js` (insert-return and internal
  row reads); UI-facing list queries mostly use column constants — tighten over time per endpoint.
- Re-run `supabase/audit_security.sql` after pending migrations for live DB posture.

### Fixed: stale cart-remove manager notification after on-site supervisor PIN

Cashier session can now resolve pending `till_action_requests` when a supervisor approves
on the till (`migrate_till_action_on_site_resolve.sql`). Inbox reconcile also matches
`approval:cart_line_remove` audit events (was looking for the wrong event type).

- **`apply_counted_cash_movement_effects`** — revoke client EXECUTE
  (`migrate_revoke_cash_movement_internal_grants.sql`); internal helper only, not a PostgREST RPC.

`Turnstile.jsx` used `useRef` without importing it after the captcha.json removal — fixed.

### Added: Branch day-end closing detail + receipt reprint

On manager Branch view (`BranchDashboard.jsx`), day-end closings are clickable and open a
read-only breakdown for that business date: expected/counted/variance, shift cash-outs, and
petty / pickups / cash-in (`DayEndClosingDetail.jsx`). Recent receipts can reprint the
existing OR from the transaction detail modal (browser print; no new OR).

### Fixed: Cashiers stay locked after manager reopens till

Staff POS / ShiftGate read `dayEnds` from `useInventoryStore`, which was not refreshed when
a manager reopened the business day from Branch view. `Shell` now listens for
`OPERATIONS_CHANGED` and refetches branch activity (`useBranchOperationsLive.js`); manager
reopen also triggers an immediate refresh on that branch. Re-login no longer paints a stale
`closed` row from IndexedDB: `loadBranch` always refetches day-end activity when online,
`syncBranch` refreshes day ends even when the outbox still has pending sales, local pending
day-end copies for dates the server already owns are dropped on merge, and
`dayEndForBusinessDate` prefers synced `reopened` over duplicate rows.

### Fixed: Drawer Activity only shows the current business day

Day End / End shift Drawer Activity was merging cash movements by shift and by requester
without a date filter, so yesterday's petty/pickups appeared on today's list. Those fetches
are now scoped to the business date.

### Changed: Supervisor Day end shows own shift panel

Supervisor+ **Day end** now opens with the same **Your shift so far** block cashiers get
(`OwnShiftSoFar.jsx`): started / on-shift duration, cash position, shift-scoped drawer
activity, and **End shift**. Branch-wide sales, accountability, and review queue stay below.

### Fixed: Cash on hand draft resets on Day end

Supervisor **Cash on hand** no longer pre-fills from a stored day-end row; the field starts
blank every visit and is not kept after navigating away (notes draft clears the same way).
Closed/submitted days still show the filed amount read-only.

### Fixed: Login welcome splash not showing

`LoginIntro` was rendered inside `Login.jsx`, but `App.jsx` switches to Shell as soon as
`user` is set — the login page unmounted before the splash appeared. Intro now runs as a
global overlay via `loginIntroUser` in the auth store (`App.jsx` → `LoginIntroGate`).
Company logo (`constants/brand.js`) shows on the **post-login welcome splash only** — not
on the staff login form (that stays generic CalePOS “C”).

### Fixed: Mobile desktop mode + stale-tab recovery

Touch devices in browser **Desktop site** mode keep mobile layout via `compact-chrome` on
`<html>` (`useCompactChrome` + Tailwind `compact:` variants on Shell/POS). A dismissible
banner explains when desktop mode is likely on. Stale PWA tabs that fail lazy route chunks
after deploy auto-attempt one `hardReload`; uncaught errors show `AppErrorBoundary` with
**Reload app** (IndexedDB / queued sales untouched).

### Fixed: Loading scheme + xlsx security

Page loads use lighter bootstrap paths where full branch activity is not needed:
`bootstrapPosCatalog` / `fetchBranchProducts` for product-only views, `bootstrapBranchInventory`
for inventory (products + movements, no transactions/day-ends). Branch dashboard initial load
parallelizes branches + catalog/activity and fans out day ops in one wave. Promo history stats
use `fetchPromoSalesStatsSummary` with `mapLimit` concurrency; Sales modal still loads detail
in the background. Overview RPC fallback uses bounded branch fan-out. Spreadsheet import/export
uses `@e965/xlsx` (patched SheetJS) via `src/lib/xlsxLoader.js` with safe parse defaults —
`npm audit` clean.

### Fixed: Promo Sales drill-down speed + offer labels

Promo **Sales** modal loads faster by querying attributed `transaction_items` directly
(instead of scanning 1000 discounted receipts then all their lines). **Offers sold** groups
sales by bundle name, Buy 1 take 1, pair, or item % — not a flat per-SKU list. History table
stats use a lightweight summary query; opening **Sales** shows cached totals immediately and
loads transactions/offers in the background. Promo line scans are date-bounded to the event window.

### Added: Login welcome intro

After a successful sign-in, a short splash shows “Welcome to POS”, company logo watermark,
“By Xeazhar”, and © All rights reserved, then continues to the staff home path
(`LoginIntro.jsx`). Session restore / refresh skips it.

---

## 0.19.0 — 2026-08-13

### Added: Private Realtime Broadcast (branch-scoped)

Security-first live updates: Postgres remains authoritative; private Broadcast notifies
terminals to refetch. Apply `migrate_realtime_broadcast_v1.sql` (+ optional
`migrate_realtime_broadcast_policies.sql`) and enable **Realtime Authorization** in the
Supabase dashboard. Topics: `pos:branch:<id>:inventory`, `pos:branch:<id>:operations`,
`pos:network:operations` (managers). Payloads are minimal (no stock qty / PINs / PII).
Cashiers lose direct `branch_inventory` writes (sales still use `record_stock_movement`).
Promo live path still uses postgres_changes until Broadcast covers rule children.

### Changed: Restaurant features archived (meat + retail focus)

Carinderia/restaurant UI is gated off via `RESTAURANT_FEATURES_ENABLED = false`
(`src/utils/features.js`). Branch type and network catalog restaurant options are hidden;
auth/branch loads coerce to retail. Code + SQL kept — restore by flipping the flag.
See `docs/archive/restaurant-features.md`.

### Security: Login / unlock / supervisor PIN — no browser credential save

Login, lock screen, and supervisor approve forms use `autoComplete="off"` /
`new-password`, non-standard field names, and password-manager ignore hints so browsers
and extensions are less likely to autofill or offer to save staff PINs/passwords.

### Fixed: POS promo tiles flash-in delay

`loadPromos` hydrates from IndexedDB cache before the network fetch so Promos category
and badges appear immediately on warm terminals.

### Fixed: Branches list load

Manager Branches paints cards from cache / `fetchBranches({ includeCompany: false })`
first, then loads Today/Orders/Low-stock KPIs via one `manager_overview_metrics` RPC
(falls back to N× `branchSummary` if the RPC is missing).

### Fixed: Revenue chart layout + label size

Branch, Overview, and supervisor Dashboard share a wide `items-stretch` chart beside
Sales / Payment / Audit; plot uses fixed pixel SVG sizing so axis labels stay readable
(compact header matches StatTiles).

### Added: Promo dual-control lock + performance UI

- **Create/edit in modal** — `PromoEditorModal` collects event fields + rules; inline create/rules panels removed from `Promos.jsx`.
- **Rules required** — submit blocked until ≥1 rule; `approve_promo_event` rejects empty-rule pending promos (`migrate_promo_edit_reapproval.sql`).
- **Freeze after approve** — live promos cannot mutate rules or details; **Request edit** clones to a pending revision (`request_promo_edit` RPC, `supersedes_event_id`); original stays live until revision approved.
- **Promo performance** — branch + manager network summary cards, sortable performance table (rule type, receipts, discount, % of sales), unchanged Sales drill-down; network view adds Branch column + discount-by-rule-type bar chart.
- **Fix:** promo editor modal no longer resets while typing (live-stats parent re-renders); bundle multi-select keeps selections across searches with visible chips; bundle requires name + 2 products.

### Added: Cash Drawer Movements (POS Open Drawer)

New `cash_movements` table (apply `migrate_cash_movements.sql`): petty cash and pickups created
**only** from POS → **Open Drawer** (supervisor PIN, Notify Manager + **60s** countdown, or
self-record with ack). Day End shows read-only **Drawer Activity** and blocks Close day until
every `self_recorded` row is Confirm/Flag reviewed. Managers Approve/Deny from the Shell bell
and Branch dashboard. Reports → **Cash Movements** for cross-session history. Legacy Day End
pickup/request create paths removed. Open Drawer UI:
type cards → **Get approval** → back **chevron** (not “Change type”) → PIN-first panel +
`ManagerWaitPanel` (`OPEN_DRAWER_WAIT_SEC = 60` in `SupervisorPinWait.jsx`).

### Added: Cart line remove — manager notify (30s)

Removing a cart line uses `CartRemoveApprove` (not plain `SupervisorApprove`): supervisor PIN,
or **Notify manager** with a **30s** wait (`CART_REMOVE_WAIT_SEC`), then self-allow with ack.
Apply `migrate_till_action_requests.sql`. Shell bell + Branch dashboard Approve/Deny stop the
cashier countdown (same pattern as cash movements).

### Removed: legacy Day End Petty cash panel

`PettyCashPanel.jsx` deleted. Day End no longer shows the legacy paid-out request/approve/
fulfill queue (creation was already disabled). Branch dashboard no longer Approve/Reject/
Mark handed over on legacy `cash_drawer_entries` paid-outs. Bell inbox no longer lists
pending legacy petty. Historical reads (`fetchPettyCash` / timeline) and expected-cash math
remain. New movements stay on POS → Open Drawer → `cash_movements`.

### Fixed: revenue chart matches supervisor style

Revenue chart restored to supervisor behavior (`preserveAspectRatio="xMidYMid meet"`,
measured box without non-uniform stretch). Manager Overview uses the same layout as
Dashboard.

### Changed: no Day end sidebar tab for managers

Managers keep `day_end` module access (cashier “request manager” close still works via
`/day-end`), but the Day end item is hidden from manager sidebar nav — day ops stay on
Branch dashboard.

### Added: manager resolve flagged cash movements

Apply `migrate_cash_movement_resolve_flagged.sql`. Accountability end-states shown as
**Approved** / **Resolved** / **Flagged**. Unauthorized → Mark Resolved or Flag.
**Flagged → Resolved** is manager-only (`resolve_flagged_cash_movement`).

### Fixed: Drawer Activity empty list

`fetchCashMovements` treated `fetchAllRows`'s `{ data, error }` as an array — mapping threw
and Day End swallowed it to “No drawer movements”. Destructure `{ data, error }` so cashier
and supervisor Drawer Activity (and Reports) actually list Open Drawer rows.

### Fixed: manager Branch Cash drawer log + unauthorized resolve

Manager Branch dashboard **Cash drawer log** now loads today’s `cash_movements` (not only
legacy `cash_drawer_entries`), shows **Unauthorized** / **Flagged** / **Resolved** /
**Approved**, and lets a manager/supervisor who is not the requester **Mark Resolved** or
**Flag**. Managers can Mark Resolved on Flagged rows after applying
`migrate_cash_movement_resolve_flagged.sql`. Totals include counting Open Drawer pickups and
paid-outs. Live reload already watched `cash_movements`.

### Fixed: supervisor PIN fields stacked

Open Drawer / cart remove / shared `SupervisorPinPanel` uses Staff code above PIN (vertical),
not side-by-side.

### Fixed: unauthorized drawer movements block Close day

Day End top banner + Confirm/Flag for `self_recorded`; Close day disabled until reviewed.
Approved / remote_approved / denied never block closing.

### Staff: supervisor drawer label, status filter, retire Admin role

Staff → Shifts no longer shows **No drawer** for supervisor floor shifts — shows that
terminal/branch drawer label (same Main drawer identity cashiers use). Staff filter row
gains **Status** (All / Active / Inactive). **Admin** removed from assignable roles;
`canAssignRole` refuses it; demo login uses master. Apply
`migrate_retire_admin_role.sql` to remap existing `admin` staff → `manager` and delete
the roles lookup row.

### Day end Accountability: drop change-fund-by-shift table; cashier shift clock detail

Supervisor **Accountability** no longer shows the per-shift float / closing / variance tracker
("Change fund by shift"). Opening float total still feeds Expected drawer; pickups stay.
Open cashier shifts keep a slim Close-shift list. Cashier **End shift** shows Started, On shift
(live duration), drawer, and period above the cash breakdown.

### Added: supervisor End shift + Received handoff before Close day

Supervisor Day end now has **End shift** (own floor shift) — must clock out before Close day,
same order as cashiers. Closed cashier shifts with no ending count show **Pending handoff**;
supervisor confirms **Received handoff** (RPC `receive_shift_handoff`, migration
`migrate_receive_shift_handoff.sql`) which fills ending/expected and clears the Staff badge
(shows **Received handoff**). Close day / Approve blocked until own shift ended, open cashier
shifts closed, and handoffs received.

### Added: network catalog bulk edit via export/re-import; branch dashboard movement history; master Inventory removed

Network catalog CSV import now **updates** matching SKUs (and cascades identity/price/Discountable
to adopted branches) instead of skipping them — export the live catalog, edit prices/fields,
re-import. Unchanged rows skip; new SKUs still create. Export button added on Manager → Data.

Manager/Master branch dashboard Inventory section has **On hand | Movement history** subtabs
(condensed movement panel). Master no longer gets the staff Inventory nav/module — use
Branches → branch dashboard instead.

### Fixed: refund on closed day quotes TILL04 (not PIN lockout); Transactions date filter defaults to today

Refunding/voiding after day-end could surface as **AUTH07** ("Too many failed PIN attempts")
because `formatSupportError` / `classifyError` treated any message containing "locked" as a
PIN lockout — including the server's "This business day is locked…". That matcher is narrowed
to real PIN lockouts, and closed-day void/refund refusals now map to **TILL04** ("no sales or
refunds until a manager reopens the till, or the next business day opens"). The client lock
check on Transactions uses the same code.

Transactions date filter now defaults to **Today** (Reset returns to Today as well).

### Fixed: false "Promo ended" banner when deleting cart lines; invoice number PENDING on online sale receipts

Removing a cart line (or dropping qty below a BOGO/bundle threshold) could strip the promo
name from a *remaining* line and fire Cart's "Promo ended — … Re-quote the total" alert even
though the promo event was still live. The notice now only appears when that event name has
left the live `promoRules` set (real expire / stop), not when cart composition alone drops
eligibility.

Online new sales were printing `Invoice No: PENDING (assigns on sync)` because
`addTransaction` returned the local optimistic row and kicked sync off in the background —
the receipt was built before `allocate_or_number` ran. Checkout now awaits the FIFO push and
reads the assigned `or_number` before returning when online; offline (or a blocked queue)
still prints PENDING as before.

---

## 0.18.0 — 2026-08-10

### Added: Card/e-wallet sales on the "Payment & cash impact" dashboards + Day End; fixed a false "Short" on Day End

"Cash impact" (Dashboard, BranchDashboard, manager Overview) is renamed "Payment & cash
impact" and now shows Card sales and E-wallet sales alongside Cash sales and Expected cash
— previously only cash was visible there, so a manager had to cross-check the separate
period-scoped "Payment methods" chart (or nothing, on the branch dashboard, which never had
one) to see how much of the day came in by card/e-wallet. Card/e-wallet sales are net of
same-tender refunds, same as Cash sales, so the three reconcile to the day's net sales — but
neither ever enters `expectedCash`, since a card/e-wallet payment or refund never touches the
physical drawer. Dropped the standalone "Cash refunds" tile (redundant — already folded into
Expected cash, and Sales performance already carries a general "Refunds" figure).

DayEnd.jsx's "Today's sales report" now shows the same Cash/Card/E-wallet split under "All
sales (POS)" instead of just Cash.

Also fixed: SupervisorDayEnd's "Variance vs expected" used to read the blank "Cash on hand"
field as ₱0 and immediately show a false "₱X Short" before anyone had counted the drawer. It
now shows "— Enter cash on hand to compare" until a value is typed. "Close day" was already
correctly disabled on a blank field before this fix — only the on-screen variance was
misleading, nothing could actually be submitted with an uncounted drawer.

`api.fetchBranchCashImpact()` gained `cardSales`/`ewalletSales` fields to back this;
`expectedCash` itself is unchanged.

---

## 0.17.1 — 2026-08-10

### Fixed: Top products/categories and DayEnd's sales report showing stale, mispriced data

Dashboard's "Top products"/"Top categories" and DayEnd's "Today's sales report" (+ restock
suggestions) were reading `stock_movements` instead of the actual sale — a transaction's
`itemsList` is never populated once it's loaded from the server (`BOOTSTRAP_TX_COLS` only
counts items, doesn't fetch them), so both silently fell back to the stock movement log,
priced at *today's* live product price rather than what was actually charged. Since
`stock_movements` rows are deliberately never deleted when a transaction is (debug reset
scripts leave them on purpose), an old test sale's movement row kept counting as "sold today"
indefinitely — phantom orders and revenue that didn't match the Transactions list or Reports.
Both now read `transaction_items` directly (new `fetchSoldLineItems` in `api.js`, same query
shape the network-wide manager Overview page already used correctly), using each line's
recorded `line_total`. This is a network fetch, so DayEnd shows a "reconnect to see today's
sales breakdown" notice when offline instead of silently wrong numbers — cash counting and
Submit/Close Day are unaffected and still work offline exactly as before.

---

## 0.17.0 — 2026-08-10

### Added: Remote manager approval for refunds when no supervisor is on site

A refund/void previously required a supervisor (or manager) to type their code + PIN in
person at `Transactions.jsx`. For a branch whose manager is never on site, that meant
relaying a PIN over the phone. The refund reason step now offers a checkbox — "No
supervisor available — notify manager instead" — that sends the request to the manager
instead: it shows up in the header bell and on `Manager → Branches → [branch]`'s new
"Refund requests" section from wherever the manager is, and the cashier's screen
auto-resolves once they approve or reject, with a reason shown on reject and a Cancel
option while waiting. New `refund_requests` table + `request_refund_approval` /
`approve_refund_request` / `reject_refund_request` / `cancel_refund_request` RPCs
(`migrate_refund_requests.sql`), mirroring promo dual-control. Manager-only — a supervisor
who is actually on site keeps using the existing in-person PIN flow.

---

## 0.16.0 — 2026-08-10

### Added: Sales performance, Cash impact, and Audit on the manager and supervisor dashboards

**Manager Overview, Manager → Branches → [a branch], and the supervisor home dashboard** now
each show three consistent metric groups instead of a handful of ad-hoc figures:

- **Sales performance** — Gross sales, Net sales, Discounts, Refunds, Voided sales.
- **Cash impact** — Cash sales, Cash refunds, Cash in/out, Expected cash. Always today's
  business day (a drawer is counted once a day, not summed over a week), and computed with
  the exact same formula Day End's own "Expected" figure uses, so the two can never disagree.
- **Audit** — void/refund counts and value, with a small paginated recent list (who performed
  each one, who approved it, why), linking to the existing Reports → "Void / Refund Log" for
  the full history.

The revenue-over-time chart, sales performance, cash impact and audit now sit together in one
row (chart on the left, the three metric cards stacked on the right); Top products, Top
categories and Payment methods sit in their own row below. "Revenue by branch" was removed
from Manager Overview (redundant once a network only has a couple of branches). No schema or
RPC changes — everything reads existing `transactions`, `cash_drawer_entries`, `staff_shifts`
and `sale_events` data.

---

## 0.15.0 — 2026-08-10

**Action required, once per database:** re-run `migrate_enable_realtime.sql` in the Supabase
SQL editor (adds `staff_shifts` to the realtime publication; safe to re-run).

### Fixed: Branch dashboard stopped updating after the first load

**Day-end closings, the cash drawer log, and cashier hours on a branch's dashboard page**
(`Manager → Branches → [a branch]`) were fetched once when the page opened and never again —
closing a day, logging a change fund/pickup/paid-out entry, or a cashier clocking in or out
from any terminal never reached an already-open dashboard tab, so it looked frozen until
someone manually reloaded the page. The dashboard now refreshes itself when any of those
happen, with a 5-minute fallback check even on a connection where the instant update doesn't
reach it. If you were seeing "today" figures that were actually several days old, reloading
this page once after updating should catch it up; it will keep itself current from then on.

### Changed: Staff hours now shows Today alongside the 30-day total

The Staff panel on Branch dashboard only ever showed a rolling 30-day hours total, which
climbs every day by design and can look like it's stuck or double-counting even when clock-ins
and clock-outs are correct. It now shows **Today's hours** as the main figure, with the 30-day
total still available next to it (and in each row's subtext) for a payroll-period check.

### Changed: Devices tab no longer default-visible for admin accounts

Devices (cashier-unit pairing) is a floor-terminal screen, not something an office-role account
needs by default. Removed from **admin**'s default access — can still be switched on for a
specific admin account from **Staff**, same as any other module. Manager already didn't have it
by default; master is unchanged (still sees everything, so a lone master account never risks
locking itself out — see Staff's self-edit rule).

### Changed: Branches list is now click-anywhere

The branch table on **Manager overview** had a trailing "Open" link — the whole row now
navigates to that branch's dashboard, so there's one less thing to aim for.

## 0.14.0 — 2026-08-10

### Changed: Close day now sits at the bottom of the Day end screen

The sales summary, cash-on-hand count, and **Close day** button used to sit right at the top,
reachable before scrolling past anything else. They now sit at the bottom, after the shift
accountability table and the petty cash queue — so a supervisor sees each cashier's drawer and
any pending petty cash requests before reaching the button that locks the day, not after.

### Changed: your own petty cash request approves itself when you're a supervisor or above

Requesting petty cash from **Day end** (not the cashier's own "End shift" screen) used to land
"Awaiting approval" even though the person requesting it was already someone who could approve
it — an extra click on your own request. It now approves immediately when the requester is a
supervisor, manager, admin, or master. A cashier's own request is unchanged: it still needs a
supervisor or above to approve it.

### Removed: the duplicate closings list on Day end

Day end had its own read-only "Previous day-end closings" table at the bottom, showing the
same history **Manager → Branch dashboard** already shows in more detail (with pagination and
Reopen). Removed from Day end to keep that screen focused on today; check Branch dashboard for
history.

## 0.13.0 — 2026-08-10

**Action required, once per database:** run `migrate_sync_catalog_identity_fields.sql` in the
Supabase SQL editor to catch up branches that were edited in the network catalog before this
release (their name/SKU/barcode/category may still show the old value until this runs).

### Changed: editing an item in the network Catalog page now updates every branch that stocks it

Previously, editing a product's name, SKU, barcode, category, or price on **Manager → Data**
(the shared network catalog) only changed the default a *new* branch would get when adopting
it later — a branch that had already adopted the item, and every report, kept showing the old
value. That's why an edit there looked like it silently "didn't take."

Saving an edit there now pushes it to every branch that already stocked the item, the same way
the Discountable toggle already did. **This includes price** — editing a price in the network
catalog now changes what that item sells for at every branch that carries it, and is logged to
each branch's Price Change Register just like editing the price on that branch's own Catalog
page. If you only want to change one branch's price or name without touching the others, use
that branch's own Catalog/Inventory page instead of the network catalog page.

The **category** field in the item editor is now a dropdown of the real category list instead
of free text — you can no longer accidentally save a typo'd category that neither reports nor
filters recognize.

### Fixed: today's reports could miss sales rung before ~8AM

The SC/PWD Register, Discount Report, Electronic Journal, BIR Daily Breakdown, and Tender
Summary computed "today" using the server's clock instead of Manila time. A sale rung before
roughly 8:00 AM could get filed under the previous day and silently disappear from that
morning's "today" figures. Report totals for early-morning hours may look different (correct
now) the next time you check a date range that includes them.

### Fixed: an inventory import that changed a price didn't show up in the Price Change Register

Importing a spreadsheet that updates an existing item's price changed the price but never
logged the change, so the Price Change Register and price history looked like nothing
happened. Import-driven price changes are now logged the same as any other price edit.

## 0.12.0 — 2026-08-10

### Fixed: movement history notes showing the OR number twice

A stock movement's note sometimes repeated the OR number — either as "OR OR-00000071" or,
for a voided sale's restock line, as "Void restock OR-00000071 · OR-00000071". Both now show
the OR number once.

### Added: export button on Movement history

**Inventory → Movement history** now has an Export button next to Refresh. It downloads the
currently filtered movements (whole date range, not just the page on screen) as a CSV you can
open in Excel or Sheets.

### Changed: Movement history now matches the rest of Inventory

The Movement history table (and the shorter one inside a product's detail panel) used a
lighter header than the rest of the app. Both now use the same dark header row as the
Inventory list and Catalog — no functional change, just consistent look.

## 0.11.0 — 2026-08-09

**Action required, once per database:** run `migrate_shift_close_no_supervisor_flag.sql` in
the Supabase SQL editor.

### Changed: a stuck till no longer shows a cashier who's holding it or a way to close it

Starting a shift while the drawer is still open under another cashier used to name that
cashier and offer a **Close their shift** button right there. That button always needed a
supervisor's PIN anyway, so it is now only in **Manager/Staff → Shifts** (**Close shift** on
any open row) — a cashier who is simply stuck just sees "drawer still open, ask a
supervisor," with no name and no closing tool on their screen.

### Added: closing a shift with no supervisor available, flagged for later review

Where the manager is only ever remote, a cashier can now tick **"No supervisor available"**
on End shift to close under their own count instead of waiting on a PIN that can't be entered
in person. This is flagged — it shows as **Needs review** in Manager/Staff → Shifts and in
the header bell, until a supervisor or manager taps **Acknowledge**. Use the supervisor PIN
whenever one is actually available; this is for when one genuinely is not.

## 0.10.0 — 2026-08-09

**Action required, once per database:** run `migrate_day_end_supervisor_autoclose.sql` in the
Supabase SQL editor. Until it's applied, Close day still behaves like before (submit, then a
second approve tap) — it is safe either way, just not instant until the migration runs.

### Changed: Close day closes right away — no more waiting on a separate approval

A supervisor's own **Close day** now closes the day immediately. It used to submit for
approval and then need a second "Approve & close" tap before the day actually closed — since
only a supervisor or manager ever sees this screen, that second tap was always the same
person approving their own count. One tap now does it.

### Added: Cancel closing, for managers

If a day was closed by mistake — wrong cash-on-hand, wrong note — a manager can now undo it
right from Day end with **Cancel closing** (a reason is required, and it's on the record).
This is the same reopen already available from the branch dashboard, just available where the
close happens too. A supervisor cannot undo their own close; a manager still has to.

## 0.9.0 — 2026-08-09

### Changed: a cashier can no longer close their own shift — a supervisor must verify the count

**Staff need to know this before their next shift.** Counting the drawer at End shift no
longer closes it by itself. It now asks for a supervisor's (or manager's) PIN, the same
prompt used for voids and price overrides, before the shift actually ends. The count the
cashier entered is unchanged and still theirs — the supervisor is verifying it, not
re-counting it — but the shift record now shows who signed off on the close.

Cashiers: count the drawer as before, then hand the terminal to a supervisor to enter their
PIN. The shift will not close without it.

### Changed: ending a shift now sends the cashier straight to sign out

After counting the drawer and ending a shift, the till used to immediately ask for a NEW
change fund — as if a different cashier had just walked up. That let one cashier count in
the next shift under their own already-open session, with nothing stopping the wrong name
ending up on the next float. The screen now shows the counted total and a single **Sign
out** button; nothing else on the terminal is usable until that happens. The next person
signs in as themselves before they count anything into the drawer.

## 0.8.1 — 2026-08-09

### Fixed: shifts would not open, and change funds showed as never counted

On some databases the shift update was applied but one small piece of it was missing, which
broke shift handling in two visible ways: starting a shift (or overriding an open one) failed
with a "Database needs an update" message, and where a shift did exist, its opening float and
closing count came back blank — as if nobody had counted the drawer.

**Action required, once, per database:** re-run `migrate_shift_cash_accountability.sql` in
the Supabase SQL editor. It is safe to run again and now installs the missing piece itself.
No figures were lost — the counts were recorded all along and reappear once it is applied.

The app has also been made to cope on its own: if that piece is still missing it now drops
only the AM/PM shift label and keeps every cash figure, instead of hiding the lot.

### Fixed: shifts going missing from "Change fund by shift"

Day end's **Change fund by shift** was leaving shifts out, so opening floats and closing
counts looked as if they had never been recorded. Two things were wrong with how the list
picked which shifts belonged to the day:

- Shifts were bucketed by the clock on the wall rather than by the **business day**. With
  the day opening at 7 AM, anyone who clocked in before 7 was filed under the following
  day instead of the one they actually worked.
- The cut-off times were being read in the wrong time zone — eight hours out — which hid
  the opening stretch of every trading day.

No cash figure was ever wrong; the affected shifts were simply not shown. They will appear
on the correct business day from now on, including ones already recorded.

### Fixed: a counted drawer could be closed without saving the count

On a database that has not had the shift-accountability update applied yet, ending a shift
recorded the clock-out but threw away the cash figure the cashier had just counted. The
shift then sat on **Pending handoff** permanently, because a closed shift cannot be edited
afterwards. The count is now saved. Shifts already closed this way keep showing Pending
handoff — a supervisor can correct them with **Adjust** on Manager → Shifts.

---

## 0.8.0 — 2026-08-09

### Promo events now have a description

When creating a promo, there's a new optional **Description** field to explain what it's
about ("20% off canned goods to clear shelf space before new stock arrives") — for your own
and other managers'/supervisors' reference later, not shown to customers. It can also be added
or edited afterwards from Promo History's **⋯** menu → **Edit description**, and it shows up
under the promo's name in that history list.

### Promo History: date filter, and actions tidied into one menu

- Added **From / To** date fields above Promo History to narrow the list to promos that
  started in a given range.
- The row of small text buttons (Sales, Approve, Modify, Rename, Delete, etc.) is now one
  **⋯** menu per row — same actions, less clutter.

No change to how stopping a promo works: a reason was already required when a promo is
stopped or a stop is requested, and it already shows in Promo History — that part needed no
fixing, just confirming it was there.

## 0.7.1 — 2026-08-09

**Read this one: the cash figure on your X and Z readings was wrong, and this fixes it.**

### Petty cash was counted at the wrong moment on X/Z readings

Petty cash now has three steps — someone **requests** it, a supervisor **approves** it, and
then the money is actually **handed over**. Only the last step is cash leaving the drawer.

The X and Z readings had not caught up. They were subtracting petty cash the moment it was
approved, even if the money was still sitting in the till, and after the recent change they
stopped subtracting handed-over petty cash at all. Either way, the **cash in drawer** line
and the **short/over** line on those readings could not be trusted.

Both readings now count petty cash exactly when it is handed over — the same rule the
End-shift screen and the day-end already use. The three figures agree with each other now.

**What you should do:** if you kept printed X or Z readings from testing, the cash-in-drawer
and short/over lines on them may not match what the app shows today. Reprint or re-check any
you were relying on. No sales figures changed — only the cash reconciliation lines.

### Movement history now looks like the one inside a product

Inventory → **Movement history** and the movement table inside a product's detail page are
the same stock ledger, but they were laid out as two different-looking reports. The tab now
matches the product one: light header, striped rows, and the same columns —
**Date · Product · Type · Change · Balance · By / note**.

- **Balance** (was "On hand after") is the running count and is now the bold figure in each
  row, with more room. A negative balance shows in red.
- **Change** now shows its unit, like the product table does: `+4.00 pc`, `−1.00 kg`.
- **Change** and **Balance** now sit side by side as a narrow pair — how much moved, and
  what was left — instead of being spread apart.
- **By / note** got the freed space; it is the only column holding a sentence.
- Refresh is now an icon, so the filter row is less crowded.

### The stock list scrolls with the page

The Inventory stock table no longer scrolls inside its own box. It was a scrollbar within a
scrollbar — the page had one and the table had another — which hid the page buttons at the
bottom of the table and meant a flick of the wheel moved whichever one your pointer happened
to be over. Now there is one scrollbar: the page's.

### Sales in movement history now show the OR number

A sale line used to end with a long internal code like `349b128c-ea8a-4ae7-…`. That was the
system's own id for the sale — you could not look anything up with it. It now shows the
**OR number** instead, so you can find the receipt in Transactions. Codes that mean nothing
to a person (bulk-import batch ids) are simply not shown any more.

You can also search this tab by OR number now.

The tab still shows the **time** as well as the date. It lists every product at once, so two
movements on the same day have to be tellable apart.

---

## 0.7.0 — 2026-08-09

**Cashiers need telling about one change: signing out no longer asks about your shift.**
Everything else here is layout, clearer labels, and a new history screen.

### Signing out is now just signing out

The "Leaving the till?" question is gone. Sign out signs you out — nothing else.

Your shift stays open regardless. It already survived a sign-out, a closed tab, a refresh
and a flat battery; signing back in on the same till picks up where you left off and does
not ask you to count the change fund again. So the question only ever had one safe answer,
and being asked it every single time taught people to tap through a box that occasionally
offered to close their shift by mistake.

**A shift now ends in exactly two ways:** you end it yourself from **End shift**, or the
day-end / Z-reading closes the business day.

The separate **Cash out** button in the sidebar is also gone — **End shift** is the one
place a drawer gets counted and closed, and it shows your float, expected cash and variance
while you do it.

### Change fund by shift is readable now

The old line — `Sup — main · open now — ₱0.00 ₱0.00` — made a supervisor decode a name, a
drawer, a state and two unlabelled amounts out of one string. It is a proper table now:
**Cashier · Drawer/terminal · Shift status · Opening float · Closing cash · Variance**.

A shift that ended **without the drawer being counted** now shows **Pending handoff** in
amber instead of looking exactly like a clean close. That is the row worth chasing. Open
shifts show a dash for variance rather than ₱0.00, which read as "balanced".

### Promo history tells you *why* a promo ended

Three statuses, never mixed up:

- **Active** — selling now
- **Stopped** — a manager ended it early
- **Expired** — it ran to its own end date

Previously both endings were recorded as "stopped", so "we pulled that promo" and "that
promo finished normally" were indistinguishable in the history. Existing promos are
relabelled automatically where it can be worked out safely.

### New: Inventory → Movement history

A second tab on Inventory showing every stock movement in order: what product, how much,
what kind (restock, sale, adjustment, waste/shrinkage, price change), **who did it**, and
when. Filter by product, by movement type, by date range, with Today / This week / This
month shortcuts.

### Staff page is now two tabs

**Staff** (everyone at the branch) and **Shifts** (the shift log), with one shared branch
and date filter across both.

**Supervisors could previously only see themselves in the staff list.** They now see their
whole branch. They still cannot see anyone's PIN, and still cannot create or edit accounts.

### Also

- New **Refunded today** card on the branch dashboard. The old figure was **wrong** — it
  ignored fully voided sales, so the more completely a sale was refunded, the less it
  counted. Fixed.
- Supervisor catalog: the search box sits on the filter row with the other filters.
- The login screen no longer claims "Connected to Supabase" when it has not checked. It now
  says nothing when things are fine, and warns you when the terminal is genuinely offline
  (PIN sign-in still works then).
- Search boxes across the app line up with the dropdowns next to them.

### For whoever applies the database changes

Run in the Supabase SQL editor **before deploying**. All are safe to re-run.

1. `migrate_branch_staff_roster.sql` — lets supervisors see their branch's roster **without
   exposing PINs**. (The staff table stores PINs in plaintext, so this is a narrow
   read-only function, not a widened table permission. Do not "simplify" it into an RLS
   policy change.)
2. `migrate_promo_expired_status.sql` — adds the `expired` status and relabels history.

### Environment separation — action required

**Local development and the live site have been sharing one database**, which means test
data has been landing in real fiscal records. Production sales are immutable and OR numbers
are sequential, so a test sale from a laptop consumes a real OR number permanently.

Create a second Supabase project for development and point `.env.local` at it; leave the
deployed app's hosting variables on the production project. Full instructions in
`pos-frontend/README.md` → *Environments*.

Any build not marked as production now shows a permanent badge (e.g.
`DEVELOPMENT · calepos-dev`) on the login screen and in the top bar, naming the actual
database it is writing to. An unset setting counts as development, never production.

---

## 0.6.0 — 2026-08-09

**Staff need a briefing before this goes on the floor.** Day end is now two different
screens, Shifts and Staff are one tab, petty cash has an extra step, and the TIN printed on
receipts changes. Nothing here is a small tweak.

### ⚠️ What prints on a receipt has changed

**Every sale rung up on the POS has been printing `TIN: —`.** Not the wrong TIN — a blank
one, along with a blank BIR permit number, blank machine ID and blank serial number. The
receipt printed at the counter was built without the branch's registered details. Reprints
from the Transactions screen were correct; only the receipt handed to the customer at the
time of sale was affected. Every receipt printed from now on carries the full details.

**One company TIN, one branch code per branch.** Before, each branch held its own free-text
TIN and they could quietly drift apart. Now the business has a single TIN, set once under
**Manager → Branches → Company details**, and each branch has a BIR branch code
(`00000` for head office, `00001` for the first branch, and so on). The receipt prints them
joined: `123-456-789-00001`. **Set the company TIN before trading**, or receipts fall back
to whatever that branch's old TIN field held.

### Day end is now two screens

**Cashiers see "End shift".** Their own opening float, their own expected cash, their own
count and their own variance — nothing else. No other cashier's drawer, no branch sales
totals, no restock list, and no "Submit for closing".

**Supervisors and above keep "Day end".** Branch sales, every shift's accountability side
by side, the restock list, the petty cash approval queue, and "Submit for closing".

**A cashier could previously see other staff members' change fund amounts**, including a
supervisor's, on the shared Day end screen. They can't any more.

### Petty cash now has three steps, not two

1. **Request** — any cashier. No money has moved.
2. **Approve** — supervisor or above. Still no money has moved.
3. **Handed over** — whoever is on the floor, including the cashier who asked, presses
   "Mark handed over" when the cash physically leaves the drawer.

**This changes the expected drawer figure.** Previously "approved" was treated as "paid",
so cash still sitting in the till was deducted and the drawer read short until someone
actually took the money. Now only cash marked as handed over is deducted. If a request is
approved but not yet handed over, Day end says so and leaves the money in the drawer.

A request can never be marked as handed over unless it has an approval recorded against it.

### Shifts and Staff are one tab

The **Staff** tab now lists each person once with their role, hours worked, shift count and
net variance for the chosen date range. Open a person's row to see their individual shifts —
drawer, float in, counted, expected, variance, and any corrections. Supervisors see their
own branch's roster and drawer detail; creating accounts, changing roles and revealing PINs
stay manager-only, exactly as before.

### Approvals now record who approved them

Voids, refunds, price overrides, cart-line removals and second-drawer overrides all record
the **name and role** of the supervisor or manager who approved them — not just that an
approval happened. It shows on the transaction detail, in the refund history, on the manager's
Recent receipts list, and in the Void/Refund Log report.

### Fixes

- **"Already signed in on another device" when you aren't.** If a device is switched off,
  loses power, or the browser is force-closed, the account stayed locked for up to 15 minutes
  with no way to clear it. A master account can now open **Staff → Signed-in devices** and
  sign out one person or everyone. Sessions no device is really holding are marked "Expired"
  so you can tell them from a live till.
- **Creating a staff login failed with a captcha error.** It now shows the same security
  check the login screen uses.
- **Refunded receipts read as if the refund was about to come off twice.** A refunded sale
  now shows the original total and the refunded amount as two clearly labelled figures.
- **"Partial"** is now **"Partial Refund"** everywhere.
- **A day-end closing can no longer be reopened once a new business day has started.** The
  current day can still be reopened by a manager; passed days are permanently locked. No
  role can override this.
- The search bar on the catalog (and everywhere else) was rendering at an unreadably small
  size. Fixed.
- Tables with edit/void/refund buttons now have an **Action** column heading.

### Also

- **Inventory**: managers and masters can pick which branch's stock to view. Other branches
  are view-only — change stock and prices from that branch's own Inventory page.
- **Branch view**: new Staff table showing who worked there and their clock-in/out hours
  over the last 30 days.
- **Catalog bulk edit** now covers name, SKU, barcode and category as well as price and
  discountable, in one cleaner editor. Row actions moved into a **⋯** menu, and the sync
  button moved next to the other catalog tools and now says what it does.
- **Lock** and **Refresh** moved to the top bar, where they are reachable on any screen size.

### For whoever applies the database changes

Run these in the Supabase SQL editor, in this order, **before deploying**:

1. `migrate_company_tin.sql` — company TIN + per-branch BIR branch code.
2. `migrate_petty_cash_fulfilment.sql` — the `fulfilled` state. **This one also rewrites
   `close_staff_shift()` and `shift_cash_summary()`.** Without it, every cash-out after
   deploy reports a false variance.
3. `migrate_admin_session_release.sql` — master force sign-out.

All three are safe to re-run. Until they are applied the app falls back to the old
behaviour rather than failing.

---

## 0.5.0 — 2026-08-09

**The change fund is now counted once per shift, not once per sign-in.** If a cashier signs
out by accident and signs back in, the app no longer asks them to count the drawer again.

### What staff need to know

**Signing out and ending a shift are now two different things.**

- **Sign out, keep shift open** — for a break, or an accidental sign-out. The change fund,
  the sales and the drawer stay on the same shift. Signing back in on the same till carries
  straight on. Nothing is counted again.
- **Cash out & end shift** — the actual handover. Count everything in the drawer, enter it,
  and the shift closes. Only then is the next cashier asked to count in.

There is a new **Cash out** button in the sidebar so a handover does not require signing out
first.

**Each cashier now counts their own change fund.** Two cashiers working the same till on the
same day get their own starting count, their own sales and their own variance. A shortage is
now attributable to the shift it happened on instead of being averaged over the whole day.

**One cashier per drawer at a time.** If the previous cashier has not cashed out, the next
one is stopped with their name on screen. A supervisor can count that drawer and close their
shift to release it — that count is recorded against the person who left, not the one
arriving.

**Handover pre-fills, it does not auto-accept.** When the previous shift cashed out with
₱4,500, the new cashier sees ₱4,500 already filled in and a tick box saying they counted it.
Typing a different figure is allowed and is flagged on screen — their count is what counts.

**Moving to a different drawer is blocked, not silently allowed.** A cashier still open on
another drawer is told so, because the cash they are answerable for is over there. A
supervisor can override if they really are working two tills.

**If your branch has one cash box, nothing here needs setting up** — every device already
counts as the same drawer, which is what makes the rule above work across a phone and a
counter PC. Only a till with its own separate cash box needs its own name, under
**Settings → Devices → This terminal's drawer**.

### For supervisors and managers

- **Shifts** (was "Staff shifts") now shows change fund in, cash counted, expected and
  variance for every shift, with cash sales / refunds / paid-outs / pickups when you open a
  row. Short and over counts are totalled at the top.
- **Closed shift figures cannot be edited.** Correcting one records an adjustment — old
  value, new value, your name and a written reason — and the original stays readable. Same
  principle as sales records, for the same BIR reason.
- **Day end** now lists the change fund per shift instead of one figure for the day, and cash
  pickups and petty cash are charged to whichever shift holds the drawer.

### Database — apply before deploying

Run `supabase/migrate_shift_cash_accountability.sql` in the Supabase SQL editor.

**Apply it outside trading hours if you can.** It requires one open shift per till, and the
old system allowed several — so anyone still clocked in, other than the most recently
started person at each branch, is clocked out by the migration with a note explaining why.
Have staff cash out normally first and this does nothing.

### Fixed

- **The Transactions table headers did not line up with the columns underneath them.** The
  header row was not laid out as a grid at all, so the labels ran together and sat over the
  wrong data. Headers and rows now share one column definition, and the Promo column — which
  had the widest column in the table for a short name — has been narrowed so Total and
  Status are no longer squeezed at the right edge.

---

## 0.4.1 — 2026-08-09

Follow-up fixes to 0.4.0.

### URGENT — if you applied `migrate_role_assignment_ceiling.sql`, re-run it now

**The version in 0.4.0 stopped cashiers and supervisors signing in**, with the error
"a cashier cannot assign the cashier role". Signing in updates your own staff record (it
stamps a session heartbeat), and the check wrongly treated that as an attempt to give
yourself your own role.

If tills are locked out and you cannot run the migration immediately, this restores sign-in
straight away:

```sql
drop trigger if exists staff_role_ceiling on public.staff;
```

Then apply the corrected `migrate_role_assignment_ceiling.sql` when you can. **After
running it, sign in as a cashier before you walk away** — the file now says so at the end,
and the check itself now ignores any change that does not touch role, access, branch or
active status, so a normal login cannot trip it again.

Two further corrections in the same file:

- **It blocked ordinary self-edits.** Changing your own display name was rejected for the
  same reason. Only role, access, branch and active status are protected now.
- **It let a deactivated account through.** Someone switched off but still holding an open
  browser session skipped the checks until their session expired — the very case the
  control exists for. Those are now refused.

### Fixed

- **Void / Refund Log and Login & Audit Trail only ever showed the most recent 500
  entries**, no matter what date range you picked, with nothing saying so. They now cover
  the whole range. **Re-run either report if you used it to investigate something.**
- **The Inventory and Price Listing reports stopped at 1000 products.** A branch with more
  than that was missing items from the price list and had valuation totals — including the
  new negative-stock count — calculated from an incomplete set.
- **The "Today" figure on the manager dashboard could include part of yesterday.** The
  day boundary was computed in UTC rather than local time, so before 8am it started on the
  wrong day. The headline Revenue and Orders figures were also capped at 1000 sales per
  branch and now read everything.
- The Revenue figure and the new up/down percentage beside it were coming from two
  different calculations, so the arrow could describe a slightly different number than the
  one shown. Both now come from the same source.
- The Senior Citizen / PWD Register was **listing voided sales**, and counting them in the
  "no ID number recorded" warning. Voided sales never happened, so including them in the
  register risked claiming a deduction for a cancelled sale. The register is now completed
  sales only, and carries a TOTAL row.
- **"Re-sync discountable to branches" could change items it should not have.** It matched
  branch products by SKU when they had no catalog link, so an item a branch had
  deliberately marked not discountable could be switched on by a coincidental SKU match —
  changing what a customer pays. It now only touches products genuinely linked to the
  catalog, and tells you how many were left alone.
- Six error codes staff could see on screen (`IMP01`, `IMP02`, `PETTY01`, `PETTY02`,
  `PRICE01`, `SHIFT01`) had no entry in the support guide. They do now, and the check that
  was supposed to catch this has been fixed — it was only looking for codes it already knew
  about.
- **A failed petty-cash, import or price-override could show the "the customer may be
  charged twice" warning** even though no sale was involved. That warning now only appears
  for failures that genuinely touched a sale.
- Import now refuses oversized or wrong-type files with a message instead of freezing the
  till while it tries to read them.

### Changed

- **Transactions list now has its own Promo and Discount columns.** They used to be
  squeezed underneath the OR number, which crammed three unrelated things into one cell and
  cut off the promo name. A sale with no promo shows a dash, so you can tell "no promo"
  apart from "not loaded". On phones the columns collapse back under the OR number as
  before.
- The app no longer reloads itself on the login screen while someone is part-way through
  typing a PIN, and waits for the new version to finish downloading before switching to it.

## 0.4.0 — 2026-08-08

### You must run two database updates for this release

Apply both in the Supabase SQL editor, in this order:

1. **`migrate_harden_grants.sql`** — closes a hole where the PIN lockout could be switched
   off by whoever was guessing. Until this is applied, the "5 wrong PINs and you're locked
   out for 15 minutes" protection can be bypassed, which matters because supervisor
   approvals for voids and price changes sit behind that PIN.
2. **`migrate_role_assignment_ceiling.sql`** — see "Who can create staff" below.

### Who can create staff has changed — read this before your next shift

Previously anyone who could open Manager → Staff could create an account at **any** level,
including Master, and could edit **their own** account. That meant a manager login, if it
ever fell into the wrong hands, could quietly promote itself to full owner access, and
nothing in the records would show it had happened.

From this release:

- You can only create or assign roles **below your own**. A manager can create supervisors
  and cashiers, but not another manager. Only Master can create Master.
- **Nobody can edit their own account** — not their role, module access, branch, or active
  status. Someone above you has to make that change. Your row shows "Your account" instead
  of an Edit button.
- Accounts at or above your level show "Locked".
- Every staff creation and change is now written to the audit trail, including what the
  role and access **were before** the change. Reveal PIN is also restricted to accounts you
  are allowed to edit.

This is enforced by the database, not just the screen, so it holds even if someone works
around the app.

### Cashiers now default to POS, Transactions and Day end only

A cashier's default access was POS, Transactions, Day end, **plus Dashboard, Inventory and
Devices**. That meant every cashier could see branch revenue and edit stock levels as a
matter of course — not because anyone decided to grant it, but because it was the default.

New cashiers now get **POS, Transactions and Day end**. Anyone who genuinely needs more is
given it per-person, and the Staff page tags that as "Elevated" so the exception stays
visible.

**Existing cashiers are not changed by this.** Anyone whose access was saved explicitly
keeps exactly what they have — but they will now show as **Elevated** on the Staff page,
because they hold more than the new default. That tag is telling you the truth. Open each
cashier, press **Reset**, and save if you want them on the new, narrower default.

### "Custom access" tag on staff was misleading — fixed

Setting a cashier to only the modules they actually use (say POS, Transactions and Day end)
was tagged **"Custom access"** in an amber warning colour, exactly the same as giving a
cashier something they shouldn't have. It looked like a problem when it wasn't.

Now there are three states, and only the last is a warning:

- **Role defaults** — matches the role.
- **Scoped · N fewer** — narrower than the role. Normal, shown in plain grey.
- **Elevated · +N** — has access **beyond** the role. Amber, because this is the one worth
  a second look.

Hover any of them to see exactly which modules differ. When editing someone, modules beyond
their role are highlighted as you tick them, and there is a **Reset to role defaults** link.

### New reports

Nine additions, mostly things accounting or BIR will actually ask for:

- **Senior Citizen / PWD Register** — the statutory record that substantiates the 20%
  discount as a tax deduction. **BIR will disallow the deduction for any sale with no ID
  number recorded**, so the report counts those for you and says how many. If that number
  isn't zero, staff are not capturing the ID at checkout.
- **Electronic Journal (EJ)** — the full chronological record of every transaction,
  **including voids**, which BIR can require on demand.
- **Discount Report (all types)** — every discount given, with promo and statutory
  discounts shown as separate columns.
- **Tender / Payment Summary** — what to reconcile the drawer and card settlements against.
- **Gross Margin (COGS)** — revenue less cost per product. A management report, not an
  audited one: it uses each product's *current* cost, not the cost on the day it sold.
- **Stock Movement Ledger** and **Price Change Register** — every stock and price change,
  with who made it.

**BIR Sales Summary now shows the full VAT breakdown** — VATable sales, VAT, VAT-exempt,
zero-rated and SC/PWD discount, each in its own column, plus a TOTAL row. A return needs
these stated separately; one combined "sales" figure cannot be split back apart afterwards.

### Price Listing is now an actual price list

It was showing stock on hand, unit **cost**, extended totals and a Low/OK status, because
it was quietly running the same query as the Inventory report. Two problems with that:

- It put your **cost and margin** on a document you might print for the shelf or hand to
  someone asking about prices.
- The total columns **went negative**, which is what you spotted. They were price ×
  quantity on hand, so any product sitting at negative stock produced a negative total.

Price Listing now shows product code, barcode, name, SKU, category, unit (per kg / per
piece), selling price and whether it is discountable. No stock, no cost — safe to print.

Negative stock has moved to where it belongs: the **Inventory** report now flags those rows
as **"NEGATIVE — recount"** and says how many there are, because it means the POS sold more
than the system thought existed, and the valuation totals below it are wrong until you
recount.

### Manager Overview dashboard

- **Revenue and Orders now show the change against the previous period** — up or down, with
  a percentage. The comparison always matches the period you picked: Day against yesterday,
  Week against the previous 7 days, and so on. A shop with no earlier data shows "New"
  rather than an invented percentage.
- **Payment methods is now a bar chart instead of a pie**, matching Top products and Top
  categories, with each method's share of the total. Bars are much easier to compare than
  pie slices. Methods you never take are no longer listed as permanent empty rows.
- **Revenue over time now has hover tooltips** — hover or tap any point for the full date,
  exact revenue, and **how many orders** made it up. ₱8,400 from 4 orders and ₱8,400 from 90
  are very different days.
- **"Revenue by branch" is hidden when you only have one branch** (it was a single bar
  repeating the number above it). The remaining panels widen to fill the space.
- "Menu items on today" is a restaurant feature and is no longer shown.

### Fixed

- **Reports covering a busy period were silently short.** Any report over more than about
  1000 sale lines stopped at that point and still printed a total, with no error and no
  sign anything was missing. Long date ranges now read every record. **If you filed
  anything from a wide date range, re-run it and check the figure.**
- **The manager dashboard had the same problem on the Year view** — revenue, the branch
  split and the payment mix all silently stopped after 1000 sales. Now reads everything.
- The BIR Sales Summary over a long range was fetching one day at a time; a full year now
  loads in one pass instead of hundreds.
- The promo status tag on the all-branches list was stretching across its whole column
  instead of sizing to its text.

### Error messages now tell you whether the money went through

When something fails at the till, the message says outright whether the sale was recorded —
"The sale was NOT recorded, ring it up again", "The sale IS saved on this device, do not
ring it up again", or "Check Transactions for the OR number BEFORE ringing it again". That
last one prevents the worst case: charging a customer twice for one basket.

There is also a new support guide at `docs/ERROR_CODES.md` covering all 46 codes — what
each one means, whether it is safe to retry, and the first thing to try. Read the code off
the screen, look it up there. Several codes staff could already see on screen (`CAT01`–
`CAT06`, `DEV05`) previously had no entry anywhere, so quoting them told support nothing.

### The app now keeps itself up to date

Terminals sitting on the **login screen** — overnight, or between shifts — never checked for
new versions, so a shop that left the browser open could start every morning on an old
build. They now check and update themselves while signed out, which is the safest possible
moment. When an update is found, the new version is downloaded **before** the reload, so a
terminal on unreliable shop wifi can't get stranded halfway.

### Changed

- **Bulk edit in the network catalog** is tidier: Discountable and Prices are now one
  grouped control instead of two loose buttons, and once you are in bulk mode the selected
  count is shown large and unmissable, with **Select all** (across everything matching your
  current filters, not just the visible page) and **Clear**.
- Consistent colours across every screen. All the greys, borders and status colours now
  come from one defined set rather than being written by hand per screen, so the app looks
  the same everywhere. No behaviour change.
- "Reset to role defaults" on the Staff form is now just **Reset**.

## 0.3.1 — 2026-08-08

### Fixed

- **"Discountable" showing Yes in the catalog but refused at the till, again.** The previous
  repair reconnected products to their catalog entries but never copied the setting itself
  down, so anything switched on before that fix stayed out of step. Run
  `migrate_sync_discount_eligible.sql` once to reconcile every item. There is now also a
  **Re-sync discountable to branches** button on Manager → Data so this never needs a
  database console again.

### Changed

- **Selection boxes only appear when you ask for them.** Manager → Data now has *Bulk edit:
  Discountable / Prices* beside the filters. Pick one and the tick-boxes appear; press Done
  and the table goes back to normal.
- **Bulk price editing.** Tick the products, press Edit prices, and set each one
  individually in a single table, then save. Only changed rows are written.
- More catalog filters: **Discountable** (all / only / not) and, for retail,
  **Barcode** (all / has / missing) for spotting items that cannot be scanned.

---

## 0.3.0 — 2026-08-08

### Added

- **Reports can now cover all records, not just a date range.** New Range buttons —
  Today, Last 7 days, This month, **All records** — sit above the From/To dates. "All
  records" runs from the branch's very first sale up to today, so you can export a
  complete history without knowing when trading started. Typing your own dates still
  works and switches the range back to Custom.
- X-Read and Z-Read deliberately refuse "All records": each is a reading for one trading
  period (a Z-Read *is* the end-of-day reset), so an all-time version would be a number
  nobody should file. Use a date range for those.

---

## 0.2.1 — 2026-08-08

### Changed

- **Pages no longer blank out when you change a filter.** Switching the period on the
  manager Overview or a Branch dashboard used to replace the whole screen with grey
  loading boxes even though the previous numbers were still on screen. The figures now
  stay put and a small "Updating…" marks them as refreshing.
- **Faster page loads.** The spreadsheet library (~410KB — the largest single download in
  the app) no longer loads with Manager Data, Reports, or Inventory. It is fetched only
  when you actually pick a file to import or export one.
- **Recent receipts is tidier.** Discount and VAT-exempt markers were stacking under the
  receipt number and making every discounted row three lines tall. They are now small
  inline tags, and the status chip is sized to its text instead of floating in an
  oversized pill. Full detail is still one click away in the receipt.

---

## 0.2.0 — 2026-08-08

### Fixed — critical

- **Sync queue could stall permanently.** One op that could never be pushed blocked every
  sale queued behind it from ever reaching the server, silently, while the branch kept
  selling. Failing ops are now quarantined after 5 attempts, the queue drains past them,
  and a non-dismissible banner reports it (support code `SYNC09`).
- **Duplicate sales were possible** when two syncs of the same queued sale overlapped —
  doubled revenue, two OR numbers, doubled stock decrement. Now prevented by a database
  constraint (`migrate_sale_dedupe_hardening.sql`).
- **Products past the 1000th were invisible to POS.** Reads were silently truncated, so
  affected items couldn't be sold correctly and PWD/Senior refused them even when marked
  discountable. All product/catalog reads now page.
- **"Discountable" didn't reach the till** for imported and supervisor-created products.
  Fixed, plus a migration that heals existing rows.

### Fixed — security

- Offline lock-screen password verifier hardened (PBKDF2, 210k iterations, per-device
  salt) and failed attempts now throttle with a backoff that survives a reload.

### Added

- **BIR VAT and SC/PWD engine (RA 9994 / RA 10754).** One discount computed on a
  VAT-exclusive base; promos lower that base rather than stacking. **Changes what
  customers pay**: a ₱112 item with a 10% promo plus PWD is now ₱72.00 — the previous
  behaviour overcharged. Checkout shows a full per-line breakdown and BIR totals.
- **Multiple concurrent promos** per branch, best discount per line, never stacked.
  Auto-expiry on the end date, editable name and schedule, multi-select product picker.
- **Live updates** — manager price/promo/discount edits reach an open POS immediately.
- **Update banner** when a new version is deployed under an open tab.
- **Version display** in the sidebar.

### Changed

- Checkout is now two columns; long breakdowns no longer scroll under the buttons.
- Promo date fields were showing and saving times 8 hours off (UTC vs local).

---

## 0.1.0

First working build.
