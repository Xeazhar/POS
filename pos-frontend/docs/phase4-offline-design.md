# Phase 4 — Desktop Offline Capability: Architecture Proposal

> **Status: DRAFT — pending review/approval. Not implemented. Nothing in this
> document has been built yet; it is the audit + design requested before any
> Phase 4 code is written.** Once approved, this becomes the spec an
> implementation plan (`superpowers:writing-plans`) is written against, and the
> approved pieces get folded into `CODEMAP.md` as they ship.

Scope: **Windows Desktop (Electron) only.** The web/PWA path is untouched —
per `CLAUDE.md` it stays online-first, and Android offline is a later,
separate effort that should reuse whatever this proposal builds (Dexie code
is portable to Capacitor's WebView, same as it is to Electron's Chromium).

---

## 0. Headline finding

**Revision note (post-review):** the brief's "offline" originally read as
"survives a dropped connection for a while." The actual requirement,
confirmed on review, is stronger: **sync once, then operate correctly with
zero network access forever — a branch may genuinely never reconnect
again.** That's a materially different bar than the first draft of this
document assumed, and it changes two things below from "already solved" to
"real new work": offline authentication must never force a re-online
requirement (Part 3), and **invoice numbers can no longer be assigned by
the server at sync time — they must be assigned locally, permanently,
authoritatively, at the moment of sale** (Part 6, rewritten). Both are
called out inline below; this section summarizes them up front.

The premise of "Phase 4 adds offline capability" still undersells the
current state for everything *except* those two things.
**`src/offline/*` already implements a production-grade offline-first
architecture** — durable outbox queue with FIFO ordering, exponential
backoff, quarantine, idempotent server-side upserts on `client_id`, offline
shift open/close, offline cash-drawer self-record, offline day-end submit,
offline supervisor-PIN approval via PBKDF2, offline lock-screen unlock.
Parts 5, 7–10 below are **already built and already reused for Desktop for
free**, because Electron's renderer is Chromium and Dexie/IndexedDB works
there identically to the browser.

The genuine new work, now that "forever" is literal, is:

1. **Part 3 — offline authentication with no expiry backstop.** No
   verifier may ever force an online reauthentication — the existing
   30-day `VERIFIER_MAX_AGE_MS` lockout (already live today for manager
   lock-screen unlock, `auth.js:393-396`) is now a bug relative to the
   real requirement, not a safe default, and needs removing.
2. **Part 6 — locally-authoritative, permanently sequential invoice
   numbering.** The existing design (server assigns the real invoice
   number when the sale eventually syncs) assumes "eventually" always
   arrives. It doesn't anymore. This is the single biggest architectural
   change in this revision, and it's a fiscal-compliance question
   (BIR sequential numbering) as much as an engineering one — see Part 6
   and the new Part 6.1 risk discussion.
3. **Part 11 — local backup/export stops being optional.** A till that
   may never sync again has **no off-device copy of its sales history,
   ever**, unless something exports one. That elevates the "future USB
   workflow" from nice-to-have to the only disaster-recovery mechanism
   this design has. Flagged as a recommendation, not built here — see
   Part 11 and Part 15.

Everything else in this document remains an audit confirming what's
reusable, unchanged by this revision.

---

## 1. Audit of existing offline architecture

| Component | What it does today | Production-safe? | Reusable for Desktop? | Missing | Replace? |
|---|---|---|---|---|---|
| `src/offline/db.js` — Dexie schema | `products`, `transactions`, `transactionItems`, `movements`, `dayEnds`, `categories`, `branchMeta`, `syncQueue`, `deviceSettings`, `shifts` (v2), `cashMovements` (v3), `supervisorVerifiers` + `offlineAuditEvents` (v4) | Yes — versioned Dexie migrations, in real use today | Yes, unchanged | A `staffVerifiers`/roster table for **all** staff, not just supervisors (see Part 3/4) | No — add a version, don't replace |
| `syncQueue.js` — durable FIFO outbox | `enqueue`/`listPending`/`markDone`/`markFailed` with `MAX_SYNC_ATTEMPTS=5`, exponential backoff (`2s→5s→15s→30s→60s`), `BLOCKED` quarantine that never auto-deletes | Yes | Yes | Nothing structural | No |
| `syncEngine.js` — push/pull | `pushQueue` (FIFO, stops on first non-quarantined failure to preserve order), `pullFromRemote` (never clobbers local stock while stock-affecting ops are pending), `syncBranch` orchestration, session-heartbeat-before-push guard | Yes — this is the most carefully-reasoned file in the codebase (see its own comments on `requireShiftServerId`/`requireTransactionServerId`) | Yes, unchanged | Nothing structural for Phase 4A–4D | No |
| `queueTypes.js` — op catalog | 19 typed ops (`COMPLETE_SALE`, `VOID_SALE`, `ADJUST_STOCK`, `SET_INVENTORY`, day-end family, shift family, cash-movement family, `LOG_APPROVAL_EVENT`), `newClientId`/`newUuidClientId`/`asUuidClientId` | Yes | Yes | No new op types needed for "normal POS + void + cash + day-end" — the catalog already covers the ask | No |
| `reachability.js` / `connectivity.js` | Distinguishes `navigator.onLine` (device has a link) from `canSyncWithBackend()` (Supabase actually answers) — the wifi-without-internet / captive-portal case. 15s reachability cache, 30s poll (paused when tab hidden, resynced on focus), debounced sync on `online` event | Yes | Yes, unchanged | Nothing | No |
| `session.js` | `saveLocalSession`/`loadLocalSession` — **one row**, `meta.sessionStaff`. `saveUnlockSecret`/`loadUnlockSecret` — **one row**, `meta.managerUnlockSecret`, keyed to whichever single `staffId` last saved it. Unlock-attempt backoff (3 free, 5s→5min) | Safe for its actual purpose (single-user lock-screen re-unlock) | **No — singleton design is the core gap.** See Part 3. | Per-staff verifier storage, multi-identity cache | **Extend**, not replace — same PBKDF2 primitive, new shape |
| `supervisorPin.js` | Per-staff `supervisorVerifiers` table (`staffId, branchId, loginCode, pinVerifier, role`), populated by `fetch_branch_supervisor_verifiers` on every sync. `verifySupervisorPinOffline()` does real per-staff PBKDF2 verification, cross-branch aware for managers | **Yes — this is the pattern to copy.** Already proves multi-staff offline verification works in this codebase | Yes, directly the template for Part 3 | Scope is supervisor-approval-only; needs to become the *primary login* mechanism for every role | Generalize, don't replace |
| `utils/unlockVerifier.js` | PBKDF2-HMAC-SHA256, 600k iterations, per-record 16-byte salt, staffId bound into the derived input, constant-time compare, v1→v2 upgrade path, 30-day `VERIFIER_MAX_AGE_MS` expiry | Yes — OWASP-minimum iteration count, no plaintext, no network dependency | Yes, unchanged | Nothing cryptographic; just needs to be the verifier for *all* roles, not only supervisors + the single lock-screen slot | No |
| `sessionLifecycle.js` | Tab/browser-close detection (`markBrowserClosed`/`consumeBrowserClosedFlag`) forces fresh login on next open; distinguishes an intentional app self-reload from a real close | Yes | Yes, unchanged — Electron's `BrowserWindow` close maps the same way if wired to the same events | Confirm Electron's window-close (not just tab pagehide) fires this — check `electron/main.js` wiring | No, verify only |
| `offlineAudit.js` | Durable local audit rows (`offlineAuditEvents`) + queued `LOG_APPROVAL_EVENT`, server-side dedup via `meta->>'offline_client_id'` (`migrate_offline_supervisor_pin.sql`) | Yes | Yes | Nothing structural | No |
| `shifts.js` | Full offline shift lifecycle keyed by device-generated `clientId` — open/close/resume all work with zero network, `serverId` stamped in once the `OPEN_SHIFT` op syncs | Yes | Yes | Nothing | No |
| `repository.js` | Local read/write helpers; `putTransactions`/`putMovements`/`putDayEnds` all preserve `syncStatus: 'pending'|'local'` rows across a remote pull so an unsynced record is never silently dropped | Yes | Yes | Nothing | No |
| Roles/permissions (`utils/roles.js`) | `effectivePermissions(user)` reads `user.permissions` (or falls back to `DEFAULTS[role]`) — this is plain data already embedded in whatever user object is cached | Yes as a *check*; the *cache* it depends on is the gap | Yes | A branch-wide staff roster cached locally (roles/permissions per staff, not just the one logged-in user) | No — extend the cache, not the check |
| Sale/void/day-end business logic (`src/lib/api.js`) | Every offline-recorded action still calls a Supabase RPC on sync (`completeSale`, `voidSale`, `submitDayEnd`, …) — the *authoritative* computation (invoice numbers, VAT, promo attribution) happens server-side at sync time, not on the device | Yes, by design — see Part 6 | Yes, unchanged | Nothing for this phase | No |

