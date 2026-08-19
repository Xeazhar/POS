/**
 * CalePOS stress test — rings sales as concurrent cashier terminals against the
 * POS-Stress test Supabase project via the exact REST/RPC calls the app itself makes
 * (resolve_pin_login -> password grant -> complete_sale), the same primary path as
 * completeSale() in src/lib/api.js. complete_sale() (migrate_complete_sale_rpc.sql) does
 * till check + invoice allocation + transaction insert + item inserts + stock movements + audit
 * event atomically in one round trip; if that RPC isn't deployed yet, completeSale() falls
 * back to the older 4-round-trip flow (assert_till_open + allocate/reserve_invoice_number ->
 * insert transactions -> insert transaction_items -> record_stock_movement), but this load
 * test always exercises the atomic path since that's what the perf work targets. Every sale
 * randomizes payment method (cash/card/e-wallet); a share of lines fall under each branch's
 * seeded promo (item_pct discount, mirrors discount_eligible + promo_name/promo_group_id
 * attribution); after ringing, each sale independently rolls into a void (void_sale_secure),
 * a partial or full item refund (refund_sale_items — full-items refund auto-voids, matching
 * the real RPC's behaviour), or stays a plain completed sale.
 *
 * Reads connection + staff PINs from ../.env.test (the file `npm run setup:load-test`
 * writes) — never touches calepos-dev/staging/production; those credentials aren't there.
 *
 * Usage (k6 is a separate binary, not an npm package — see loadtest/README.md to install):
 *   k6 run loadtest/pos-checkout.js                 # full ramp: 28 -> 50 -> 100 -> 200
 *   k6 run -e LEVEL=100 loadtest/pos-checkout.js     # pinned at one concurrency level
 *   k6 run -e LEVEL=100 -e DURATION=5m loadtest/pos-checkout.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BRANCH_COUNT = 7;
const CASHIERS_PER_BRANCH = 3;
const CASHIER_LETTERS = ['A', 'B', 'C'];
const PRODUCTS_PER_BRANCH = 15;
const VOID_PROBABILITY = 0.05;
const REFUND_PROBABILITY = 0.05;
const PROMO_DISCOUNT_PCTS = [10, 15, 20];

const checkoutDuration = new Trend('checkout_duration', true);
const checkoutErrors = new Counter('checkout_errors');
const loginDuration = new Trend('login_duration', true);
const loginErrors = new Counter('login_errors');
// Distinct from login_errors (one per failed HTTP attempt): counts VUs that exhausted
// LOGIN_MAX_ATTEMPTS and stopped trying for the rest of the run. If this stays near 0 while
// login_errors is nonzero, transient failures are being absorbed by the retry+backoff below
// (working as intended). If this climbs, the account/rate-limit problem is real and durable,
// not a blip — see ensureSession()'s comment.
const loginGiveUps = new Counter('login_give_ups');
const orNumbersAllocated = new Counter('invoice_numbers_allocated');
const voidsProcessed = new Counter('voids_processed');
const partialRefundsProcessed = new Counter('partial_refunds_processed');
const fullItemRefundsProcessed = new Counter('full_item_refunds_processed');
const cashSales = new Counter('cash_sales');
const cardSales = new Counter('card_sales');
const ewalletSales = new Counter('ewallet_sales');
const promoLinesSold = new Counter('promo_lines_sold');

// Per-operation timing. Since completeSale() now calls the atomic complete_sale() RPC
// (migrate_complete_sale_rpc.sql) instead of 4 separate round trips (assert_till_open +
// allocate_invoice_number + insert transactions + insert transaction_items + record_stock_movement
// per line), those steps are no longer independently observable from the client — they run
// inside one server-side transaction. complete_sale_duration and checkout_duration now cover
// the same span; both are kept because the task asked for complete_sale_total_duration
// specifically, and checkout_duration is the threshold metric. void/refund stay separate
// RPCs, so they still get their own Trend.
const completeSaleDuration = new Trend('complete_sale_duration', true);
const voidDuration = new Trend('void_duration', true);
const refundDuration = new Trend('refund_duration', true);
const deadlockRetries = new Counter('deadlock_retries');

// ---------------------------------------------------------------------------
// .env.test — same file setup-load-test-users.mjs writes. Parsed once at init time.
// ---------------------------------------------------------------------------
function parseEnvFile(text) {
  const vars = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

const ENV = parseEnvFile(open('../.env.test'));
const SUPABASE_URL = ENV.SUPABASE_URL;
const ANON_KEY = ENV.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !ANON_KEY) {
  throw new Error(
    '.env.test is missing SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY — run `npm run setup:load-test` first.',
  );
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

const CASHIERS = [];
const SUPERVISORS = [];
for (let b = 1; b <= BRANCH_COUNT; b += 1) {
  const branchKey = `BRANCH_${pad2(b)}`;
  const supCode = ENV[`LOADTEST_${branchKey}_SUPERVISOR_CODE`];
  const supPin = ENV[`LOADTEST_${branchKey}_SUPERVISOR_PIN`];
  if (!supCode || !supPin) {
    throw new Error(`Missing supervisor credentials for branch ${b} in .env.test — re-run npm run setup:load-test.`);
  }
  SUPERVISORS.push({ branchIndex: b, code: supCode, pin: supPin });

  for (let c = 1; c <= CASHIERS_PER_BRANCH; c += 1) {
    const letter = CASHIER_LETTERS[c - 1];
    const code = ENV[`LOADTEST_${branchKey}_CASHIER_${letter}_CODE`];
    const pin = ENV[`LOADTEST_${branchKey}_CASHIER_${letter}_PIN`];
    if (!code || !pin) {
      throw new Error(`Missing cashier ${letter} credentials for branch ${b} in .env.test.`);
    }
    CASHIERS.push({ branchIndex: b, code, pin });
  }
}

// ---------------------------------------------------------------------------
// k6 options — ramp through 28/50/100/200, or pin one level via -e LEVEL=N
// ---------------------------------------------------------------------------
const level = __ENV.LEVEL ? Number(__ENV.LEVEL) : null;
const pinnedDuration = __ENV.DURATION || '3m';

export const options = {
  scenarios: level
    ? {
        pinned: {
          executor: 'constant-vus',
          vus: level,
          duration: pinnedDuration,
        },
      }
    : {
        ramp: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '30s', target: 28 },
            { duration: '2m', target: 28 },
            { duration: '30s', target: 50 },
            { duration: '2m', target: 50 },
            { duration: '30s', target: 100 },
            { duration: '2m', target: 100 },
            { duration: '30s', target: 200 },
            { duration: '2m', target: 200 },
            { duration: '30s', target: 0 },
          ],
        },
      },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    checkout_duration: ['p(95)<2000'],
    login_duration: ['p(95)<1500'],
  },
  // p99 surfaced in the summary for visibility, not gated — see task notes on why p99 isn't
  // a hard threshold (no established SLO for it yet, only p95 has an agreed target).
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// ---------------------------------------------------------------------------
// Setup (runs once, before any VU starts): seed a small product catalog + one
// active promo per branch if they aren't already there, so checkout has real
// product_ids to sell and a real promo to attribute discounted lines to.
// Idempotent — skips a branch that already has products/an active promo
// (e.g. a prior run without a DB reset in between).
// ---------------------------------------------------------------------------
export function setup() {
  const productsByBranch = {};
  const promoByBranch = {};

  for (const sup of SUPERVISORS) {
    const session = login(sup.code, sup.pin);
    const authHeaders = restHeaders(session.accessToken);

    const existing = http.get(
      `${SUPABASE_URL}/rest/v1/products?branch_id=eq.${session.branchId}&select=id,discount_eligible&is_active=eq.true`,
      { headers: authHeaders },
    );
    const existingRows = safeJson(existing.body) || [];

    let productIds;
    let discountProductIds;
    if (existingRows.length > 0) {
      productIds = existingRows.map((p) => p.id);
      discountProductIds = existingRows.filter((p) => p.discount_eligible).map((p) => p.id);
    } else {
      const newProducts = [];
      for (let i = 1; i <= PRODUCTS_PER_BRANCH; i += 1) {
        newProducts.push({
          branch_id: session.branchId,
          category_id: null,
          name: `Load Test Product ${pad2(sup.branchIndex)}-${pad2(i)}`,
          sku: `LT-${pad2(sup.branchIndex)}-${pad2(i)}`,
          barcode: null,
          pricing_mode: 'per_unit',
          price: 20 + (i % 10) * 45,
          budget_price: null,
          low_stock_threshold: 10,
          medium_stock_threshold: 30,
          discount_eligible: i % 3 === 0,
          is_active: true,
        });
      }

      const inserted = http.post(`${SUPABASE_URL}/rest/v1/products`, JSON.stringify(newProducts), {
        headers: { ...authHeaders, Prefer: 'return=representation' },
      });
      check(inserted, { 'seed products created': (r) => r.status === 201 });
      const rows = safeJson(inserted.body) || [];
      productIds = rows.map((p) => p.id);
      discountProductIds = rows.filter((p) => p.discount_eligible).map((p) => p.id);

      if (productIds.length > 0) {
        const inventoryRows = productIds.map((id) => ({
          branch_id: session.branchId,
          product_id: id,
          quantity_on_hand: 999999,
        }));
        http.post(`${SUPABASE_URL}/rest/v1/branch_inventory`, JSON.stringify(inventoryRows), {
          headers: {
            ...authHeaders,
            Prefer: 'resolution=merge-duplicates,return=minimal',
          },
        });
      }
    }
    productsByBranch[sup.branchIndex] = productIds;

    // Promo: one active item_pct promo covering this branch's discount-eligible
    // products — seeded directly (bypasses the create/approve dual-control flow,
    // same shortcut the product seeding above already takes) so Promos/Dashboard
    // have something real to attribute discounted lines to.
    const existingPromo = http.get(
      `${SUPABASE_URL}/rest/v1/promo_events?branch_id=eq.${session.branchId}&status=eq.active&select=id,name&limit=1`,
      { headers: authHeaders },
    );
    const existingPromoRows = safeJson(existingPromo.body) || [];
    if (existingPromoRows.length > 0) {
      promoByBranch[sup.branchIndex] = {
        name: existingPromoRows[0].name,
        productIds: discountProductIds,
        discountPct: 10,
      };
      continue;
    }
    if (discountProductIds.length === 0) continue;

    const discountPct = PROMO_DISCOUNT_PCTS[randomInt(0, PROMO_DISCOUNT_PCTS.length - 1)];
    const nowMs = Date.now();
    const promoRes = http.post(
      `${SUPABASE_URL}/rest/v1/promo_events`,
      JSON.stringify({
        branch_id: session.branchId,
        name: `Load Test Promo ${pad2(sup.branchIndex)} - ${discountPct}% off`,
        description: 'k6 load test promo — seeded directly, bypasses dual-control approval flow',
        starts_at: new Date(nowMs - 60 * 60 * 1000).toISOString(),
        ends_at: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(),
        status: 'active',
        requested_by: session.staffId,
        approved_by: session.staffId,
        approved_at: new Date(nowMs).toISOString(),
      }),
      { headers: { ...authHeaders, Prefer: 'return=representation' } },
    );
    check(promoRes, { 'promo event created': (r) => r.status === 201 });
    const promo = (safeJson(promoRes.body) || [])[0];
    if (!promo) continue;

    const ruleRes = http.post(
      `${SUPABASE_URL}/rest/v1/promo_rules`,
      JSON.stringify({ promo_event_id: promo.id, rule_type: 'item_pct', discount_pct: discountPct }),
      { headers: { ...authHeaders, Prefer: 'return=representation' } },
    );
    check(ruleRes, { 'promo rule created': (r) => r.status === 201 });
    const rule = (safeJson(ruleRes.body) || [])[0];
    if (!rule) continue;

    const ruleProductRows = discountProductIds.map((id) => ({
      promo_rule_id: rule.id,
      product_id: id,
      product_index: 0,
      quantity_required: 1,
    }));
    http.post(`${SUPABASE_URL}/rest/v1/promo_rule_products`, JSON.stringify(ruleProductRows), {
      headers: { ...authHeaders, Prefer: 'return=minimal' },
    });

    promoByBranch[sup.branchIndex] = { name: promo.name, productIds: discountProductIds, discountPct };
  }

  return { productsByBranch, promoByBranch };
}

// ---------------------------------------------------------------------------
// Per-VU authentication lifecycle
// ---------------------------------------------------------------------------
// k6 gives every VU its own isolated JS runtime and keeps module-level state across that
// VU's iterations (this is standard k6 behaviour, not a workaround) — so a plain module-level
// variable, set once and read on every later iteration of the SAME VU, is the correct and
// complete way to do "authenticate once per VU, reuse the session for the VU's lifetime":
//
//   VU starts -> (1st iteration) ensureSession() logs in, caches token in vuSession
//             -> (2nd..Nth iteration) ensureSession() sees vuSession already set, returns
//                it immediately -- no network call, no re-login
//             -> VU ends
//
// Nothing here ever refreshes the token: every run of this test (single ramp ≈9.5min, or a
// pinned run via -e DURATION) is far shorter than a Supabase access token's default 1-hour
// lifetime, so mid-run expiry is not a real scenario — adding refresh logic would just be
// unused complexity. If you deliberately run a soak test longer than the token lifetime,
// that's the one case where refresh would need adding; it deliberately is not here.
//
// vuLoginFailed exists so a VU that CAN'T log in (bad account, or genuinely rate-limited)
// gives up permanently instead of retrying the login endpoint on every single iteration for
// the rest of the run — that retry-forever pattern is what turns a handful of real failures
// into the kind of Auth-rate-limit cascade this whole rewrite exists to avoid. See
// ensureSession() below.
let vuSession = null;
let vuLoginFailed = false;

function restHeaders(accessToken) {
  return {
    apikey: ANON_KEY,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

function safeJson(body) {
  try {
    return JSON.parse(body);
  } catch (e) {
    return null;
  }
}

function login(code, pin) {
  const start = Date.now();

  const resolveRes = http.post(
    `${SUPABASE_URL}/rest/v1/rpc/resolve_pin_login`,
    JSON.stringify({ p_login_code: code, p_pin: pin }),
    { headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' } },
  );
  const resolveOk = check(resolveRes, { 'resolve_pin_login 200': (r) => r.status === 200 });
  const rows = safeJson(resolveRes.body);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!resolveOk || !row) {
    loginErrors.add(1);
    throw new Error(`resolve_pin_login failed for ${code}: ${resolveRes.status} ${resolveRes.body}`);
  }

  // gotrue_meta_security.captcha_token is the exact wire field @supabase/auth-js sends for
  // signInWithPassword({ options: { captchaToken } }) — confirmed in
  // node_modules/@supabase/auth-js/src/GoTrueClient.ts. Value is arbitrary: .env.test.example
  // has you pair this project with Cloudflare's published "always passes" Turnstile TEST
  // secret (1x0000000000000000000000000000AA), which accepts any non-empty token string
  // without needing a real browser widget. Harmless to send even if Bot/Abuse Protection is
  // off for this project — GoTrue just ignores the field when captcha isn't required.
  const tokenRes = http.post(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    JSON.stringify({
      email: row.auth_email,
      password: pin,
      gotrue_meta_security: { captcha_token: 'k6-loadtest-turnstile-test-secret-bypass' },
    }),
    { headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' } },
  );
  const tokenOk = check(tokenRes, { 'auth token 200': (r) => r.status === 200 });
  const tokenBody = safeJson(tokenRes.body);
  if (!tokenOk || !tokenBody || !tokenBody.access_token) {
    loginErrors.add(1);
    throw new Error(`password grant failed for ${code}: ${tokenRes.status} ${tokenRes.body}`);
  }

  loginDuration.add(Date.now() - start);

  return {
    accessToken: tokenBody.access_token,
    staffId: row.staff_id,
    branchId: row.branch_id,
    loginCode: code,
  };
}

const LOGIN_MAX_ATTEMPTS = 3;

/**
 * Returns this VU's cached session, logging in (once, ever, per VU) on first use.
 *
 * On failure: retries with backoff up to LOGIN_MAX_ATTEMPTS, THEN gives up permanently for
 * this VU (vuLoginFailed = true) rather than trying again on the next iteration. Without this,
 * a VU whose account hits a transient problem — including Auth rate limiting itself — would
 * call the login endpoint again on every single iteration for the rest of the run with zero
 * delay (the default() loop has nothing else to fall back to), which is exactly how one or two
 * genuine failures compound into the "thousands of retries" / rate-limit-cascade failure mode
 * this test was rewritten to avoid. Giving up cleanly means: one VU stops contributing load,
 * the other ~199 are unaffected, and the run's business-metric thresholds still mean something.
 */