**Bottom line of the audit:** nothing needs to be replaced. Phase 4 is an
*extension* of an existing pattern (per-staff PBKDF2 verifier cached in
Dexie, proven by `supervisorPin.js`) to a case the codebase hasn't needed
yet — multiple different staff logging in as *themselves*, from cold, with
zero network, on a device that six other people also use.

---

## 2. Database strategy — Dexie vs. SQLite-over-IPC

**Recommendation: keep Dexie/IndexedDB. Do not introduce SQLite.**

| Criterion | Dexie (current) | SQLite over Electron IPC |
|---|---|---|
| Existing implementation | ~13 files, already handles every write path this app has (sales, voids, shifts, cash, day-end, audit) | Zero — full rewrite of every one of those paths |
| Reliability / crash recovery | IndexedDB transactions are ACID per-transaction (`db.transaction('rw', ...)` used throughout — see `repository.js`, `db.js`); browser-managed WAL-equivalent, survives renderer crash | ACID also, but now split across an IPC boundary — a renderer crash mid-write plus a main-process crash mid-write are two new failure modes to reason about that don't exist today |
| Transactions | Dexie's `db.transaction('rw', tableA, tableB, ...)` already used for multi-table writes (sale + movement + product stock in one commit) | Would need to reinvent this over IPC (batched statements, not a native multi-table JS transaction object) |
| Large datasets | A branch's working set is small by construction (see Part 5 — one branch's catalog + ~200 recent transactions + ~500 movements, per `readBranchSnapshot`), well within IndexedDB's comfortable range | No advantage — SQLite wins on *very* large single-table scans and complex joins, neither of which this workload does |
| Query complexity | All current queries are single-table `where(...).equals(...)` lookups or small in-memory `.filter()` passes after — no joins, no aggregates needed locally (aggregates happen server-side or in JS over an already-small result set) | SQL joins would be nice-to-have, not need-to-have, for this data shape |
| Sync engine fit | `syncEngine.js` is already written against Dexie's API end-to-end | Would need a parallel data-access layer, doubling the surface area to keep consistent with Supabase's schema |
| Electron compatibility | Zero extra work — Chromium's IndexedDB works identically to the browser build; this is *why* Electron was chosen over a bespoke native shell | Requires a native module (`better-sqlite3` or similar) rebuilt per Electron ABI version, per platform — a real native-dependency/build-tooling burden (exactly what `CLAUDE.md`'s "no unnecessary native deps" instinct warns against) |
| Future Android compatibility | Capacitor's WebView also implements IndexedDB — the same Dexie code plausibly ports with no rewrite | SQLite-over-IPC is an Electron-specific pattern; Android would need `@capacitor-community/sqlite` instead — two separate native implementations to maintain in parallel |
| Maintenance complexity | One data layer, one team (of one) already knows it | Two data layers (renderer-side Dexie remnants + main-process SQLite) unless everything is ripped out and rebuilt |

The one legitimate argument *for* SQLite — surviving IndexedDB eviction —
does not apply here: Chromium's storage-eviction policy is for
**quota-pressured, rarely-used, no-storage-permission web origins**. An
Electron app is not a web origin under quota pressure; its `userData`
profile is not subject to the same "haven't visited in a while, reclaim the
space" heuristics a normal Chrome tab is. This should be spot-checked once
(open the desktop app, leave it for a long period, confirm the Dexie DB
survives) but is not a reason to introduce a second database technology
today.

**If Dexie is ever insufficient**, the trigger would be: multi-table
relational queries this workload doesn't have today, or a working set that
stops fitting comfortably in memory (hundreds of thousands of local rows) —
neither is on the horizon for a single-branch, single-till dataset.

---

## 3. Offline authentication (the real Phase 4 work)

### 3.1 What exists today and why it's not enough

Today, `useAuthStore.login()` (`src/stores/posStore.js:60-153`) has this
offline branch:

```js
if (!isOnline() || !(await isBackendReachable())) {
  if (await needsFreshLogin()) throw appError('AUTH04')
  const cached = await loadLocalSession()
  if (cached) { /* ...log in as `cached`... */ return cached }
  throw appError('AUTH03')
}
```

Notice: **`emailOrCode` and `passwordOrPin` — whatever the cashier just
typed — are never read in this branch.** Offline "login" is actually
*session restore*: whichever single staff member was cached in
`meta.sessionStaff` at the last successful online login gets logged back
in, regardless of what credentials are entered, gated only by
`needsFreshLogin()` (set after a day-end close, cleared on next real
login).

This is fine for the case it was built for — a lone cashier's tab
surviving a dropped connection mid-shift. It is **not** multi-user offline
authentication, and it breaks the moment a *second* person needs to use
the branch computer while offline (shift changeover, a supervisor stepping
in to void something, a different cashier opening the next day before
internet returns): they type their own code and PIN, and get logged in as
whoever happened to be cached last. There's no verification, and no way to
tell two people apart.

### 3.2 Design — generalize the proven supervisor-PIN pattern to every role

`supervisorPin.js` + `utils/unlockVerifier.js` already prove the right
shape: a per-staff PBKDF2 verifier table, refreshed on every sync, checked
against fully offline with no network call. Extend it from
"supervisor-approval-only" to "primary login for every staff member
assigned to this branch."

**New Dexie table** (`db.js` version bump):

```js
db.version(5).stores({
  // One row per staff member ever seen at this branch. Superset of
  // supervisorVerifiers — role is no longer restricted to supervisor+.
  staffVerifiers: 'staffId, branchId, loginCode, role',
})
```

Populated the same way `supervisorVerifiers` is populated today — pulled
on every successful sync via a new RPC (`fetch_branch_staff_verifiers`,
same shape as the existing `fetch_branch_supervisor_verifiers`), scoped by
RLS to staff assigned to the current branch (managers/masters included,
same cross-branch-approval carve-out `canApproveAtBranch` already handles).

**Login flow change** (`posStore.js` offline branch):

```js
if (!isOnline() || !(await isBackendReachable())) {
  if (await needsFreshLogin()) throw appError('AUTH04')
  const verified = await verifyStaffCredentialOffline(branchId, emailOrCode, passwordOrPin, mode)
  // verified is looked up by loginCode (PIN mode) or by cached email→staffId
  // mapping (manager/master mode), then PBKDF2-checked against staffVerifiers —
  // exactly supervisorPin.js's verifySupervisorPinOffline(), generalized.
  useCartStore.getState().clear()
  set({ user: verified, booting: false, screenLocked: false, loginIntroUser: verified })
  await saveLocalSession(verified)   // becomes "most recently active", not "the only one"
  return verified
}
```

**Verifier provisioning** — a verifier can only be created from a
*successful online password/PIN check* (same rule `unlockVerifier.js`
already documents: never store a password, only a derived check). This
means:

- A staff member who has **never logged in online at this branch since
  the offline-auth feature shipped** cannot log in offline — there is no
  verifier for them yet. This is correct and unavoidable: the device
  cannot verify a credential it has never seen. Surface this plainly as
  "This account hasn't signed in online at this branch yet — connect once
  to enable offline sign-in," not a generic auth failure.
- Every subsequent online sign-in *refreshes* that staff member's verifier
  (new salt, current iteration count, current timestamp) — this is what
  keeps `VERIFIER_MAX_AGE_MS` (30 days) meaningful rather than a hard wall.

**Session model changes from singleton to roster:**

- `session.js`'s `SESSION_KEY` stays as "who is currently active on this
  device" (single row — a till has one operator at a time), but it is no
  longer the *only* source of truth for "who can log in here." The new
  `staffVerifiers` table is the roster; `session.js` just tracks the
  active one.
- Multiple cached staff can coexist in `staffVerifiers`; only the
  currently-active one occupies `meta.sessionStaff`.