function ensureSession(account) {
  if (vuSession) return vuSession;
  if (vuLoginFailed) return null;

  for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt += 1) {
    try {
      vuSession = login(account.code, account.pin);
      return vuSession;
    } catch (e) {
      if (attempt >= LOGIN_MAX_ATTEMPTS) {
        vuLoginFailed = true;
        loginGiveUps.add(1);
        console.error(
          `VU ${__VU}: giving up on login for ${account.code} after ${LOGIN_MAX_ATTEMPTS} attempts (${e.message}) — this VU will stop generating load for the rest of the run.`,
        );
        return null;
      }
      // Backoff before retrying so a failing/rate-limited login isn't hammered again
      // immediately — grows with attempt number, plus jitter so many VUs failing around the
      // same moment don't all retry in lockstep.
      sleep(attempt * 1 + Math.random());
    }
  }
  return null; // unreachable, keeps the linter happy about a guaranteed return value
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickPaymentMethod() {
  const r = Math.random();
  if (r < 0.7) return 'cash';
  if (r < 0.9) return 'card';
  return 'ewallet';
}

// Random v4 uuid for transaction_items.promo_group_id (uuid column) — the real POS assigns
// this from a matched promo bundle rule's own id; k6 doesn't run real bundle matching, so a
// random uuid shared by every discounted line on the sale is a fine stand-in for load-testing
// the grouping/attribution column itself.
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export default function (data) {
  const account = CASHIERS[(__VU - 1) % CASHIERS.length];

  const session = ensureSession(account);
  if (!session) {
    // This VU permanently failed to authenticate (see ensureSession) — skip the iteration
    // instead of touching the login endpoint again. Sleep like a normal iteration would so
    // this VU doesn't spin at max iteration rate doing nothing and skew iteration-rate stats.
    sleep(randomInt(1000, 3000) / 1000);
    return;
  }
  const headers = restHeaders(session.accessToken);
  const productIds = data.productsByBranch[account.branchIndex] || [];
  const promo = data.promoByBranch[account.branchIndex] || null;
  if (productIds.length === 0) {
    checkoutErrors.add(1);
    sleep(1);
    return;
  }

  // Cart: 1-3 random lines from this branch's seeded products. A line whose product
  // is in this branch's promo gets that promo's item_pct discount applied.
  const lineCount = randomInt(1, 3);
  const cart = [];
  for (let i = 0; i < lineCount; i += 1) {
    const productId = productIds[randomInt(0, productIds.length - 1)];
    const quantity = randomInt(1, 4);
    const unitPrice = 20 + randomInt(0, 9) * 45;
    const lineTotal = quantity * unitPrice;
    const eligible = Boolean(promo && promo.productIds.includes(productId));
    const discountAmount = eligible ? Number(((lineTotal * promo.discountPct) / 100).toFixed(2)) : 0;
    cart.push({ productId, quantity, unitPrice, lineTotal, eligible, discountAmount });
  }
  const grossTotal = cart.reduce((sum, l) => sum + l.lineTotal, 0);
  const discountTotal = cart.reduce((sum, l) => sum + l.discountAmount, 0);
  const total = grossTotal - discountTotal;
  const paymentMethod = pickPaymentMethod();
  const paymentReference = paymentMethod === 'ewallet' ? `k6-ewallet-${__VU}-${__ITER}` : null;
  const tendered = paymentMethod === 'cash' ? total + randomInt(0, 100) : total;
  const promoGroupId = cart.some((l) => l.eligible) ? uuidv4() : null;

  const items = cart.map((line) => ({
    product_id: line.productId,
    quantity: line.quantity,
    unit_price: line.unitPrice,
    line_total: line.lineTotal,
    discount_eligible: line.eligible,
    discount_amount: line.discountAmount,
    promo_name: line.eligible ? promo.name : null,
    promo_group_id: line.eligible ? promoGroupId : null,
    vat_category: 'vatable',
  }));

  // Mirrors completeSale(): one atomic complete_sale() RPC call does till check + invoice
  // allocation + transaction insert + item inserts + stock movements + audit event, all in
  // one server-side transaction (migrate_complete_sale_rpc.sql) — see loadtest/README.md.
  // Up to one retry on a Postgres deadlock victim (40P01) — same mitigation completeSale()
  // uses in src/lib/api.js: the deadlock always rolls back cleanly (no partial state), so a
  // blind retry is safe, and skipping it here would make k6's tail look worse than what real
  // users, going through the app, actually experience.
  const saleBody = JSON.stringify({
    p_branch_id: session.branchId,
    p_staff_id: session.staffId,
    p_items: items,
    p_total: total,
    p_tendered: tendered,
    p_client_id: `k6-${session.loginCode}-${__VU}-${__ITER}-${Date.now()}`,
    p_payment_method: paymentMethod,
    p_payment_reference: paymentReference,
    p_vat_amount: 0,
    p_vatable_sales: total,
    p_vat_rate_applied: 0.12,
  });
  const start = Date.now();
  let saleRes = http.post(`${SUPABASE_URL}/rest/v1/rpc/complete_sale`, saleBody, { headers });
  if (saleRes.status !== 200 && (safeJson(saleRes.body) || {}).code === '40P01') {
    deadlockRetries.add(1);
    sleep(0.05 + Math.random() * 0.1);
    saleRes = http.post(`${SUPABASE_URL}/rest/v1/rpc/complete_sale`, saleBody, { headers });
  }
  const elapsed = Date.now() - start;
  checkoutDuration.add(elapsed);
  completeSaleDuration.add(elapsed);

  const saleOk = check(saleRes, { 'complete_sale 200': (r) => r.status === 200 });
  const txn = saleOk ? safeJson(saleRes.body) : null;
  if (!saleOk || !txn || !txn.id) {
    checkoutErrors.add(1);
    sleep(randomInt(300, 1000) / 1000);
    return;
  }
  if (txn.invoice_number) orNumbersAllocated.add(1);
  if (paymentMethod === 'cash') cashSales.add(1);
  else if (paymentMethod === 'card') cardSales.add(1);
  else ewalletSales.add(1);
  cart.forEach((line) => {
    if (line.eligible) promoLinesSold.add(1);
  });

  // Each sale independently rolls into exactly one of: void, refund, or stays completed.
  // transaction_items aren't returned by complete_sale, so refund targets are re-fetched.
  const outcomeRoll = Math.random();
  if (outcomeRoll < VOID_PROBABILITY) {
    const voidStart = Date.now();
    const voidRes = http.post(
      `${SUPABASE_URL}/rest/v1/rpc/void_sale_secure`,
      JSON.stringify({
        p_transaction_id: txn.id,
        p_staff_id: session.staffId,
        p_reason: 'k6 load test void',
      }),
      { headers },
    );
    voidDuration.add(Date.now() - voidStart);
    check(voidRes, { 'void ok': (r) => r.status === 200 });
    voidsProcessed.add(1);
  } else if (outcomeRoll < VOID_PROBABILITY + REFUND_PROBABILITY) {
    const linesRes = http.get(
      `${SUPABASE_URL}/rest/v1/transaction_items?transaction_id=eq.${txn.id}&select=id,quantity`,
      { headers },
    );
    const insertedItems = check(linesRes, { 'refund target lines fetched': (r) => r.status === 200 })
      ? safeJson(linesRes.body) || []
      : [];
    if (insertedItems.length === cart.length) {
      // 50/50 a partial (one line, half its quantity) vs. a full-items refund — the
      // latter mirrors refund_sale_items' own auto-void-when-fully-refunded behaviour.
      // Quantities come from the fetched rows themselves (not cart[idx]) — PostgREST
      // doesn't guarantee row order matches insertion order, so index-pairing with cart
      // would be fragile; each row already carries its own true quantity.
      const doFullRefund = Math.random() < 0.5;
      const refundItems = doFullRefund
        ? insertedItems.map((row) => ({ item_id: row.id, quantity: row.quantity }))
        : (() => {
            const row = insertedItems[randomInt(0, insertedItems.length - 1)];
            return [{ item_id: row.id, quantity: Math.max(1, Math.floor(row.quantity / 2)) }];
          })();
      const refundStart = Date.now();
      const refundRes = http.post(
        `${SUPABASE_URL}/rest/v1/rpc/refund_sale_items`,
        JSON.stringify({
          p_transaction_id: txn.id,
          p_staff_id: session.staffId,
          p_reason: doFullRefund ? 'k6 load test full item refund' : 'k6 load test partial refund',
          p_items: refundItems,
        }),
        { headers },
      );
      refundDuration.add(Date.now() - refundStart);
      check(refundRes, { 'refund ok': (r) => r.status === 200 });
      if (doFullRefund) fullItemRefundsProcessed.add(1);
      else partialRefundsProcessed.add(1);
    }
  }

  sleep(randomInt(300, 1000) / 1000);
}