**Preventing impersonation:** the PBKDF2 verifier is bound to `staffId` in
the derived input (`unlockVerifier.js`'s `createVerifier`) exactly like the
existing supervisor pattern — a verifier lifted from one staff row cannot
be replayed against another, and the loginCode→staffId lookup only
produces candidates whose `pinVerifier` actually matches that specific
`loginCode`. Same guarantee `findVerifierCandidates` already provides for
supervisors, now covering cashiers too.

**Verifier expiration — do NOT reuse `isVerifierExpired()`/
`VERIFIER_MAX_AGE_MS` as a hard block.** This was the first draft's
recommendation and it's wrong for the confirmed requirement: a branch that
never reconnects again must never be told to "sign in online to refresh
access," because for that branch there may be no such thing as "online"
ever again. Concretely, for the new `staffVerifiers` path:

- No expiry timestamp gates whether a verifier can be used. A verifier
  created once, offline forever after, keeps working forever.
- The only defense against a stolen device is what it always was —
  PBKDF2 cost (600k iterations) plus the unlock-attempt lockout — not a
  time limit. This is a real, accepted tradeoff: an offline credential on
  a device that never syncs again can never be revoked by anything except
  a strong-enough password/PIN and physical device security. State that
  plainly to the business owner rather than implying a 30-day backstop
  exists when it deliberately doesn't for this deployment shape.
- **This also means fixing existing code, not just writing new code
  the same way it was written before.** `verifyAccountPassword()`
  (`src/lib/api/auth.js:382-410`) already hard-blocks manager lock-screen
  unlock after `VERIFIER_MAX_AGE_MS` today, throwing "Unlock expired for
  security. Sign out and sign in with your password" — which requires
  the network. That line (`auth.js:393-396`) needs to be removed (or
  turned into a non-blocking warning, per below) as part of this phase,
  not left as pre-existing behavior, or a manager's lock-screen unlock
  will hit exactly the wall this whole revision exists to remove.
- If a "you haven't verified online in a while" signal is still wanted
  for visibility (e.g., a supervisor dashboard warning, not a login
  block), that's fine to keep as **informational only** — never gating
  the ability to log in or unlock.

**Revocation while offline is fundamentally limited, now potentially
permanently so** — covered in depth in Part 4, since it's an
authorization question, not a cryptographic one.

**Password changes:** a password/PIN change made *online* is only reflected
in `staffVerifiers` the next time that staff member's account is pulled
during a sync on *this* device — until then, the device still verifies
against the old verifier. This is the same lag every offline-cache design
has and is addressed by the revocation policy in Part 4, not by trying to
push credential changes to disconnected devices (which is topologically
impossible).

**Multiple users on one branch computer:** fully supported by the roster
model above — this is exactly the gap being closed. `session.js` tracks
only *who's active right now*; `staffVerifiers` holds everyone who's
allowed to become active.

### 3.3 What must NOT change

- Manager/master login stays real-Supabase-Auth-first; the offline branch
  is a fallback path, not a replacement, exactly as today.
- Turnstile is never touched, weakened, or bypassed for the **online**
  path — the existing `captchaActive = hasSupabase && captchaRequired &&
  !isOffline` logic in `Login.jsx` already correctly scopes CAPTCHA to
  "online only," and that's unchanged.
- No plaintext credential ever reaches IndexedDB — this proposal only
  reuses the existing PBKDF2 verifier primitive, never introduces a new
  storage format for secrets.

---

## 4. Offline authorization / permissions

### 4.1 What's cached and how

`effectivePermissions(user)` (`utils/roles.js:192`) is a pure function over
whatever `user` object is in memory — it doesn't matter whether that object
came from a live Supabase fetch or `loadLocalSession()`. **The check
already works offline.** The gap is entirely about *whose* permissions are
available to check: today, only the single last-cached user's. Part 3's
`staffVerifiers` roster needs to carry `role` (already planned) and, for
per-user permission overrides, the `permissions[]` array too — so
`fetch_branch_staff_verifiers` should return the same shape
`readStaffCache`/`writeStaffCache` (`repository.js:319-325`, already
present, used by the Staff management screen's offline view) already
caches. These two caches should likely be unified rather than duplicated —
implementation detail for the plan, not a design fork.

### 4.2 Scenario table — what happens, and what's fundamentally impossible

| Scenario | What happens offline | Fundamentally impossible? |
|---|---|---|
| Permission changed online (module added/removed) | Device keeps using the **last-synced** `permissions[]` until its next successful sync pulls the change. No live push is possible with zero network. | Not impossible to *eventually* reflect — impossible to reflect **instantly**. Policy: accept the lag; see 4.3. |
| Account disabled online | Same as above — the disable takes effect on this device only once it next syncs (or, better: is enforced by making `staffVerifiers` provisioning itself check `is_active` server-side, so a disabled account's verifier is *removed* from the next pull, not just its permissions narrowed) | Cannot force-disconnect a session with no network path to it — same limitation `CODEMAP.md`'s existing eviction section already documents for the online case ("there is no way to server-push a kill signal to a device with no network path, and that's inherent to offline-first, not a gap"). |
| Account deleted online | Same mechanism as disable — verifier removed on next pull. Until then, the device still accepts that credential. | Same as above. |
| Password/PIN changed online | Old verifier still works on this device until next sync (Part 3.2). New password immediately invalidates the *online* path (Supabase Auth), but not yet this device's offline fallback. | Same limitation, same mitigation: bound by `VERIFIER_MAX_AGE_MS` and closed by the next sync. |
| New employee added | Cannot log in offline at this branch until they've signed in online at least once (Part 3.2) — no verifier exists yet. | Yes, structurally impossible to pre-provision a verifier for a credential the device has never seen checked. Acceptable: onboard new staff while the branch has connectivity, or accept they wait for the next connectivity window. |
| Supervisor removed | Their `staffVerifiers` row (role downgrade or removal) is stale until next sync — they can still approve void/refund offline until then. | Same lag as above. |
| Branch offline forever (never reconnects again) | Every cached verifier keeps working **indefinitely** — per the confirmed requirement, there is no time-based expiry (Part 3.2). That staff member's access on this device never lapses on its own. | Not impossible to *want* time-based expiry as a security property — but confirmed out of scope here: this deployment shape accepts no-expiry as the cost of guaranteeing the till never locks itself out. |

### 4.3 Recommended policy

**No time-based backstop. Revocation happens only on the branch's next
successful sync — which, for a branch that never reconnects, may be
never.** This is a deliberate change from the first draft's "30-day bound"
recommendation, made explicit because it's a real, non-hypothetical
tradeoff:

1. Every sync (`pullFromRemote`) refreshes `staffVerifiers` from the
   server's current truth — disabled/deleted accounts drop out, changed
   roles/permissions update, exactly like `supervisorVerifiers` does today.
   This remains the *only* revocation mechanism.
2. There is no fallback expiry. A device that never syncs again keeps
   every credential it has ever cached valid forever. This is the accepted
   cost of "sync once, offline forever" — a bound would be a second,
   contradictory requirement (it would mean the branch's login stops
   working during the exact "forever offline" window this design exists
   for).
3. **State this plainly to the business owner, in these terms:** *"On a
   branch that never reconnects, a terminated employee's till access is
   never revoked by the system itself. The only recourse for that
   scenario is a physical/procedural one — disable the account server-side
   (so it's revoked the moment the till ever does sync) and, if the risk
   is serious enough, treat the device itself as compromised (e.g.
   physically reset it) rather than relying on software you've told to
   never require reconnecting."* This is not a gap to be quietly patched
   later — it is the direct, logical consequence of the requirement as
   stated, and it should be a decision made with eyes open, not a surprise
   found in an incident review.

---

## 5. Offline data / cache strategy

Using the audit table format the brief asked for, against what's *already*
cached (`readBranchSnapshot`, `bootstrapBranchData`) vs. what Part 3/4 adds:

| Data | Cache tier | Notes |
|---|---|---|
| Products (this branch's live catalog) | **A — fully cached** | Already done (`db.products`, refreshed every pull, stock preserved across pending stock ops) |
| Categories | **A — fully cached** | Already done (`db.categories`) |
| Prices | **A — fully cached** | Part of the product row |
| Inventory (stock counts) | **A — fully cached, locally authoritative while ops are pending** | `hasPendingStockOps` guard in `pullFromRemote` already prevents clobbering |
| Staff roster for this branch (id, role, permissions, PIN/password verifier) | **A — fully cached (new, Part 3/4)** | The one addition; small dataset — a branch's staff count is single digits to low tens |
| Branch configuration (name, day-open hour, invoice prefix/next) | **A — fully cached** | `db.branchMeta`, already done |
| Fiscal header (TIN, business name, etc. for receipts) | **A — fully cached** | `saveBranchFiscalHeader`, already done |
| Promos | **A — fully cached** (already, `readPromoCache`/`writePromoCache`) | Per `CODEMAP.md`, promo dual-control/expiry already has offline consideration |
| Tax/VAT configuration | **A — fully cached** | Part of branch/fiscal header |
| Payment configuration (cash, e-wallet-by-reference) | **A — fully cached, trivially** | No gateway call needed at transaction time per the brief's own framing — nothing to cache beyond "which methods are enabled," already branch config |
| Recent transactions (last ~200) + movements (last ~500) | **B — cached only as a rolling recent window** | `readBranchSnapshot` intentionally slices — this is a *working set*, not the archive; older records are online-only via full history views |
| Day-end history | **A/B — current + recent cached, deep history online-only** | `db.dayEnds`, same rolling-window logic |
| Full multi-branch network catalog / other branches' data | **C — online-only** | Out of scope for a single-branch till; no reason to duplicate the network catalog locally |
| Manager dashboards / cross-branch reports | **D — not available offline** | Correctly out of scope — these are analytical views over the whole network's data, not something a disconnected single-till device should (or could usefully) mirror |
| Full staff directory across all branches | **D — not available offline** | Only this branch's assigned staff belongs in `staffVerifiers` |

The design goal stated in the brief — *cache what the branch needs, not
the whole database* — is already the existing pattern's philosophy
(`readBranchSnapshot` is branch-scoped and window-limited by construction).
Part 3/4 doesn't change that philosophy, it just adds one more
branch-scoped, small table to the same pull.

---

## 6. Offline transactions

**Revised after review — this is no longer "already correct," it's the
single biggest piece of new work in Phase 4.** The existing design defers
the real invoice number to sync time, on the assumption that sync
eventually happens. Confirmed requirement: it might not, ever. Server-side
invoice-number assignment is therefore not viable as the *only* mechanism
— it has to be assignable, permanently, by the device itself.

### 6.1 Why this is a fiscal-compliance question, not just an engineering one

BIR's sequential-invoice-numbering requirement (the reason
`invoice_prefix`/`invoice_next`/`reserve_invoice_number` exist at all,
per `CODEMAP.md`) means the numbers a till issues must be gapless and
non-repeating within its authorized series. Today that's enforced by
having exactly one authority (the server) hand out numbers one at a time.
Moving that authority onto the device is fine **as long as there is still
exactly one authority per series** — which holds naturally for "one
computer per branch," with one sharp edge case:

- **Till replacement.** If a branch's computer is replaced (fails, is
  upgraded, whatever) and the old one never synced its final invoice
  count to the server, the new till has no way to know the last number
  issued. Starting the new till's counter from zero (or from whatever the
  server last saw, if that's stale) risks either duplicate numbers or an
  unexplained gap — both are exactly what a BIR audit flags. **This is not
  a purely technical problem** — it needs a documented manual procedure
  (e.g., the outgoing till's last-issued invoice number is read off its
  screen/receipt and entered as the new till's starting counter during
  setup, with that handoff itself logged) as much as it needs code. Flag
  this to whoever owns BIR compliance for this deployment before treating
  local invoice numbering as "solved" — this document can specify the
  software mechanism, not the accreditation/registration process around
  it.

### 6.2 Design — device-assigned, permanently authoritative invoice numbers

```
Cashier rings sale
    → clientId = newClientId('op')          (idempotency key, unchanged)
    → within ONE Dexie transaction (db.transaction('rw', db.branchMeta,
      db.transactions, ...)):
        - read branchMeta.invoiceNext for this branch
        - assign invoiceNumber = `${invoicePrefix}${invoiceNext}`
        - write the transaction row WITH that final invoiceNumber
          (not null — this is the change from today)
        - increment and write branchMeta.invoiceNext in the SAME
          transaction
    → enqueue(COMPLETE_SALE, { ...payload, clientId, invoiceNumber })
    → receipt prints the real, final invoice number immediately —
      no more "Pending · sync to see the real number"
    → IF this device ever does sync: api.completeSale() sends the
      device-assigned invoiceNumber to the server, which records it
      as-is rather than calling reserve_invoice_number to mint a new one
    → server-side uniqueness constraint on (branch_id, invoice_number)
      catches a genuine collision (e.g. the till-replacement edge case
      above) as a hard error surfaced to a human, never a silent
      overwrite of a fiscal number
```

The Dexie transaction atomicity is what makes this safe against a crash:
Dexie's `db.transaction('rw', ...)` either commits the counter increment
and the sale row together, or neither happens — there is no window where
a number is consumed but no sale row claims it, or a sale is written
without ever having incremented the counter. This is the same "make the
whole operation one atomic unit" discipline `upsertLocalSale` already
uses for the sale/movement/product write today (`repository.js:199-208`)
— this proposal extends that same transaction to include the counter.

**`client_id` idempotency (unchanged, still correct):** the counter
increment happens once, at first local commit — a *retry* of a sync push
(same `clientId` sent twice) still hits the existing
`transactions(branch_id, client_id)` unique index fast path
(`migrate_complete_sale_rpc.sql:133-138`) and returns the already-recorded
row rather than consuming a second number. Retries were never the risk;
the risk this section actually addresses is "the device that assigns the
number is no longer guaranteed to ever prove that assignment to anyone
else."

**Same treatment needed for:**
- **Voids** — already reference the original transaction by its
  (now-permanent, not `txn_`-prefixed-pending) invoice number; no change
  needed to void logic itself, only to what the invoice number field
  contains at void time (a real number, immediately, not a placeholder).
- **Day-end** — day-end totals reference transactions by their real
  invoice numbers from the moment of sale, not after a sync that might
  never come. `putLocalDayEnd`'s stored totals should already be computed
  from local data (Part 9) — this just means those numbers are final
  immediately, not provisional.
- **Cash movements** — these use a `uuid client_id`, not a sequential
  fiscal number, so they're unaffected by this section; the existing
  `cash_movements.client_id uuid unique` idempotency (Part 6, prior
  draft) stands as-is.

**Cash payments** — unaffected, no network dependency at transaction
time, unchanged from the prior draft.

**E-wallet reference-number payments** — unaffected, same reasoning as
cash — the reference number is entered locally and reconciled
out-of-band regardless of connectivity.

### 6.3 What changes in the implementation plan

This moves from "Part 6, no changes" to a concrete new task: `branchMeta`
gains a durable `invoiceNext` counter that the *device* owns and
increments transactionally at sale time (today it's populated from the
server's `bootstrapBranchData` response but never locally incremented —
incrementing only happens server-side via `reserve_invoice_number`); the
`completeSale` queue payload carries a final `invoiceNumber` instead of
leaving it null; the server-side RPC and its unique constraint change from
"assign the number" to "validate and record the number it's given."
Sequenced into Part 14's phase list below.

---

## 7. Sync engine

Also already built (`syncEngine.js`, audited in Part 1). Mapping the
brief's specific concerns to what exists:

| Concern | Existing mechanism |
|---|---|
| Idempotency | Server-side unique constraints on `client_id` (Part 6) — retries are safe by construction, not by client discipline |
| Retry | `pushQueue` retries each `PENDING`/`FAILED` item; per-item `nextRetryAt` |
| Exponential backoff | `RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000]` in `syncQueue.js` |
| Duplicate prevention | Same unique-constraint mechanism, plus `markDone` deletes the queue row only after server ACK |
| Ordering | FIFO by `createdAt`; `pushQueue` stops at the first *non-quarantined* failure specifically to preserve order for stock-dependent ops |
| Dependencies between ops | `requireShiftServerId`/`requireTransactionServerId` explicitly throw (not silently drop) when a dependency (shift open, original sale) hasn't synced yet, which — combined with FIFO order — is what makes them resolve correctly on the next pass |
| Partial failures | Per-item `attempts`/`BLOCKED` quarantine after `MAX_SYNC_ATTEMPTS=5` so one poison-pill op can't wedge every sale behind it forever |
| Conflict resolution | See Part 8 |
| Server vs. client timestamps | Server assigns authoritative `invoiceNumber`/timestamps at sync time for sales; local `createdAt` is preserved as the record's true occurrence time even though it may sync minutes/hours/days later |
| Network interruption mid-sync | `pushInFlight` guard + `resetStuckSyncing()` (recovers rows stuck in `SYNCING` from a previous run that never got to mark them done/failed) |
| App crash mid-sync | Same `resetStuckSyncing()` — Dexie's `SYNCING` status is durable, so a crashed tab's in-flight item is simply retried on next start, and server-side idempotency makes that safe even if the crash happened *after* the server accepted it but *before* the client recorded success |
| Session revocation mid-sync | `heartbeatStaffSession()` checked **before** touching the queue, specifically so a session stolen by another device while this one was offline doesn't burn every queued item's retry budget identically and wrongly quarantine all of them |

**Nothing to add here for Phase 4.** The one thing worth calling out
explicitly for Desktop: this all assumes a single Electron renderer
process. Confirm (not redesign) that the app doesn't accidentally run the
sync engine twice — e.g. a second `BrowserWindow` instance — since two
concurrent `pushQueue` runs against the same Dexie DB would violate the
`pushInFlight`/`syncing` guards' single-process assumption. `CODEMAP.md`
already notes second-instance handling
(`bc2d94a fix(desktop): explicitly show() the existing window on
second-instance launch`) — this proposal just flags that the
single-instance lock is now also a **data-integrity** requirement, not
only a UX one, and should be verified as part of Phase 4 testing.

---

## 8. Conflicts

With one computer per branch, most "concurrent edit" conflicts (the
usual hard case for offline-first systems) don't arise for *this
branch's own writes* — there's only one writer. The conflicts that remain
are all **stale-read-then-write against data that changed elsewhere**
while this device was disconnected:

| Conflict | Deterministic resolution |
|---|---|
| Product price changed online while branch offline | Device sold at the **stale locally-cached price** for any sale rung before the next sync — this is unavoidable (the till has no way to know a price changed with no network) and is not a "silent overwrite of a financial record" concern, it's the *correct* record of what was actually charged at the time. The catalog itself updates to the new price on next sync; already-completed sales are never retroactively repriced. |
| Promo expired while branch offline | Same principle — a promo applied per the locally-cached promo window at time of sale is the true record of what happened. `CODEMAP.md`'s existing promo dual-control/expiry logic already treats promo state as branch-cached data, consistent with this. |
| Inventory changed online while branch offline | `hasPendingStockOps` guard already resolves this: local stock is authoritative until this device's pending stock-affecting ops (sale, void, adjust, create) have all synced, at which point a full pull reconciles from the server's now-consistent view. Deterministic: local wins until drained, server wins after. |
| User permissions changed online | Covered in Part 4.3 — stale until next sync, bounded by `VERIFIER_MAX_AGE_MS`. |
| Manager edited branch settings online | Same as product price — next sync's `pullFromRemote` reconciles `branchMeta`/fiscal header; nothing this device did offline depended on those settings being current beyond what it already had cached. |
| Transaction already exists on server (retry after a dropped ACK) | The `client_id` unique-index idempotency fast path (Part 6) — deterministic, server-enforced, not a heuristic. |
| Void/refund references a transaction that hasn't synced yet | `requireTransactionServerId` — deterministically waits (throws to hold FIFO position) until the sale syncs, or drops the void only if the sale is provably never going to sync (`BLOCKED`). Never guesses. |
| **New — till hardware replaced without ever syncing its final invoice counter** | Not automatically resolvable — see Part 6.1. Deterministic *mitigation*, not resolution: the server-side `(branch_id, invoice_number)` uniqueness constraint turns a collision into a loud, visible error at whatever point the old device's backlog (if ever recovered) meets the new device's numbers, rather than silently merging two conflicting fiscal sequences. Prevention is procedural (documented handoff of the last-issued number), not something sync logic can infer on its own. |

**Principle already embodied by the codebase and worth stating
explicitly as policy:** *this device's own record of what actually
happened locally is never silently overwritten by a later server pull.*
`putTransactions`/`putMovements`/`putDayEnds` all explicitly preserve
`syncStatus: 'pending'|'local'` rows through a remote reconcile
(`repository.js:89-171`). Phase 4 should keep this invariant, not weaken
it.

---

## 9. Day End

Already built end-to-end for the offline case (`CODEMAP.md`'s Day End
section, `queueTypes.js`'s `SUBMIT_DAY`/`CLOSE_DAY`/`REQUEST_DAY_END`
family, `db.dayEnds`, `shifts.js`).

- **Calculated locally:** cash totals from `cashPosition()` (merges
  server-known sales with not-yet-synced local sales — `source: 'local'`
  labeled "Offline" in the UI per `CODEMAP.md:1372-1373` — so the cashier
  always sees an honest label for whether a figure is authoritative or a
  local estimate).
- **Stored locally:** `db.dayEnds` row with `syncStatus: 'pending'`,
  via `putLocalDayEnd`.
- **Reaches Supabase eventually via:** `SUBMIT_DAY`/`CLOSE_DAY` queue op
  → `api.submitDayEnd` → local row deleted once the server row exists
  (`syncEngine.js:384-389`).
- **Duplicate-submission prevention:** same `client_id` idempotency
  pattern as sales — `staff_shifts.client_id` / day-end's own equivalent
  constraint.
- **Auditability preserved:** the local record isn't deleted until the
  *server* confirms it exists; a crash between "local submit" and "server
  ack" just means the queue item is still pending and retries — no data
  is ever in a state where it exists nowhere.

**Nothing new required for Phase 4.** `markRequireFreshLogin()` (called
after day-end close, per `session.js:25-27`) is the one place Day End and
Part 3's new roster-based login interact: after a day-end close, the
*next* login on this device — for anyone — must be a verified login, not
a restore. That invariant already exists and should be preserved
unchanged when the singleton session cache becomes a roster (Part 3.2):
`needsFreshLogin()` gates the whole offline-login branch before any
roster lookup happens, exactly as it gates the current single-cache
lookup.

---

## 10. Offline → online lifecycle

The 14-step lifecycle in the brief is, again, already what
`connectivity.js` + `syncEngine.js` implement:

```
1. Computer online, branch computer boots
2. App loads → useAuthStore.restoreSession() → confirms/refreshes cached
   session, heartbeats staff session, pulls staffVerifiers (Part 3)
3. Cashier logs in (online: real Supabase Auth + Turnstile;
   offline: verified against staffVerifiers, Part 3)
4. Branch loses internet — reachability.js's canSyncWithBackend() flips
   false within its 15s cache window; connectivity.js stops polling
5. Cashier keeps selling — every write goes local Dexie + enqueue(),
   UI never blocks on the network
6. Transactions accumulate in syncQueue, PENDING
7. Supervisor voids / cashier requests day-end / manager approves —
   all go through the same enqueue() pattern, PIN-verified locally
   where approval is required (supervisorPin.js, extended per Part 3)
8. Internet returns — browser 'online' event fires
9. connectivity.js's debounced (400ms) handler calls
   drainQueueInBackground(branchId)
10. pushQueue() heartbeats the session first (catches a stolen-session
    case before burning retries), then drains PENDING items FIFO,
    respecting per-item backoff and the MAX_SYNC_ATTEMPTS quarantine
11. pullFromRemote() reconciles catalog/transactions/movements/
    dayEnds/staffVerifiers from the server's now-current state
12. Local state reconciles per Part 8's deterministic rules — pending/
    local rows always survive a pull; only settled rows get replaced
13. syncStore's UI chip reflects "idle"/pending-count/blocked-count
    (Shell sync badge, already wired)
14. Normal online mode resumes — subsequent writes go through the
    same code path either way (enqueue always happens; whether the
    push happens immediately or waits for the next connectivity event
    is the only difference)
```

**Sync failing halfway through:** already handled —
`pushQueue` stops at the first *non-quarantined* failure (preserving
FIFO order for the retry), `resetStuckSyncing()` recovers anything left
in `SYNCING` from an interrupted run, and nothing is ever deleted from
`syncQueue` until the server has actually acknowledged it (`markDone`).
A half-finished sync just means "fewer items pushed this cycle than
attempted" — the next connectivity event (or the 30s watchdog poll)
picks up exactly where it left off.

---

## 11. Permanently-offline branches / future USB workflow — compatibility check, elevated priority

**Still not building this now, per the brief — but its priority just
changed.** With "may genuinely never reconnect" confirmed as the actual
requirement (not a hypothetical), this stops being a nice-to-have future
workflow and becomes **the only disaster-recovery mechanism a
permanently-offline till has at all.** A branch computer that never syncs
again has its *entire* sales history, audit log, and (per Part 6) its
*entire fiscal invoice sequence* living in exactly one IndexedDB, on
exactly one machine, with no copy anywhere else. If that device is lost,
stolen, or its disk fails, that data is gone — not delayed, not
recoverable from the server, gone. That is a materially different risk
profile than "the sync is running late."

**Recommendation: revisit deferring this.** Not proposing to design or
build the full USB export/import workflow in this pass — it's genuinely
larger scope (Electron main-process file I/O, signing/encryption, a
manager-side import flow) — but flag explicitly that shipping "permanent
offline" *without* some periodic local-backup mechanism (even just
"export a signed snapshot to a USB drive," with no server round-trip
required) leaves a real gap between what this phase enables and what a
business actually needs from a system holding its entire sales record.
Whether that backup mechanism ships alongside Phase 4 or right after it is
a scoping call for whoever prioritizes the roadmap — but it shouldn't be
pushed out indefinitely the way "nice-to-have future workflow" implies.

Assessing whether the Phase 4 design accommodates it later:

- The `client_id`-based idempotency model (Part 6) is exactly what a
  USB-transported batch import would need — a Day End's queued ops,
  exported as a signed/encrypted file and replayed against Supabase from
  another connected device, would hit the same unique-index idempotency
  path as a normal sync. No redesign needed for that part.
- The `syncQueue` table is already a serializable, ordered log of
  everything that needs to reach the server — it is a reasonable export
  unit as-is (dump pending rows to a signed JSON file) without needing a
  new "export format."
- What Phase 4 does **not** yet provide, and the future USB workflow
  would need: (a) a way to *apply* an exported queue against Supabase from
  a device that isn't the till itself (today `pushOne()` assumes it's
  running on the branch's own authenticated session/device-fingerprint —
  a manager's laptop replaying another branch's queue would need its own
  auth/attribution model), and (b) encryption/signing of the export file,
  which touches Electron's main process (filesystem + crypto) for the
  first time in this whole design — everything up to this point stays in
  the renderer.
- **Conclusion:** nothing in this Phase 4 proposal blocks the future USB
  path; it's compatible by construction because the queue/idempotency
  model was already designed generally. The USB workflow is additive
  (new export/import functions + Electron main-process file I/O), not a
  rework of anything proposed here.

---

## 12. Security model

| Risk | Threat | Realistically preventable? | Mitigation |
|---|---|---|---|
| Local database tampering (editing IndexedDB rows directly, e.g. via DevTools) | Someone with device access rewrites a cached price, permission, or queued transaction before it syncs | **Partially.** Anything staged for sync is still validated/computed authoritatively server-side (VAT, invoice numbers, RLS) on push — a tampered *payload* is still checked against real constraints server-side. A tampered *local display* (e.g. edited stock number shown on screen) is not preventable client-side. | Server remains the authority for anything that matters fiscally; local data is a cache/staging area, never trusted as final. This is already the existing design (Part 6) — Phase 4 doesn't weaken it. |
| Local credential extraction (stealing `staffVerifiers`/PBKDF2 records off a stolen device) | Attacker copies IndexedDB, brute-forces offline | Cost is raised, not eliminated — 600k-iteration PBKDF2 (`unlockVerifier.js`) makes each guess expensive, but a weak password is still eventually crackable offline with enough compute | **No time limit bounds the exposure window anymore** (Part 3.2 — expiry removed per the confirmed "offline forever" requirement), so the *only* mitigation is PBKDF2 cost, which is only as good as the secret's strength. Recommend enforcing a minimum PIN/password strength policy as a direct consequence of removing the time backstop — it went from "one of several defenses" to "the only defense." |
| **New — total data loss with no server backup** | Device lost, stolen, or its disk fails on a branch that has never synced (or hasn't recently) — its entire sales history, audit log, and (per Part 6) fiscal invoice sequence exist nowhere else | Not preventable by this app's sync design alone, since the requirement is specifically that sync might never happen | See Part 11 — this is the direct reason local backup/export priority was raised. Recommend OS-level disk redundancy/backup on the branch machine as a standard deployment step regardless of whether an in-app export ships, same spirit as the disk-encryption recommendation below. |
| Clock manipulation (setting device clock back to extend a locked-out backoff or an expired verifier) | Cashier sets system clock back to bypass `VERIFIER_MAX_AGE_MS` or the unlock-attempt lockout | **Not fully preventable client-side** — there is no trusted time source with zero network. | Accept as a residual risk bounded by physical access control (same as any unattended-terminal lockout scheme); server-side timestamps remain authoritative for anything that syncs, so clock rollback cannot forge a sale's true occurrence time once it reaches Supabase (server stamps its own `created_at` on receipt, independent of the client's claimed timestamp) — verify this is actually true for every RPC as part of Phase 4 testing, not assumed. |
| Replay of old transactions | Attacker re-submits an old queued sale to double-count it | Prevented, not just mitigated | `client_id` unique index (Part 6) — a replayed op is a no-op server-side. |
| Duplicate synchronization | Same queue item pushed twice (crash, retry) | Prevented | Same unique-index mechanism. |
| Forged transaction IDs | Attacker crafts a `client_id` to collide with a real one, or forges a plausible-looking sale | RLS + the same uniqueness constraint mean a forged duplicate is rejected, not a novel forged sale — but a forged sale with a *fresh, valid-looking* clientId sent through the authenticated session's own RPC path is indistinguishable from a real one, because it *is* one, from the server's point of view — the boundary is the authenticated session, not the clientId | This is a "someone with legitimate device+session access chooses to abuse it" case, not a data-integrity gap — same exposure any till has today, offline or not. Out of scope for this phase; addressed by the existing audit-log/void-approval controls, not the sync design. |
| Permission manipulation (editing a cached `permissions[]` locally) | Attacker edits the cached user object to grant themselves a module | Only effective against **local UI gating** — `CODEMAP.md` is explicit that "the database still enforces branch access independently via Postgres RLS... UI gating is not the security boundary." A tampered local cache can unlock a menu item, but any write it triggers still goes through server-side RLS on sync. | No new mitigation needed — this is the existing, correct model; Phase 4 doesn't change where the real boundary is. |
| Offline user revocation (can't kill a session instantly with no network) | Terminated employee keeps working offline | Not preventable in real time — see Part 4.3 | Bounded by `VERIFIER_MAX_AGE_MS` + next-sync reconciliation; documented, accepted policy, not a silent gap. |
| Device theft | Physical device (and its IndexedDB) taken | Not preventable by software alone | Existing PBKDF2 cost + verifier expiry limits the *offline* exposure window; anything requiring the still-live Supabase session (online actions) is cut off the moment `heartbeatStaffSession`/RLS revoke the account, same as today. Recommend: OS-level disk encryption (BitLocker) on branch machines as a standard deployment step — outside this app's scope but worth stating since it's the actual answer to "device theft." |
| Copying the local database to another computer | Attacker copies the Dexie DB file to a machine they control, to attack verifiers at leisure without the unlock-attempt lockout (which is IndexedDB-persisted, so it'd reset on a *fresh* IndexedDB, but copying preserves it — copying preserves the lockout state too) | Copying does **not** reset the persisted `unlockAttempts`/lockout state (it's copied along with everything else) — so the lockout still applies unless the attacker also edits that row out, at which point they're back to the PBKDF2 cost alone as the defense | Same PBKDF2-cost mitigation; no additional defense proposed here beyond what already exists. |
| Editing IndexedDB manually (DevTools/extension) | Same as "local database tampering" above | Same answer | Same answer — server remains authoritative for anything fiscal. |

**No impossible guarantee is promised anywhere above** — every row states
a bounded mitigation, not elimination, consistent with the brief's
instruction not to promise unrealistic security.

---

## 13. Electron-specific architecture

**Everything in this proposal stays in `src/` (the renderer), unchanged
from the web/PWA architecture.** No IPC, no Electron main-process
involvement, for Phase 4A–4F. Rationale:

- Dexie/IndexedDB in Electron's Chromium renderer is the same API as the
  browser build — this is the whole reason Electron was viable here
  without a native rewrite.
- Turnstile (already solved for Desktop per Phase 1/2, per project
  memory) is the one piece that *did* need Electron-specific handling
  (loopback HTTP + CommonJS preload), and that's already done and stays
  untouched by this proposal.
- The only future work that legitimately needs Electron main-process
  involvement is the **USB export/import** path (Part 11) — native
  filesystem access and file signing/encryption are things a sandboxed
  renderer shouldn't do directly. That's explicitly deferred, not part of
  Phase 4.

**Verify, don't redesign, one thing during Phase 4 implementation:**
`sessionLifecycle.js`'s browser-close detection
(`pagehide`/`beforeunload`) needs to actually fire correctly for
Electron's `BrowserWindow` close (not just a renderer navigation) —
confirm this against `electron/main.js`'s window-close handling
(the window-state save code already touches this area per recent commits
— `54d43be`, `a553e5e`). If it doesn't fire the same way, that's a
Phase 4A task item, not a new architecture.

---

## 14. Implementation phases

Adjusted from the brief's template to reflect how much is already built —
the real work is narrower and more front-loaded than "6 roughly equal
phases":

**Phase 4A — Staff verifier roster (foundation)**
- New `staffVerifiers` Dexie table + version bump
- New `fetch_branch_staff_verifiers` RPC (generalizes
  `fetch_branch_supervisor_verifiers` to all roles) + RLS
- Wire into `pullFromRemote` (same place `putSupervisorVerifiers` is
  called today)
- Depends on: nothing — purely additive to the existing sync pull

**Phase 4B — Offline primary authentication, no expiry backstop**
- `verifyStaffCredentialOffline()` (generalizes
  `verifySupervisorPinOffline`) for PIN-mode login — no time-based
  expiry check anywhere in this path (Part 3.2)
- Manager/master email+password offline path (needs a
  loginCode-equivalent lookup — an email→staffId mapping cached
  alongside the verifier, since managers don't have a `loginCode`)
- Rewire `useAuthStore.login()`'s offline branch to call this instead of
  blind `loadLocalSession()`
- `session.js`: singleton → roster-aware (keep `SESSION_KEY` as "active
  user," stop treating it as "the only known user")
- **Remove the existing hard expiry block in
  `verifyAccountPassword()`** (`auth.js:393-396`) — this is a fix to
  already-shipped code, not just new code following the old pattern; it
  currently forces an online reauth after 30 days for manager lock-screen
  unlock, which directly contradicts the confirmed requirement
- Depends on: 4A (needs the verifier table populated first)

**Phase 4C — Local, permanently-authoritative invoice numbering**
- `branchMeta.invoiceNext` becomes device-owned and
  transactionally incremented at sale time, not server-reserved at sync
  time (Part 6.2)
- `COMPLETE_SALE` payload carries a final `invoiceNumber` from the moment
  of local commit; receipts stop showing "Pending"
- Server-side RPC changes from "assign the number" to "validate and
  record the number it's given," with the `(branch_id, invoice_number)`
  uniqueness constraint as the collision backstop
- Document the till-replacement manual handoff procedure (Part 6.1) —
  a process artifact, not just code, but this phase is where it needs to
  be written down and agreed with whoever owns BIR compliance for this
  deployment
- Depends on: nothing in 4A/4B — this is independent, could be sequenced
  in parallel, but is listed here for narrative order

**Phase 4D — Authorization roster correctness**
- Confirm `effectivePermissions`/`canAccessModule` work unchanged against
  the new roster-sourced user object (should be a non-event — they're
  pure functions over `user`, per Part 4.1 — but verify explicitly)
- Confirm disabled/deleted-account removal actually drops the
  `staffVerifiers` row on next pull (server-side RPC filter, `is_active`
  check) — this is now the *only* revocation path, so it must actually
  work, not just be assumed to
- Depends on: 4A, 4B

**Phase 4E — Hardening & edge cases**
- Multi-user handoff testing (cashier A offline-logs-in, hands off to
  cashier B offline, both have valid verifiers, neither ever expires)
- `needsFreshLogin()` interaction with the new roster path (Part 9's
  invariant) — explicit test, not just code review
- Electron `BrowserWindow`-close → `sessionLifecycle.js` firing
  correctly (Part 13)
- Single-instance lock as a data-integrity requirement, not just UX
  (Part 7's note) — now doubly important since the local invoice counter
  (Part 6) is also vulnerable to a concurrent-writer race, not just the
  sync queue
- Login error messaging — decide deliberately whether "wrong
  credential" needs to stay a single generic message (current security
  posture in `verifySupervisorPinOffline`) now that "verifier expired" is
  no longer a possible state to conflate it with
- Depends on: 4B, 4C, 4D

**Phase 4F — Verification pass over what's already built (not new code)**
- Confirm Parts 5, 7–10's existing offline paths (sale, void, cash,
  shift, day-end, sync) all function correctly specifically *inside the
  Electron shell*, not just the browser build — same logic, different
  runtime, worth a deliberate pass rather than assuming parity
- Confirm IndexedDB persistence survives realistic Electron
  lifecycle events (app update, `userData` directory untouched across
  versions, etc.)
- Depends on: nothing functionally, but sequenced last since it's a
  verification pass and 4A–4E are more likely to surface issues first

**Explicitly not in this phase (per the brief's constraints):**
hardware integration, any weakening of Turnstile/online auth, SQLite
migration. **USB export/import (Part 11) is deferred but flagged as a
near-term follow-on, not indefinitely future** — see Part 11 and Part 15.

---

## 15. Major risks

1. **Verifier-provisioning cold start** — a branch adopting Desktop for
   the first time has *no* `staffVerifiers` until every staff member has
   logged in online once. If the branch goes offline before that happens
   (e.g. rollout day has a network outage), offline login doesn't help
   anyone yet. Mitigate by requiring one online login per staff member as
   part of Desktop rollout, not something to solve in code.
2. **Manager/master offline login needs a credential shape cashiers
   don't have** (email+password, no `loginCode`) — the `staffVerifiers`
   schema and lookup need to handle both shapes cleanly; underspecifying
   this in the implementation plan risks a two-path design that silently
   diverges over time (mirroring the existing PIN-vs-email split in
   `posStore.login()` — same divergence risk that split already carries,
   just now offline too).
3. **Staleness policy (Part 4.3) is a business decision, not just an
   engineering one** — "up to 30 days of stale access, worst case" needs
   sign-off from whoever owns the business risk, not just a code review.
   Flag explicitly before implementation, don't bury it in a comment.
4. **Electron lifecycle parity is unverified, not just unimplemented** —
   Part 7 and Part 13 both flag things that are *assumed* to work
   identically to the browser build (single-instance guarantee,
   pagehide/beforeunload firing) but haven't been explicitly tested
   inside the desktop shell. Treat as an open question, not a given.
5. **No time-based revocation means a compromised or terminated
   account's access has no automatic ceiling on a branch that never
   syncs again** (Part 4.3) — this is the direct, accepted cost of the
   "offline forever" requirement, not an oversight, but it needs to be a
   *known and signed-off* business risk, not something that surfaces for
   the first time during an incident.
6. **Till-replacement invoice-number continuity is a manual process, and
   manual processes get skipped** (Part 6.1) — if this branch's device is
   ever replaced without following the documented handoff, the result is
   a BIR-relevant numbering gap or collision. This risk is inherent to
   moving invoice authority onto the device and can be reduced by process
   discipline but not eliminated by software alone.
7. **A permanently-offline branch has no off-device copy of its sales
   record, audit log, or invoice sequence unless something exports one**
   (Part 11) — until a backup/export mechanism ships, device loss/theft/
   failure means genuine, unrecoverable data loss for that branch's
   entire history. This is the most consequential open item in this
   revision and shouldn't be left open indefinitely.

---

## 16. What should NOT be built yet

Per the brief's explicit constraints, restated as a checklist for
whoever executes the eventual implementation plan:

- [ ] No SQLite — Dexie stays (Part 2)
- [ ] No *full* USB export/import workflow built in this phase (Part 11)
      — but do not treat this as "indefinitely future" anymore; it is the
      only disaster-recovery mechanism a permanently-offline till has, and
      should be scoped as a near-term follow-on, not shelved
- [ ] No hardware integration
- [ ] No Turnstile bypass or weakening for the online path
- [ ] No plaintext credential storage, ever
- [ ] No forcing the web/PWA build toward full offline capability
- [ ] No new abstraction layer over Dexie "in case we need SQLite later" —
      YAGNI; Part 2's recommendation is to keep the existing direct-Dexie
      code as-is, not to add an indirection layer speculatively
