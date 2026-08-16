-- =============================================================================
-- CalePOS — schema bootstrap
-- Regenerated 2026-08-15 by introspecting the live `CalePOS_Demo` Supabase
-- project (project_id pcasudqyqgzrlpyfdvbe) via pg_catalog/information_schema
-- (no DB password available, so pg_dump could not be used — see
-- supabase/README.md "Generating a verified schema.sql"). CalePOS_Demo has
-- every migrate_*.sql in this directory applied, in order, verified against
-- `list_migrations` before this dump was taken.
--
-- This supersedes the old hand-maintained version of this file, which only
-- had ~18 tables and had drifted badly behind the 100+ migrate_*.sql files.
-- It is now the canonical bootstrap for a brand-new environment: apply this
-- file start-to-finish in the Supabase SQL editor, then you do NOT need to
-- replay the migrate_*.sql history (this already reflects all of it).
--
-- Scope: public schema only. Does not create/alter anything in the
-- Supabase-managed `auth`/`storage` schemas, except for two triggers on
-- auth.users that are this app's standard provisioning hooks (calling
-- public.handle_new_user() / public.trg_confirm_pin_auth_user()) — this
-- mirrors the exact trigger attachments already live on CalePOS_Demo and is
-- required for PIN login / auto-provisioning a staff row on signup.
--
-- Security note: RLS policies and SECURITY DEFINER function bodies are the
-- real access-control boundary for this app (see CLAUDE.md). Every function
-- below is emitted verbatim from pg_get_functiondef() — none are paraphrased.
-- Function EXECUTE grants are reproduced exactly as observed live: most
-- functions rely on Postgres's own default (CREATE FUNCTION grants EXECUTE
-- to PUBLIC, which every role including anon/authenticated inherits) and so
-- have no explicit grant statement below; a a deliberately-hardened subset
-- (money-moving / cross-branch RPCs) has EXECUTE revoked from PUBLIC/anon
-- immediately after creation, with explicit re-grants only to `authenticated`
-- where required — see the "Grants" section for the full list and reasoning.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Extensions
-- -----------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

-- No custom enum/composite types: this codebase uses `text` + CHECK
-- constraints throughout (see CODEMAP.md conventions) — verified via
-- pg_enum: zero rows in the public schema.

-- =============================================================================
-- 1. TABLES + inline PK / UNIQUE / CHECK constraints
--    (dependency order where practical; every FK is added in one pass in
--    section 2 below, so table creation order here is not load-bearing)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1.1 Core org
-- ---------------------------------------------------------------------------
create table if not exists branches (
  id uuid not null default gen_random_uuid(),
  name text not null,
  address text,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  day_open_hour integer not null default 7,
  business_name text,
  tin text,
  bir_permit_no text,
  machine_identification_no text,
  serial_number text,
  or_prefix text not null default 'OR'::text,
  or_next bigint not null default 1,
  branch_type text not null default 'retail'::text,
  device_settings jsonb not null default '{"cash_drawer": false, "barcode_scanner": false, "receipt_printer": false}'::jsonb,
  sort_order integer not null default 0,
  vat_rate numeric(6,4) not null default 0.12,
  branch_tin_code text
);
alter table branches add constraint branches_pkey primary key (id);
alter table branches add constraint branches_branch_type_check check ((branch_type = ANY (ARRAY['retail'::text, 'restaurant'::text])));
alter table branches add constraint branches_day_open_hour_check check (((day_open_hour >= 0) AND (day_open_hour <= 23)));
alter table branches add constraint branches_or_next_check check ((or_next >= 1));

create table if not exists roles (
  name text not null,
  label text not null,
  sort_order integer not null default 0,
  created_at timestamp with time zone not null default now()
);
alter table roles add constraint roles_pkey primary key (name);

create table if not exists staff (
  id uuid not null default gen_random_uuid(),
  auth_user_id uuid,
  branch_id uuid not null,
  full_name text not null,
  role text not null,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  login_code text,
  login_pin text,
  permissions jsonb,
  auth_secret text,
  active_session_id uuid,
  session_heartbeat_at timestamp with time zone,
  pin_verifier jsonb
);
alter table staff add constraint staff_pkey primary key (id);
alter table staff add constraint staff_auth_user_id_key unique (auth_user_id);

-- ---------------------------------------------------------------------------
-- 1.2 Catalog
-- ---------------------------------------------------------------------------
create table if not exists categories (
  id uuid not null default gen_random_uuid(),
  name text not null,
  created_at timestamp with time zone not null default now()
);
alter table categories add constraint categories_pkey primary key (id);
alter table categories add constraint categories_name_key unique (name);

-- Network master catalog: the shared template a branch "adopts" from
-- (api.updateCatalogProduct / adopt_catalog_products RPC). Distinct from a
-- branch's own live `products` row — see CODEMAP.md.
create table if not exists catalog_products (
  id uuid not null default gen_random_uuid(),
  category_id uuid,
  name text not null,
  sku text not null,
  barcode text,
  pricing_mode text not null,
  price numeric(10,2) not null,
  budget_price numeric(10,2),
  menu_kind text,
  low_stock_threshold numeric(10,2) not null default 10,
  medium_stock_threshold numeric(10,2) not null default 30,
  discount_eligible boolean not null default true,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  branch_type text default 'retail'::text
);
alter table catalog_products add constraint catalog_products_pkey primary key (id);
alter table catalog_products add constraint catalog_products_sku_key unique (sku);
alter table catalog_products add constraint catalog_products_branch_type_check check ((branch_type = ANY (ARRAY['retail'::text, 'restaurant'::text])));
alter table catalog_products add constraint catalog_products_budget_price_check check (((budget_price IS NULL) OR (budget_price >= (0)::numeric)));
alter table catalog_products add constraint catalog_products_menu_kind_check check (((menu_kind IS NULL) OR (menu_kind = ANY (ARRAY['meat'::text, 'veggie'::text, 'pancit'::text, 'drink'::text, 'rice'::text, 'extra'::text]))));
alter table catalog_products add constraint catalog_products_price_check check ((price >= (0)::numeric));
alter table catalog_products add constraint catalog_products_pricing_mode_check check ((pricing_mode = ANY (ARRAY['per_unit'::text, 'per_kg'::text])));

create table if not exists products (
  -- id = stable UUID for sales lines / Power BI joins (never reuse)
  -- product_no = per-branch sequential code shown as 0001, 0002, … (assigned
  --   by trg_assign_product_no)
  -- sku = human business key used for CSV import matching
  id uuid not null default gen_random_uuid(),
  branch_id uuid not null,
  category_id uuid,
  name text not null,
  sku text not null,
  barcode text,
  pricing_mode text not null,
  price numeric(10,2) not null,
  low_stock_threshold numeric(10,2) not null default 10,
  medium_stock_threshold numeric(10,2) not null default 30,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  available_today boolean not null default true,
  product_no integer,
  menu_kind text,
  budget_price numeric(10,2),
  unit_cost numeric(12,2) not null default 0,
  discount_eligible boolean not null default false,
  catalog_product_id uuid
);
alter table products add constraint products_pkey primary key (id);
alter table products add constraint products_branch_id_barcode_key unique (branch_id, barcode);
alter table products add constraint products_branch_id_sku_key unique (branch_id, sku);
alter table products add constraint products_branch_product_no_key unique (branch_id, product_no);
alter table products add constraint products_budget_price_nonneg check (((budget_price IS NULL) OR (budget_price >= (0)::numeric)));
alter table products add constraint products_menu_kind_check check (((menu_kind IS NULL) OR (menu_kind = ANY (ARRAY['meat'::text, 'veggie'::text, 'pancit'::text, 'drink'::text, 'rice'::text, 'extra'::text]))));
alter table products add constraint products_price_check check ((price >= (0)::numeric));
alter table products add constraint products_pricing_mode_check check ((pricing_mode = ANY (ARRAY['per_unit'::text, 'per_kg'::text])));

create table if not exists branch_inventory (
  id uuid not null default gen_random_uuid(),
  branch_id uuid not null,
  product_id uuid not null,
  quantity_on_hand numeric(10,2) not null default 0,
  updated_at timestamp with time zone not null default now(),
  change_version bigint not null default 0
);
alter table branch_inventory add constraint branch_inventory_pkey primary key (id);
alter table branch_inventory add constraint branch_inventory_branch_id_product_id_key unique (branch_id, product_id);

create table if not exists stock_movements (
  id uuid not null default gen_random_uuid(),
  branch_id uuid not null,
  product_id uuid not null,
  staff_id uuid,
  movement_type text not null,
  reference text,
  detail text,
  quantity_in numeric(10,2) not null default 0,
  quantity_out numeric(10,2) not null default 0,
  quantity_on_hand_after numeric(10,2) not null,
  created_at timestamp with time zone not null default now(),
  old_price numeric(10,2),
  new_price numeric(10,2)
);
alter table stock_movements add constraint stock_movements_pkey primary key (id);
alter table stock_movements add constraint stock_movements_movement_type_check check ((movement_type = ANY (ARRAY['restock'::text, 'sale'::text, 'adjustment'::text, 'shrinkage'::text, 'update'::text, 'price_change'::text])));

-- ---------------------------------------------------------------------------
-- 1.3 Sales
-- ---------------------------------------------------------------------------
create table if not exists transactions (
  id uuid not null default gen_random_uuid(),
  branch_id uuid not null,
  staff_id uuid,
  total_amount numeric(10,2) not null,
  amount_tendered numeric(10,2),
  change_given numeric(10,2),
  status text not null default 'completed'::text,
  void_reason text,
  created_at timestamp with time zone not null default now(),
  or_number text,
  client_id text,
  voided_at timestamp with time zone,
  voided_by uuid,
  order_type text,
  ulam_combo text,
  payment_method text not null default 'cash'::text,
  payment_reference text,
  void_approved_by uuid,
  vat_amount numeric(12,2) not null default 0,
  vatable_sales numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  discount_type text,
  discount_id_note text,
  refunded_amount numeric(12,2) not null default 0,
  vat_exempt_sales numeric(12,2) not null default 0,
  zero_rated_sales numeric(12,2) not null default 0,
  sc_pwd_discount numeric(12,2) not null default 0,
  vat_rate_applied numeric(6,4) not null default 0.12,
  shift_id uuid
);
alter table transactions add constraint transactions_pkey primary key (id);
alter table transactions add constraint transactions_order_type_check check (((order_type IS NULL) OR (order_type = ANY (ARRAY['dine_in'::text, 'takeout'::text]))));
alter table transactions add constraint transactions_payment_method_check check ((payment_method = ANY (ARRAY['cash'::text, 'card'::text, 'ewallet'::text])));
alter table transactions add constraint transactions_status_check check ((status = ANY (ARRAY['completed'::text, 'voided'::text])));
alter table transactions add constraint transactions_total_amount_check check ((total_amount >= (0)::numeric));
-- NOT VALID: enforced for all new/updated rows, but existing rows at the time
-- this constraint was added were not backfill-checked (BIR VAT breakdown
-- rollout migration). Reproduced exactly.
alter table transactions add constraint transactions_vat_breakdown_sane_check check ((abs(((total_amount + sc_pwd_discount) - (((vatable_sales + vat_amount) + vat_exempt_sales) + zero_rated_sales))) < 1.00)) not valid;

create table if not exists transaction_items (
  id uuid not null default gen_random_uuid(),
  transaction_id uuid not null,
  product_id uuid not null,
  quantity numeric(10,2) not null,
  unit_price numeric(10,2) not null,
  line_total numeric(10,2) not null,
  price_tier text,
  discount_eligible boolean not null default false,
  discount_amount numeric(10,2) not null default 0,
  promo_name text,
  vat_category text not null default 'vatable'::text,
  promo_group_id uuid
);
alter table transaction_items add constraint transaction_items_pkey primary key (id);
alter table transaction_items add constraint transaction_items_price_tier_check check (((price_tier IS NULL) OR (price_tier = ANY (ARRAY['regular'::text, 'budget'::text]))));
alter table transaction_items add constraint transaction_items_quantity_check check ((quantity > (0)::numeric));
alter table transaction_items add constraint transaction_items_vat_category_check check ((vat_category = ANY (ARRAY['vatable'::text, 'exempt'::text, 'zero_rated'::text])));

create table if not exists sale_events (
  id uuid not null default gen_random_uuid(),
  branch_id uuid not null,
  transaction_id uuid,
  staff_id uuid,
  event_type text not null,
  or_number text,
  reason text,
  amount numeric(10,2),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);
alter table sale_events add constraint sale_events_pkey primary key (id);
alter table sale_events add constraint sale_events_event_type_check check ((event_type = ANY (ARRAY['sale'::text, 'void'::text, 'refund'::text, 'reprint'::text])));

create table if not exists sale_refund_lines (
  id uuid not null default gen_random_uuid(),
  branch_id uuid not null,
  transaction_id uuid not null,
  transaction_item_id uuid not null,
  product_id uuid,
  quantity numeric(12,3) not null,
  amount numeric(12,2) not null default 0,
  staff_id uuid,
  approved_by uuid,
  reason text not null default ''::text,
  created_at timestamp with time zone not null default now()
);
alter table sale_refund_lines add constraint sale_refund_lines_pkey primary key (id);
alter table sale_refund_lines add constraint sale_refund_lines_quantity_check check ((quantity > (0)::numeric));

create table if not exists refund_requests (
  id uuid not null default gen_random_uuid(),
  transaction_id uuid not null,
  branch_id uuid not null,
  mode text not null,
  reason text not null,
  items jsonb,
  status text not null default 'pending'::text,
  requested_by uuid not null,
  requested_at timestamp with time zone not null default now(),
  approved_by uuid,
  approved_at timestamp with time zone,
  reject_reason text
);
alter table refund_requests add constraint refund_requests_pkey primary key (id);
alter table refund_requests add constraint refund_requests_mode_check check ((mode = ANY (ARRAY['full'::text, 'items'::text])));
alter table refund_requests add constraint refund_requests_status_check check ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])));

-- ---------------------------------------------------------------------------
-- 1.4 Promos
-- ---------------------------------------------------------------------------
create table if not exists promo_events (
  id uuid not null default gen_random_uuid(),
  branch_id uuid not null,
  name text not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  status text default 'pending'::text,
  requested_by uuid,
  approved_by uuid,
  approved_at timestamp with time zone,
  stop_requested_by uuid,
  stop_reason text,
  stopped_by uuid,
  stopped_at timestamp with time zone,
  description text,
  reject_reason text,
  supersedes_event_id uuid
);
alter table promo_events add constraint promo_events_pkey primary key (id);
alter table promo_events add constraint promo_events_status_check check ((status = ANY (ARRAY['draft'::text, 'pending'::text, 'active'::text, 'rejected'::text, 'stop_pending'::text, 'stopped'::text, 'expired'::text])));

create table if not exists promo_rules (
  id uuid not null default gen_random_uuid(),
  promo_event_id uuid not null,
  rule_type text not null,
  discount_pct numeric(5,2) not null,
  buy_qty numeric(10,2) not null default 1,
  get_qty numeric(10,2) not null default 1,
  created_at timestamp with time zone not null default now(),
  bundle_name text
);
alter table promo_rules add constraint promo_rules_pkey primary key (id);
alter table promo_rules add constraint promo_rules_buy_qty_check check ((buy_qty > (0)::numeric));
alter table promo_rules add constraint promo_rules_discount_pct_check check (((discount_pct >= (0)::numeric) AND (discount_pct <= (100)::numeric)));
alter table promo_rules add constraint promo_rules_get_qty_check check ((get_qty > (0)::numeric));
alter table promo_rules add constraint promo_rules_rule_type_check check ((rule_type = ANY (ARRAY['item_pct'::text, 'pair_pct'::text, 'bundle_pct'::text, 'bogo_pct'::text])));

create table if not exists promo_rule_products (
  id uuid not null default gen_random_uuid(),
  promo_rule_id uuid not null,
  product_id uuid not null,
  product_index integer not null default 0,
  quantity_required numeric(10,2) not null default 1
);
alter table promo_rule_products add constraint promo_rule_products_pkey primary key (id);
alter table promo_rule_products add constraint promo_rule_products_quantity_required_check check ((quantity_required > (0)::numeric));

-- ---------------------------------------------------------------------------
-- 1.5 Day-end & imports
-- ---------------------------------------------------------------------------
create table if not exists day_ends (
  id uuid not null default gen_random_uuid(),
  branch_id uuid not null,
  staff_id uuid,
  business_date date not null,
  recorded_cash numeric(10,2) not null default 0,
  cash_on_hand numeric(10,2) not null default 0,
  variance numeric(10,2) not null default 0,
  note text,
  closed_at timestamp with time zone,
  status text not null default 'closed'::text,
  reopened_at timestamp with time zone,
  reopened_by uuid,
  day_report jsonb,
  expected_cash numeric(10,2),
  submitted_at timestamp with time zone,
  submitted_by uuid,
  approved_at timestamp with time zone,
  approved_by uuid,
  reopen_reason text,
  requested_at timestamp with time zone,
  requested_by uuid,
  request_manager boolean not null default false,
  rejected_at timestamp with time zone,
  rejected_by uuid,
  reject_reason text,
  reopen_requested_at timestamp with time zone,
  reopen_requested_by uuid,
  reopen_request_reason text
);
alter table day_ends add constraint day_ends_pkey primary key (id);
alter table day_ends add constraint day_ends_branch_id_business_date_key unique (branch_id, business_date);
alter table day_ends add constraint day_ends_status_check check ((status = ANY (ARRAY['requested'::text, 'submitted'::text, 'closed'::text, 'reopened'::text, 'rejected'::text])));

create table if not exists import_batches (
  id uuid not null default gen_random_uuid(),
  branch_id uuid not null,
  staff_id uuid,
  filename text not null,
  file_hash text not null,
  row_count integer not null default 0,
  created_count integer not null default 0,
  updated_count integer not null default 0,
  skipped_count integer not null default 0,
  status text not null default 'committed'::text,
  created_at timestamp with time zone not null default now(),
  reverted_at timestamp with time zone,
  reverted_by uuid,
  revert_requested_by uuid,
  revert_requested_at timestamp with time zone
);
alter table import_batches add constraint import_batches_pkey primary key (id);
alter table import_batches add constraint import_batches_status_check check ((status = ANY (ARRAY['committed'::text, 'revert_requested'::text, 'reverted'::text])));

create table if not exists import_batch_items (
  id uuid not null default gen_random_uuid(),
  batch_id uuid not null,
  product_id uuid not null,
  action text not null,
  quantity_added numeric(10,2) not null default 0,
  name text,
  sku text,
  barcode text
);
alter table import_batch_items add constraint import_batch_items_pkey primary key (id);
alter table import_batch_items add constraint import_batch_items_action_check check ((action = ANY (ARRAY['create'::text, 'restock'::text])));

-- ---------------------------------------------------------------------------
-- 1.6 Shifts & cash accountability
-- ---------------------------------------------------------------------------
create table if not exists staff_shifts (
  id uuid not null default gen_random_uuid(),
  branch_id uuid not null,
  staff_id uuid not null,
  clock_in timestamp with time zone not null default now(),
  clock_out timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  drawer_id text not null default 'main'::text,
  drawer_label text,
  holds_drawer boolean not null default true,
  business_date date,
  starting_cash numeric(12,2),
  carried_from_shift_id uuid,
  carried_amount numeric(12,2),
  ending_cash numeric(12,2),
  expected_cash numeric(12,2),
  variance numeric(12,2),
  cash_sales numeric(12,2),
  cash_refunds numeric(12,2),
  cash_paid_out numeric(12,2),
  cash_pickups numeric(12,2),
  close_note text,
  closed_by uuid,
  client_id text,
  shift_period text
);
alter table staff_shifts add constraint staff_shifts_pkey primary key (id);
alter table staff_shifts add constraint staff_shifts_shift_period_check check (((shift_period IS NULL) OR (shift_period = ANY (ARRAY['am'::text, 'pm'::text]))));

-- cash_drawer_entries: current name for what used to be `petty_cash`
-- (migrate_rename_petty_cash_to_cash_drawer_entries.sql) — constraint/index
-- names below still carry the legacy `petty_cash_*` prefix on the live DB,
-- reproduced exactly rather than renamed.
create table if not exists cash_drawer_entries (
  id uuid not null default gen_random_uuid(),
  branch_id uuid not null,
  staff_id uuid,
  amount numeric(12,2) not null,
  reason text not null default ''::text,
  business_date date not null default ((timezone('Asia/Manila'::text, now()))::date),
  created_at timestamp with time zone not null default now(),
  kind text not null default 'paid_out'::text,
  status text not null default 'approved'::text,
  receipt_ref text,
  shift_id uuid,
  requested_by uuid,
  approved_by uuid,
  approved_at timestamp with time zone,
  confirmed_by uuid,
  confirmed_at timestamp with time zone,
  reject_reason text
);
alter table cash_drawer_entries add constraint petty_cash_pkey primary key (id);
alter table cash_drawer_entries add constraint cash_drawer_entries_kind_check check ((kind = ANY (ARRAY['change_fund'::text, 'pickup'::text, 'paid_out'::text])));
alter table cash_drawer_entries add constraint cash_drawer_entries_status_check check ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'recorded'::text, 'fulfilled'::text])));
alter table cash_drawer_entries add constraint cash_drawer_entries_fulfil_needs_approval check (((status <> 'fulfilled'::text) OR ((approved_by IS NOT NULL) AND (approved_at IS NOT NULL)))) not valid;

create table if not exists shift_adjustments (
  id uuid not null default gen_random_uuid(),
  shift_id uuid not null,
  branch_id uuid not null,
  field text not null,
  old_value numeric(12,2),
  new_value numeric(12,2) not null,
  reason text not null,
  adjusted_by uuid,
  approved_by uuid,
  created_at timestamp with time zone not null default now()
);
alter table shift_adjustments add constraint shift_adjustments_pkey primary key (id);
alter table shift_adjustments add constraint shift_adjustments_field_check check ((field = ANY (ARRAY['starting_cash'::text, 'ending_cash'::text])));

-- cash_movements: POS "Open Drawer" petty/pickup/cash-in ledger during an
-- open shift (distinct from cash_drawer_entries, which is the older
-- end-of-shift-only petty cash flow) — see migrate_cash_movements.sql.
create table if not exists cash_movements (
  id uuid not null default gen_random_uuid(),
  client_id uuid,
  shift_id uuid not null,
  branch_id uuid not null,
  drawer_id text not null default 'main'::text,
  drawer_label text not null default 'Main drawer'::text,
  type text not null,
  amount numeric(12,2) not null,
  reason text not null,
  requested_by uuid not null,
  requested_at timestamp with time zone not null default now(),
  status text not null default 'pending_remote'::text,
  approved_by uuid,
  approved_at timestamp with time zone,
  denied_by uuid,
  denied_at timestamp with time zone,
  self_record_ack boolean not null default false,
  self_recorded_at timestamp with time zone,
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  review_action text,
  review_notes text,
  created_offline boolean not null default false,
  synced_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);
alter table cash_movements add constraint cash_movements_pkey primary key (id);
alter table cash_movements add constraint cash_movements_client_id_key unique (client_id);
alter table cash_movements add constraint cash_movements_amount_check check ((amount > (0)::numeric));
alter table cash_movements add constraint cash_movements_reason_check check ((length(TRIM(BOTH FROM reason)) > 0));
alter table cash_movements add constraint cash_movements_review_action_check check (((review_action IS NULL) OR (review_action = ANY (ARRAY['confirmed'::text, 'flagged_for_investigation'::text]))));
alter table cash_movements add constraint cash_movements_reviewer_not_requester check (((reviewed_by IS NULL) OR (reviewed_by IS DISTINCT FROM requested_by)));
alter table cash_movements add constraint cash_movements_status_check check ((status = ANY (ARRAY['pending_remote'::text, 'approved'::text, 'remote_approved'::text, 'denied'::text, 'self_recorded'::text, 'confirmed'::text, 'flagged_for_investigation'::text, 'voided'::text])));
alter table cash_movements add constraint cash_movements_type_check check ((type = ANY (ARRAY['petty_cash'::text, 'pickup'::text, 'cash_in'::text, 'opening_float'::text])));

-- ---------------------------------------------------------------------------
-- 1.7 Till actions, presence / devices
-- ---------------------------------------------------------------------------
create table if not exists till_action_requests (
  id uuid not null default gen_random_uuid(),
  client_id uuid,
  branch_id uuid not null,
  action text not null,
  detail text not null default ''::text,
  meta jsonb not null default '{}'::jsonb,
  status text not null default 'pending'::text,
  requested_by uuid not null,
  requested_at timestamp with time zone not null default now(),
  resolved_by uuid,
  resolved_at timestamp with time zone,
  self_record_ack boolean not null default false,
  created_at timestamp with time zone not null default now()
);
alter table till_action_requests add constraint till_action_requests_pkey primary key (id);
alter table till_action_requests add constraint till_action_requests_client_id_key unique (client_id);
alter table till_action_requests add constraint till_action_requests_action_check check ((action = 'cart_line_remove'::text));
alter table till_action_requests add constraint till_action_requests_status_check check ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'self_allowed'::text, 'cancelled'::text])));

create table if not exists branch_presence (
  branch_id uuid not null,
  staff_id uuid,
  last_seen_at timestamp with time zone not null default now(),
  is_online boolean not null default true,
  app_version text,
  user_agent text,
  updated_at timestamp with time zone not null default now()
);
alter table branch_presence add constraint branch_presence_pkey primary key (branch_id);

create table if not exists branch_devices (
  branch_id uuid not null,
  device_key text not null,
  state text not null default 'disconnected'::text,
  detail text,
  updated_at timestamp with time zone not null default now()
);
alter table branch_devices add constraint branch_devices_pkey primary key (branch_id, device_key);
alter table branch_devices add constraint branch_devices_device_key_check check ((device_key = ANY (ARRAY['barcode_scanner'::text, 'receipt_printer'::text, 'cash_drawer'::text])));
alter table branch_devices add constraint branch_devices_state_check check ((state = ANY (ARRAY['disconnected'::text, 'connecting'::text, 'connected'::text, 'error'::text])));

-- ---------------------------------------------------------------------------
-- 1.8 Audit / security
-- ---------------------------------------------------------------------------
create table if not exists audit_events (
  id uuid not null default gen_random_uuid(),
  branch_id uuid,
  staff_id uuid,
  event_type text not null,
  detail text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);
alter table audit_events add constraint audit_events_pkey primary key (id);

-- Lockout state only — no client access at all (see RLS below); written by
-- SECURITY DEFINER RPCs (record_pin_login_failure / clear_pin_login_failures).
create table if not exists pin_login_attempts (
  login_code text not null,
  fail_count integer not null default 0,
  locked_until timestamp with time zone,
  last_attempt_at timestamp with time zone not null default now()
);
alter table pin_login_attempts add constraint pin_login_attempts_pkey primary key (login_code);

-- Singleton settings row (id is always `true`, enforced by the CHECK below).
create table if not exists company_profile (
  id boolean not null default true,
  business_name text,
  tin text,
  address text,
  updated_at timestamp with time zone not null default now(),
  idle_lock_minutes integer not null default 10
);
alter table company_profile add constraint company_profile_pkey primary key (id);
alter table company_profile add constraint company_profile_id_check check (id);
alter table company_profile add constraint company_profile_idle_lock_minutes_chk check ((idle_lock_minutes = ANY (ARRAY[5, 10, 15])));

-- =============================================================================
-- 2. FOREIGN KEYS (single pass, after every table exists)
-- =============================================================================
alter table staff add constraint staff_auth_user_id_fkey foreign key (auth_user_id) references auth.users(id) on delete cascade;
alter table staff add constraint staff_branch_id_fkey foreign key (branch_id) references branches(id) on delete restrict;
alter table staff add constraint staff_role_fkey foreign key (role) references roles(name) on update cascade on delete restrict;

alter table catalog_products add constraint catalog_products_category_id_fkey foreign key (category_id) references categories(id) on delete set null;

alter table products add constraint products_branch_id_fkey foreign key (branch_id) references branches(id) on delete cascade;
alter table products add constraint products_catalog_product_id_fkey foreign key (catalog_product_id) references catalog_products(id) on delete set null;
alter table products add constraint products_category_id_fkey foreign key (category_id) references categories(id) on delete set null;

alter table branch_inventory add constraint branch_inventory_branch_id_fkey foreign key (branch_id) references branches(id) on delete cascade;
alter table branch_inventory add constraint branch_inventory_product_id_fkey foreign key (product_id) references products(id) on delete cascade;

alter table stock_movements add constraint stock_movements_branch_id_fkey foreign key (branch_id) references branches(id) on delete cascade;
alter table stock_movements add constraint stock_movements_product_id_fkey foreign key (product_id) references products(id) on delete cascade;
alter table stock_movements add constraint stock_movements_staff_id_fkey foreign key (staff_id) references staff(id) on delete set null;

alter table transactions add constraint transactions_branch_id_fkey foreign key (branch_id) references branches(id) on delete restrict;
alter table transactions add constraint transactions_shift_id_fkey foreign key (shift_id) references staff_shifts(id) on delete set null;
alter table transactions add constraint transactions_staff_id_fkey foreign key (staff_id) references staff(id) on delete set null;
alter table transactions add constraint transactions_void_approved_by_fkey foreign key (void_approved_by) references staff(id) on delete set null;
alter table transactions add constraint transactions_voided_by_fkey foreign key (voided_by) references staff(id) on delete set null;

alter table transaction_items add constraint transaction_items_product_id_fkey foreign key (product_id) references products(id) on delete restrict;
alter table transaction_items add constraint transaction_items_transaction_id_fkey foreign key (transaction_id) references transactions(id) on delete cascade;

alter table sale_events add constraint sale_events_branch_id_fkey foreign key (branch_id) references branches(id) on delete cascade;
alter table sale_events add constraint sale_events_staff_id_fkey foreign key (staff_id) references staff(id) on delete set null;
alter table sale_events add constraint sale_events_transaction_id_fkey foreign key (transaction_id) references transactions(id) on delete set null;

alter table sale_refund_lines add constraint sale_refund_lines_approved_by_fkey foreign key (approved_by) references staff(id) on delete set null;
alter table sale_refund_lines add constraint sale_refund_lines_branch_id_fkey foreign key (branch_id) references branches(id) on delete cascade;
alter table sale_refund_lines add constraint sale_refund_lines_product_id_fkey foreign key (product_id) references products(id) on delete set null;
alter table sale_refund_lines add constraint sale_refund_lines_staff_id_fkey foreign key (staff_id) references staff(id) on delete set null;
alter table sale_refund_lines add constraint sale_refund_lines_transaction_id_fkey foreign key (transaction_id) references transactions(id) on delete cascade;
alter table sale_refund_lines add constraint sale_refund_lines_transaction_item_id_fkey foreign key (transaction_item_id) references transaction_items(id) on delete restrict;

alter table refund_requests add constraint refund_requests_approved_by_fkey foreign key (approved_by) references staff(id);
alter table refund_requests add constraint refund_requests_branch_id_fkey foreign key (branch_id) references branches(id);
alter table refund_requests add constraint refund_requests_requested_by_fkey foreign key (requested_by) references staff(id);
alter table refund_requests add constraint refund_requests_transaction_id_fkey foreign key (transaction_id) references transactions(id);

alter table promo_events add constraint promo_events_approved_by_fkey foreign key (approved_by) references staff(id) on delete set null;
alter table promo_events add constraint promo_events_branch_id_fkey foreign key (branch_id) references branches(id) on delete cascade;
alter table promo_events add constraint promo_events_requested_by_fkey foreign key (requested_by) references staff(id) on delete set null;
alter table promo_events add constraint promo_events_stop_requested_by_fkey foreign key (stop_requested_by) references staff(id) on delete set null;
alter table promo_events add constraint promo_events_stopped_by_fkey foreign key (stopped_by) references staff(id) on delete set null;
alter table promo_events add constraint promo_events_supersedes_event_id_fkey foreign key (supersedes_event_id) references promo_events(id) on delete set null;

alter table promo_rules add constraint promo_rules_promo_event_id_fkey foreign key (promo_event_id) references promo_events(id) on delete cascade;

alter table promo_rule_products add constraint promo_rule_products_product_id_fkey foreign key (product_id) references products(id) on delete restrict;
alter table promo_rule_products add constraint promo_rule_products_promo_rule_id_fkey foreign key (promo_rule_id) references promo_rules(id) on delete cascade;

alter table day_ends add constraint day_ends_approved_by_fkey foreign key (approved_by) references staff(id) on delete set null;
alter table day_ends add constraint day_ends_branch_id_fkey foreign key (branch_id) references branches(id) on delete cascade;
alter table day_ends add constraint day_ends_rejected_by_fkey foreign key (rejected_by) references staff(id) on delete set null;
alter table day_ends add constraint day_ends_reopen_requested_by_fkey foreign key (reopen_requested_by) references staff(id);
alter table day_ends add constraint day_ends_reopened_by_fkey foreign key (reopened_by) references staff(id) on delete set null;
alter table day_ends add constraint day_ends_requested_by_fkey foreign key (requested_by) references staff(id) on delete set null;
alter table day_ends add constraint day_ends_staff_id_fkey foreign key (staff_id) references staff(id) on delete set null;
alter table day_ends add constraint day_ends_submitted_by_fkey foreign key (submitted_by) references staff(id) on delete set null;

alter table import_batches add constraint import_batches_branch_id_fkey foreign key (branch_id) references branches(id) on delete cascade;
alter table import_batches add constraint import_batches_revert_requested_by_fkey foreign key (revert_requested_by) references staff(id) on delete set null;
alter table import_batches add constraint import_batches_reverted_by_fkey foreign key (reverted_by) references staff(id) on delete set null;
alter table import_batches add constraint import_batches_staff_id_fkey foreign key (staff_id) references staff(id) on delete set null;

alter table import_batch_items add constraint import_batch_items_batch_id_fkey foreign key (batch_id) references import_batches(id) on delete cascade;
alter table import_batch_items add constraint import_batch_items_product_id_fkey foreign key (product_id) references products(id) on delete restrict;

alter table staff_shifts add constraint staff_shifts_branch_id_fkey foreign key (branch_id) references branches(id) on delete cascade;
alter table staff_shifts add constraint staff_shifts_carried_from_shift_id_fkey foreign key (carried_from_shift_id) references staff_shifts(id) on delete set null;
alter table staff_shifts add constraint staff_shifts_closed_by_fkey foreign key (closed_by) references staff(id) on delete set null;
alter table staff_shifts add constraint staff_shifts_staff_id_fkey foreign key (staff_id) references staff(id) on delete cascade;

alter table cash_drawer_entries add constraint petty_cash_approved_by_fkey foreign key (approved_by) references staff(id) on delete set null;
alter table cash_drawer_entries add constraint petty_cash_branch_id_fkey foreign key (branch_id) references branches(id) on delete cascade;
alter table cash_drawer_entries add constraint petty_cash_confirmed_by_fkey foreign key (confirmed_by) references staff(id) on delete set null;
alter table cash_drawer_entries add constraint petty_cash_requested_by_fkey foreign key (requested_by) references staff(id) on delete set null;
alter table cash_drawer_entries add constraint petty_cash_shift_id_fkey foreign key (shift_id) references staff_shifts(id) on delete set null;
alter table cash_drawer_entries add constraint petty_cash_staff_id_fkey foreign key (staff_id) references staff(id) on delete set null;

alter table shift_adjustments add constraint shift_adjustments_adjusted_by_fkey foreign key (adjusted_by) references staff(id) on delete set null;
alter table shift_adjustments add constraint shift_adjustments_approved_by_fkey foreign key (approved_by) references staff(id) on delete set null;
alter table shift_adjustments add constraint shift_adjustments_branch_id_fkey foreign key (branch_id) references branches(id) on delete cascade;
alter table shift_adjustments add constraint shift_adjustments_shift_id_fkey foreign key (shift_id) references staff_shifts(id) on delete cascade;

alter table cash_movements add constraint cash_movements_approved_by_fkey foreign key (approved_by) references staff(id);
alter table cash_movements add constraint cash_movements_branch_id_fkey foreign key (branch_id) references branches(id);
alter table cash_movements add constraint cash_movements_denied_by_fkey foreign key (denied_by) references staff(id);
alter table cash_movements add constraint cash_movements_requested_by_fkey foreign key (requested_by) references staff(id);
alter table cash_movements add constraint cash_movements_reviewed_by_fkey foreign key (reviewed_by) references staff(id);
alter table cash_movements add constraint cash_movements_shift_id_fkey foreign key (shift_id) references staff_shifts(id) on delete restrict;

alter table till_action_requests add constraint till_action_requests_branch_id_fkey foreign key (branch_id) references branches(id);
alter table till_action_requests add constraint till_action_requests_requested_by_fkey foreign key (requested_by) references staff(id);
alter table till_action_requests add constraint till_action_requests_resolved_by_fkey foreign key (resolved_by) references staff(id);

alter table branch_presence add constraint branch_presence_branch_id_fkey foreign key (branch_id) references branches(id) on delete cascade;
alter table branch_presence add constraint branch_presence_staff_id_fkey foreign key (staff_id) references staff(id) on delete set null;

alter table branch_devices add constraint branch_devices_branch_id_fkey foreign key (branch_id) references branches(id) on delete cascade;

alter table audit_events add constraint audit_events_branch_id_fkey foreign key (branch_id) references branches(id) on delete set null;
alter table audit_events add constraint audit_events_staff_id_fkey foreign key (staff_id) references staff(id) on delete set null;

-- =============================================================================
-- 3. INDEXES
--    (excludes any index that already backs a PK/UNIQUE constraint above —
--    those are created automatically by section 1/2)
-- =============================================================================
create index if not exists idx_staff_branch on staff using btree (branch_id);
create unique index if not exists staff_login_code_uidx on staff using btree (login_code) where ((login_code is not null) and (login_code <> ''::text));

create index if not exists idx_catalog_products_branch_type on catalog_products using btree (branch_type);
create unique index if not exists uq_catalog_products_barcode on catalog_products using btree (barcode) where ((barcode is not null) and (barcode <> ''::text));

create index if not exists idx_products_branch on products using btree (branch_id);
create index if not exists idx_products_catalog on products using btree (catalog_product_id);

create index if not exists idx_stock_movements_branch_created on stock_movements using btree (branch_id, created_at desc);
create index if not exists idx_stock_movements_product on stock_movements using btree (product_id);

create index if not exists idx_transactions_branch_created on transactions using btree (branch_id, created_at desc);
create index if not exists idx_transactions_shift on transactions using btree (shift_id) where (shift_id is not null);
create index if not exists idx_transactions_staff_created on transactions using btree (staff_id, created_at desc);
create unique index if not exists uq_transactions_branch_client on transactions using btree (branch_id, client_id) where (client_id is not null);
create unique index if not exists uq_transactions_branch_or on transactions using btree (branch_id, or_number) where (or_number is not null);

create index if not exists idx_transaction_items_product on transaction_items using btree (product_id);
create index if not exists idx_transaction_items_promo_name on transaction_items using btree (promo_name) where (promo_name is not null);
create index if not exists idx_transaction_items_txn on transaction_items using btree (transaction_id);

create index if not exists idx_sale_events_branch_created on sale_events using btree (branch_id, created_at desc);
create index if not exists idx_sale_events_txn on sale_events using btree (transaction_id);

create index if not exists idx_sale_refund_lines_branch on sale_refund_lines using btree (branch_id);
create index if not exists idx_sale_refund_lines_item on sale_refund_lines using btree (transaction_item_id);
create index if not exists idx_sale_refund_lines_txn on sale_refund_lines using btree (transaction_id);

create index if not exists idx_refund_requests_branch_status on refund_requests using btree (branch_id, status);
create unique index if not exists uq_refund_requests_pending_txn on refund_requests using btree (transaction_id) where (status = 'pending'::text);

create index if not exists idx_promo_events_branch on promo_events using btree (branch_id);
create index if not exists idx_promo_events_status_branch on promo_events using btree (branch_id, status);
create index if not exists idx_promo_events_supersedes on promo_events using btree (supersedes_event_id) where (supersedes_event_id is not null);

create index if not exists idx_promo_rules_event on promo_rules using btree (promo_event_id);

create index if not exists idx_promo_rule_products_rule on promo_rule_products using btree (promo_rule_id);

create index if not exists idx_day_ends_branch_date on day_ends using btree (branch_id, business_date desc);

create index if not exists idx_import_batches_branch_created on import_batches using btree (branch_id, created_at desc);
create index if not exists idx_import_batches_branch_hash on import_batches using btree (branch_id, file_hash, created_at desc);

create index if not exists idx_import_batch_items_batch on import_batch_items using btree (batch_id);

create index if not exists idx_staff_shifts_branch_created on staff_shifts using btree (branch_id, created_at desc);
create index if not exists idx_staff_shifts_branch_date on staff_shifts using btree (branch_id, business_date desc);
create index if not exists idx_staff_shifts_open_staff on staff_shifts using btree (staff_id, drawer_id) where (clock_out is null);
create index if not exists idx_staff_shifts_staff on staff_shifts using btree (staff_id);
create unique index if not exists uq_staff_shifts_client_id on staff_shifts using btree (client_id) where (client_id is not null);
create unique index if not exists uq_staff_shifts_open_drawer on staff_shifts using btree (branch_id, drawer_id) where ((clock_out is null) and holds_drawer);

create index if not exists idx_cash_drawer_entries_open on cash_drawer_entries using btree (branch_id, status, created_at desc) where ((kind = 'paid_out'::text) and (status = ANY (ARRAY['pending'::text, 'approved'::text])));
create index if not exists idx_cash_drawer_entries_status_kind on cash_drawer_entries using btree (branch_id, status, kind);
create unique index if not exists uq_cash_drawer_entries_change_fund_shift on cash_drawer_entries using btree (shift_id) where ((kind = 'change_fund'::text) and (shift_id is not null));

create index if not exists idx_shift_adjustments_shift on shift_adjustments using btree (shift_id, created_at desc);

create index if not exists idx_cash_movements_branch_status on cash_movements using btree (branch_id, status);
create index if not exists idx_cash_movements_pending on cash_movements using btree (branch_id, requested_at desc) where (status = 'pending_remote'::text);
create index if not exists idx_cash_movements_requested_at on cash_movements using btree (requested_at desc);
create index if not exists idx_cash_movements_shift on cash_movements using btree (shift_id);

create index if not exists idx_till_action_requests_pending on till_action_requests using btree (branch_id, requested_at desc) where (status = 'pending'::text);
create index if not exists idx_till_action_requests_requested_by on till_action_requests using btree (requested_by);
create index if not exists idx_till_action_requests_resolved_by on till_action_requests using btree (resolved_by);

create index if not exists idx_audit_events_branch on audit_events using btree (branch_id, created_at desc);
create index if not exists idx_audit_events_created on audit_events using btree (created_at desc);
create index if not exists idx_audit_events_offline_client_id on audit_events using btree (((meta ->> 'offline_client_id'::text))) where ((meta ->> 'offline_client_id'::text) is not null);
create index if not exists idx_audit_events_staff on audit_events using btree (staff_id, created_at desc);

-- =============================================================================
-- 4. ROW LEVEL SECURITY — enable on every table (all 29 are RLS-enabled live)
-- =============================================================================
alter table branches enable row level security;
alter table roles enable row level security;
alter table staff enable row level security;
alter table categories enable row level security;
alter table catalog_products enable row level security;
alter table products enable row level security;
alter table branch_inventory enable row level security;
alter table stock_movements enable row level security;
alter table transactions enable row level security;
alter table transaction_items enable row level security;
alter table sale_events enable row level security;
alter table sale_refund_lines enable row level security;
alter table refund_requests enable row level security;
alter table promo_events enable row level security;
alter table promo_rules enable row level security;
alter table promo_rule_products enable row level security;
alter table day_ends enable row level security;
alter table import_batches enable row level security;
alter table import_batch_items enable row level security;
alter table staff_shifts enable row level security;
alter table cash_drawer_entries enable row level security;
alter table shift_adjustments enable row level security;
alter table cash_movements enable row level security;
alter table till_action_requests enable row level security;
alter table branch_presence enable row level security;
alter table branch_devices enable row level security;
alter table audit_events enable row level security;
alter table pin_login_attempts enable row level security;
alter table company_profile enable row level security;

-- =============================================================================
-- 5. FUNCTIONS
--    Emitted verbatim from pg_get_functiondef() — alphabetical order (safe:
--    Postgres does not validate inter-function references at CREATE time for
--    either `language sql` or `language plpgsql` bodies, so creation order
--    among these does not matter). SECURITY DEFINER functions are this app's
--    real access-control boundary — every one of them re-checks the caller's
--    role/branch internally before doing anything, since RLS does not apply
--    inside a SECURITY DEFINER body.
--
--    EXECUTE grants: a newly created function is auto-granted EXECUTE to
--    PUBLIC by Postgres (which every role, including anon/authenticated,
--    inherits) — so a "default" function below has no grant statement at
--    all; that silence IS its grant state. A hardened function has an
--    explicit REVOKE immediately after its CREATE — see comments inline and
--    the summary in section 8.
-- =============================================================================

create or replace function public.adjust_shift_cash(p_shift_id uuid, p_field text, p_new_value numeric, p_reason text, p_approved_by uuid DEFAULT NULL::uuid)
 RETURNS staff_shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_shift public.staff_shifts%rowtype;
  v_old numeric(12,2);
  v_expected numeric(12,2);
  v_ending numeric(12,2);
  v_actor uuid := public.current_staff_id();
  v_row public.staff_shifts%rowtype;
begin
  if not public.is_supervisor_or_above() then
    raise exception 'SHIFT_NOT_ALLOWED: only a supervisor or manager can adjust a shift';
  end if;

  if p_field not in ('starting_cash', 'ending_cash') then
    raise exception 'SHIFT_BAD_FIELD: % cannot be adjusted', p_field;
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'SHIFT_REASON_REQUIRED: a written reason is required for an adjustment';
  end if;

  if p_new_value is null or p_new_value < 0 then
    raise exception 'SHIFT_BAD_AMOUNT: the corrected amount must be zero or more';
  end if;

  select * into v_shift from public.staff_shifts where id = p_shift_id;
  if not found then
    raise exception 'SHIFT_NOT_FOUND: no shift with id %', p_shift_id;
  end if;

  if not (v_shift.branch_id = public.current_staff_branch() or public.is_manager()) then
    raise exception 'SHIFT_NOT_ALLOWED: that shift belongs to another branch';
  end if;

  v_old := case when p_field = 'starting_cash' then v_shift.starting_cash else v_shift.ending_cash end;

  insert into public.shift_adjustments (
    shift_id, branch_id, field, old_value, new_value, reason, adjusted_by, approved_by
  ) values (
    p_shift_id, v_shift.branch_id, p_field, v_old, round(p_new_value, 2),
    trim(p_reason), v_actor, p_approved_by
  );

  -- Recompute the derived figures from whichever of the two counts just changed. The
  -- component totals (sales/refunds/paid-out/pickups) are untouched — an adjustment
  -- corrects a COUNT, never the sales record behind it.
  if p_field = 'starting_cash' then
    v_expected := round(
      round(p_new_value, 2) + coalesce(v_shift.cash_sales, 0) - coalesce(v_shift.cash_refunds, 0)
      - coalesce(v_shift.cash_paid_out, 0) - coalesce(v_shift.cash_pickups, 0), 2);
    v_ending := coalesce(v_shift.ending_cash, 0);
  else
    v_expected := coalesce(v_shift.expected_cash, 0);
    v_ending := round(p_new_value, 2);
  end if;

  perform set_config('calepos.shift_adjustment', 'on', true);

  update public.staff_shifts
  set starting_cash = case when p_field = 'starting_cash' then round(p_new_value, 2) else starting_cash end,
      ending_cash = case when p_field = 'ending_cash' then round(p_new_value, 2) else ending_cash end,
      expected_cash = case when clock_out is null then expected_cash else v_expected end,
      variance = case when clock_out is null then variance else round(v_ending - v_expected, 2) end
  where id = p_shift_id
  returning * into v_row;

  perform set_config('calepos.shift_adjustment', 'off', true);

  return v_row;
end $function$;
-- Hardened: money-moving RPC, callable only by an authenticated staff session.
revoke execute on function public.adjust_shift_cash(uuid, text, numeric, text, uuid) from public;
grant execute on function public.adjust_shift_cash(uuid, text, numeric, text, uuid) to authenticated;

create or replace function public.admin_active_sessions()
 RETURNS TABLE(staff_id uuid, full_name text, role text, branch_id uuid, branch_name text, session_heartbeat_at timestamp with time zone, is_stale boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select s.id,
         s.full_name,
         s.role,
         s.branch_id,
         b.name,
         s.session_heartbeat_at,
         -- Past the 15-minute window claim_staff_session() uses, so this row is no longer
         -- actually blocking anyone — shown so a master can tell a real live session from
         -- a leftover one before ejecting anybody.
         (s.session_heartbeat_at is null or s.session_heartbeat_at <= now() - interval '15 minutes')
  from public.staff s
  left join public.branches b on b.id = s.branch_id
  where s.active_session_id is not null
    and public.is_master()
  order by s.session_heartbeat_at desc nulls last;
$function$;

create or replace function public.admin_release_all_sessions(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count integer := 0;
  v_actor uuid;
begin
  if not public.is_master() then
    raise exception 'SESSION_NOT_ALLOWED: only a master account can force a sign-out';
  end if;

  select id into v_actor from public.staff where auth_user_id = auth.uid() limit 1;

  with released as (
    update public.staff
    set active_session_id = null,
        session_heartbeat_at = null
    where active_session_id is not null
      and (p_branch_id is null or branch_id = p_branch_id)
      -- Never eject the master doing this: they would immediately lock themselves out of
      -- the screen they are standing on.
      and id is distinct from v_actor
    returning 1
  )
  select count(*) into v_count from released;

  insert into public.audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    p_branch_id,
    v_actor,
    'session_force_release',
    'Forced sign-out of ' || v_count || ' account(s)',
    jsonb_build_object('scope', case when p_branch_id is null then 'all' else 'branch' end,
                       'released', v_count)
  );

  return v_count;
end;
$function$;

create or replace function public.admin_release_staff_session(p_staff_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_master() then
    raise exception 'SESSION_NOT_ALLOWED: only a master account can force a sign-out';
  end if;
  if p_staff_id is null then
    raise exception 'SESSION_TARGET_REQUIRED: pick an account';
  end if;

  update public.staff
  set active_session_id = null,
      session_heartbeat_at = null
  where id = p_staff_id;

  -- Who forced whom off, and when. A control that can eject a cashier mid-shift has to
  -- leave a trace, same as a void or a price override.
  insert into public.audit_events (branch_id, staff_id, event_type, detail, meta)
  select s.branch_id,
         (select id from public.staff where auth_user_id = auth.uid() limit 1),
         'session_force_release',
         'Forced sign-out of ' || coalesce(s.full_name, 'staff'),
         jsonb_build_object('target_staff_id', s.id, 'scope', 'one')
  from public.staff s
  where s.id = p_staff_id;

  return true;
end;
$function$;

create or replace function public.adopt_catalog_products(p_branch_id uuid, p_catalog_ids uuid[], p_staff_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
  v_cat catalog_products%rowtype;
  v_product_id uuid;
  v_count integer := 0;
  v_branch_type text;
begin
  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Not authorized for this branch';
  end if;

  select coalesce(branch_type, 'retail') into v_branch_type
  from branches where id = p_branch_id;

  foreach v_id in array p_catalog_ids
  loop
    select * into v_cat from catalog_products where id = v_id and is_active;
    if not found then
      continue;
    end if;

    if coalesce(v_cat.branch_type, 'retail') is distinct from coalesce(v_branch_type, 'retail') then
      continue;
    end if;

    -- Skip if branch already has this catalog product or same sku
    if exists (
      select 1 from products
      where branch_id = p_branch_id
        and (catalog_product_id = v_id or lower(trim(sku)) = lower(trim(v_cat.sku)))
    ) then
      continue;
    end if;

    insert into products (
      branch_id, catalog_product_id, category_id, name, sku, barcode,
      pricing_mode, price, budget_price, menu_kind,
      low_stock_threshold, medium_stock_threshold, discount_eligible, is_active
    ) values (
      p_branch_id, v_cat.id, v_cat.category_id, v_cat.name, v_cat.sku, v_cat.barcode,
      v_cat.pricing_mode, v_cat.price, v_cat.budget_price, v_cat.menu_kind,
      v_cat.low_stock_threshold, v_cat.medium_stock_threshold, v_cat.discount_eligible, true
    )
    returning id into v_product_id;

    insert into branch_inventory (branch_id, product_id, quantity_on_hand)
    values (p_branch_id, v_product_id, 0)
    on conflict (branch_id, product_id) do nothing;

    v_count := v_count + 1;
  end loop;

  if p_staff_id is not null and v_count > 0 then
    insert into audit_events (branch_id, staff_id, event_type, detail, meta)
    values (
      p_branch_id,
      p_staff_id,
      'catalog_adopt',
      'Adopted ' || v_count || ' catalog product(s) to branch',
      jsonb_build_object('count', v_count, 'catalog_ids', to_jsonb(p_catalog_ids))
    );
  end if;

  return v_count;
end;
$function$;

create or replace function public.allocate_or_number(p_branch_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_prefix text;
  v_next bigint;
  v_or text;
begin
  select or_prefix, or_next
  into v_prefix, v_next
  from branches
  where id = p_branch_id
  for update;

  if not found then
    raise exception 'Branch not found';
  end if;

  v_or := coalesce(nullif(v_prefix, ''), 'OR') || '-' || lpad(v_next::text, 8, '0');
  update branches set or_next = v_next + 1 where id = p_branch_id;
  return v_or;
end;
$function$;
-- Hardened: only reachable from within complete_sale()/reserve_or_number() flows.
revoke execute on function public.allocate_or_number(uuid) from public;
grant execute on function public.allocate_or_number(uuid) to authenticated;

create or replace function public.apply_counted_cash_movement_effects(p_row cash_movements)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_row is null or not public.cash_movement_counts(p_row.status) then
    return;
  end if;
  if p_row.type = 'opening_float' then
    update public.staff_shifts
    set starting_cash = round(p_row.amount, 2)
    where id = p_row.shift_id
      and coalesce(starting_cash, 0) = 0;
  end if;
end;
$function$;
-- Hardened: purely-internal helper called by the cash-movement RPCs — never
-- meant to be invoked directly by a client, so even `authenticated` is revoked.
revoke execute on function public.apply_counted_cash_movement_effects(cash_movements) from public;
revoke execute on function public.apply_counted_cash_movement_effects(cash_movements) from authenticated;

create or replace function public.approve_cash_movement_manager(p_id uuid, p_approved_by uuid)
 RETURNS cash_movements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.cash_movements%rowtype;
begin
  if not public.is_manager() then
    raise exception 'MOVE12: only managers can remotely approve';
  end if;

  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'pending_remote' then
    raise exception 'MOVE11: movement is not awaiting approval';
  end if;
  if p_approved_by is null then
    raise exception 'MOVE04: approver required';
  end if;

  perform public.validate_cash_movement_opening_float(v_row.shift_id, v_row.type);

  update public.cash_movements
  set status = 'remote_approved',
      approved_by = p_approved_by,
      approved_at = now()
  where id = p_id
  returning * into v_row;

  perform public.apply_counted_cash_movement_effects(v_row);

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_approved_by, 'cash_movement_remote_approved',
    'Remote-approved ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object('cash_movement_id', v_row.id, 'via', 'manager')
  );

  return v_row;
end;
$function$;

create or replace function public.approve_cash_movement_pin(p_id uuid, p_approved_by uuid)
 RETURNS cash_movements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.cash_movements%rowtype;
begin
  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'pending_remote' then
    raise exception 'MOVE11: movement is not awaiting approval';
  end if;
  if p_approved_by is null or p_approved_by = v_row.requested_by then
    raise exception 'MOVE04: supervisor approval required';
  end if;

  perform public.validate_cash_movement_opening_float(v_row.shift_id, v_row.type);

  update public.cash_movements
  set status = 'approved',
      approved_by = p_approved_by,
      approved_at = now()
  where id = p_id
  returning * into v_row;

  perform public.apply_counted_cash_movement_effects(v_row);

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_approved_by, 'cash_movement_approved',
    'PIN-approved ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object('cash_movement_id', v_row.id, 'via', 'pin')
  );

  return v_row;
end;
$function$;

create or replace function public.approve_day_end(p_day_end_id uuid, p_staff_id uuid)
 RETURNS day_ends
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.day_ends;
begin
  if not public.is_supervisor_or_above() then
    raise exception 'Only supervisors or managers can approve day close';
  end if;

  update day_ends
  set
    status = 'closed',
    approved_at = now(),
    approved_by = p_staff_id,
    closed_at = coalesce(closed_at, now())
  where id = p_day_end_id
    and status = 'submitted'
  returning * into v_row;

  if not found then
    raise exception 'No submitted day end found to approve';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id,
    p_staff_id,
    'day_end_approved',
    'Approved close for ' || v_row.business_date::text,
    jsonb_build_object(
      'day_end_id', v_row.id,
      'business_date', v_row.business_date,
      'variance', v_row.variance,
      'cash_on_hand', v_row.cash_on_hand
    )
  );

  return v_row;
end;
$function$;

create or replace function public.approve_promo_event(p_promo_event_id uuid, p_staff_id uuid)
 RETURNS promo_events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.promo_events;
  v_rule_count int;
begin
  if not public.is_manager() then
    raise exception 'Only managers can approve promos';
  end if;

  select count(*) into v_rule_count
  from promo_rules
  where promo_event_id = p_promo_event_id;

  if coalesce(v_rule_count, 0) < 1 then
    raise exception 'Promo must have at least one rule before approval';
  end if;

  select * into v_row
  from promo_events
  where id = p_promo_event_id
    and status = 'pending'
  for update;

  if not found then
    raise exception 'No pending promo found to approve';
  end if;

  if v_row.supersedes_event_id is not null then
    update promo_events
    set status = 'stopped',
        stopped_by = p_staff_id,
        stopped_at = coalesce(stopped_at, now())
    where id = v_row.supersedes_event_id
      and status in ('active', 'stop_pending');
  end if;

  update promo_events
  set status = 'active',
      approved_by = p_staff_id,
      approved_at = now()
  where id = p_promo_event_id
    and status = 'pending'
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'promo_approved',
    case
      when v_row.supersedes_event_id is not null then 'Approved promo edit: ' || v_row.name
      else 'Approved promo: ' || v_row.name
    end,
    jsonb_build_object(
      'promo_event_id', v_row.id,
      'supersedes_event_id', v_row.supersedes_event_id
    )
  );

  return v_row;
end;
$function$;

create or replace function public.approve_refund_request(p_request_id uuid, p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_req public.refund_requests;
  v_result jsonb;
begin
  if not public.is_manager() then
    raise exception 'Only managers can approve refund requests';
  end if;

  select * into v_req from refund_requests where id = p_request_id and status = 'pending' for update;
  if not found then
    raise exception 'No pending refund request found';
  end if;

  if v_req.mode = 'full' then
    perform public.void_sale_secure(v_req.transaction_id, v_req.requested_by, v_req.reason, p_staff_id);
    v_result := jsonb_build_object('ok', true, 'fully_voided', true);
  else
    select public.refund_sale_items(v_req.transaction_id, v_req.requested_by, v_req.reason, v_req.items, p_staff_id)
      into v_result;
  end if;

  update refund_requests
  set status = 'approved', approved_by = p_staff_id, approved_at = now()
  where id = p_request_id;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_req.branch_id, p_staff_id, 'refund_request_approved',
    'Approved refund request on ' || v_req.transaction_id::text,
    jsonb_build_object('refund_request_id', v_req.id, 'transaction_id', v_req.transaction_id)
  );

  return v_result;
end;
$function$;

create or replace function public.approve_stop_promo(p_promo_event_id uuid, p_staff_id uuid)
 RETURNS promo_events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.promo_events;
begin
  if not public.is_manager() then
    raise exception 'Only managers can approve promo stop';
  end if;

  update promo_events
  set status = 'stopped',
      stopped_by = p_staff_id,
      stopped_at = now()
  where id = p_promo_event_id
    and status = 'stop_pending'
  returning * into v_row;

  if not found then
    raise exception 'No stop-pending promo found';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'promo_stopped',
    'Approved stop: ' || v_row.name,
    jsonb_build_object('promo_event_id', v_row.id, 'reason', v_row.stop_reason)
  );

  return v_row;
end;
$function$;

create or replace function public.assert_audit_log_caller(p_branch_id uuid, p_staff_id uuid, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := public.current_staff_id();
begin
  if v_actor is null then
    raise exception 'Not authenticated as staff';
  end if;

  if public.is_manager() then
    return;
  end if;

  if p_branch_id is not null and p_branch_id is distinct from public.current_staff_branch() then
    raise exception 'Not authorized';
  end if;

  if p_staff_id is not null and p_staff_id is distinct from v_actor then
    if p_staff_id::text <> coalesce(p_meta->>'approved_by', '')
       and p_staff_id::text <> coalesce(p_meta->>'requested_by', '') then
      raise exception 'Not authorized';
    end if;
  end if;
end;
$function$;

create or replace function public.assert_business_day_mutable(p_branch_id uuid, p_when timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status text;
  v_open_hour integer;
  v_biz_date date;
begin
  select coalesce(day_open_hour, 7) into v_open_hour
  from branches
  where id = p_branch_id;

  v_biz_date := public.business_date_for(p_when, coalesce(v_open_hour, 7));

  select status into v_status
  from day_ends
  where branch_id = p_branch_id
    and business_date = v_biz_date;

  if v_status in ('closed', 'submitted') then
    raise exception 'This business day is locked. Voids and refunds require the day to be reopened first.';
  end if;
end;
$function$;

create or replace function public.assert_pin_not_locked(p_login_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_locked timestamptz;
begin
  select locked_until into v_locked
  from public.pin_login_attempts
  where login_code = trim(p_login_code);

  if v_locked is not null and v_locked > now() then
    raise exception 'Too many failed PIN attempts. Try again after %',
      to_char(v_locked at time zone 'UTC', 'HH24:MI "UTC"');
  end if;
end;
$function$;

create or replace function public.assert_till_open(p_branch_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status text;
  v_open_hour integer;
  v_biz_date date;
begin
  select coalesce(day_open_hour, 7) into v_open_hour
  from branches
  where id = p_branch_id;

  v_open_hour := coalesce(v_open_hour, 7);
  v_biz_date := public.current_business_date(v_open_hour);

  select status into v_status
  from day_ends
  where branch_id = p_branch_id
    and business_date = v_biz_date;

  if v_status in ('closed', 'submitted') then
    raise exception 'Till is locked for this business day. Submit is pending approval or the day is closed — ask a manager.';
  end if;
end;
$function$;

create or replace function public.assign_product_no()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.product_no is null then
    select coalesce(max(product_no), 0) + 1
      into new.product_no
    from products
    where branch_id = new.branch_id;
  end if;
  return new;
end;
$function$;

create or replace function public.branch_staff_roster(p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, branch_id uuid, branch_name text, full_name text, role text, is_active boolean, login_code text, permissions jsonb, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- NOTE the column list: no login_pin, no auth_secret, no active_session_id. Adding one
  -- here is the same as granting every supervisor access to it, so do not.
  select s.id,
         s.branch_id,
         b.name,
         s.full_name,
         s.role,
         s.is_active,
         s.login_code,
         s.permissions,
         s.created_at
  from public.staff s
  left join public.branches b on b.id = s.branch_id
  where
    -- Managers: any branch, optionally narrowed by the caller.
    (
      public.is_manager()
      and (p_branch_id is null or s.branch_id = p_branch_id)
    )
    -- Supervisors: their OWN branch only, regardless of what they pass in. The argument
    -- is a filter for managers, never a way for a supervisor to look sideways.
    or (
      public.is_supervisor_or_above()
      and not public.is_manager()
      and s.branch_id = public.current_staff_branch()
    )
  order by s.is_active desc, s.full_name;
$function$;

create or replace function public.broadcast_pos_event(p_branch_id uuid, p_channel text, p_event text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_topic text;
  v_payload jsonb;
begin
  if p_branch_id is null then
    return;
  end if;
  if p_channel is distinct from 'inventory' and p_channel is distinct from 'operations' then
    raise exception 'broadcast_pos_event: invalid channel %', p_channel;
  end if;
  if p_event is null or length(trim(p_event)) = 0 then
    raise exception 'broadcast_pos_event: event required';
  end if;

  v_topic := format('pos:branch:%s:%s', p_branch_id::text, p_channel);
  v_payload := coalesce(p_payload, '{}'::jsonb)
    || jsonb_build_object(
      'event', p_event,
      'branch_id', p_branch_id
    );
  -- Defence in depth: strip accidental sensitive keys
  v_payload := v_payload
    - 'password' - 'pin' - 'pin_hash' - 'pin_verifier' - 'secret'
    - 'service_role' - 'access_token' - 'refresh_token'
    - 'quantity_on_hand' - 'stock' - 'customer' - 'customer_phone';

  begin
    perform realtime.send(v_payload, p_event, v_topic, true);
  exception when others then
    raise warning 'broadcast_pos_event send failed (%): %', v_topic, SQLERRM;
  end;

  if p_channel = 'operations' then
    begin
      perform realtime.send(v_payload, p_event, 'pos:network:operations', true);
    exception when others then
      raise warning 'broadcast_pos_event network send failed: %', SQLERRM;
    end;
  end if;
end;
$function$;
-- Hardened: internal notification helper only, never called directly by a client.
revoke execute on function public.broadcast_pos_event(uuid, text, text, jsonb) from public;
revoke execute on function public.broadcast_pos_event(uuid, text, text, jsonb) from authenticated;

create or replace function public.business_date_for(p_when timestamp with time zone, p_open_hour integer DEFAULT 7)
 RETURNS date
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select case
    when extract(hour from (timezone('Asia/Manila', p_when))) < greatest(0, least(23, coalesce(p_open_hour, 7)))
      then (timezone('Asia/Manila', p_when))::date - 1
    else (timezone('Asia/Manila', p_when))::date
  end;
$function$;

create or replace function public.cancel_cash_movement(p_id uuid, p_cancelled_by uuid)
 RETURNS cash_movements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.cash_movements%rowtype;
begin
  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'pending_remote' then
    raise exception 'MOVE11: movement is not awaiting approval';
  end if;
  if v_row.requested_by is distinct from p_cancelled_by and not public.is_manager() then
    raise exception 'MOVE16: only requester or manager can cancel';
  end if;

  update public.cash_movements
  set status = 'voided',
      denied_by = p_cancelled_by,
      denied_at = now()
  where id = p_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_cancelled_by, 'cash_movement_cancelled',
    'Cancelled ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object('cash_movement_id', v_row.id)
  );

  return v_row;
end;
$function$;

create or replace function public.cancel_refund_request(p_request_id uuid, p_staff_id uuid)
 RETURNS refund_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.refund_requests;
begin
  update refund_requests
  set status = 'cancelled'
  where id = p_request_id
    and status = 'pending'
    and (requested_by = p_staff_id or public.is_manager())
  returning * into v_row;

  if not found then
    raise exception 'No pending refund request found';
  end if;

  return v_row;
end;
$function$;

create or replace function public.cash_movement_counts(p_status text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select p_status in (
    'approved',
    'remote_approved',
    'self_recorded',
    'confirmed',
    'flagged_for_investigation'
  );
$function$;

create or replace function public.cash_movement_type_allowed(p_type text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select p_type in ('petty_cash', 'pickup', 'cash_in', 'opening_float');
$function$;

create or replace function public.claim_staff_session(p_staff_id uuid, p_session_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_existing uuid;
  v_heartbeat timestamptz;
  v_stale interval := interval '15 minutes';
begin
  if p_staff_id is distinct from public.current_staff_id() then
    raise exception 'Not authorized';
  end if;

  if p_staff_id is null or p_session_id is null then
    raise exception 'Session claim requires staff and session id';
  end if;

  select active_session_id, session_heartbeat_at
    into v_existing, v_heartbeat
  from staff
  where id = p_staff_id
  for update;

  if not found then
    raise exception 'Staff not found';
  end if;

  if v_existing is not distinct from p_session_id then
    update staff
    set session_heartbeat_at = now()
    where id = p_staff_id;
    return true;
  end if;

  if v_existing is not null
     and v_heartbeat is not null
     and v_heartbeat > now() - v_stale then
    raise exception 'Already signed in on another device. Sign out there first.';
  end if;

  update staff
  set active_session_id = p_session_id,
      session_heartbeat_at = now()
  where id = p_staff_id;

  return true;
end;
$function$;

create or replace function public.clear_pin_login_failures(p_login_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  delete from public.pin_login_attempts where login_code = trim(p_login_code);
end;
$function$;
-- Hardened: internal helper for the PIN-login RPCs only.
revoke execute on function public.clear_pin_login_failures(text) from public;
revoke execute on function public.clear_pin_login_failures(text) from authenticated;

create or replace function public.clear_resolved_day_end_request(p_day_end_id uuid, p_staff_id uuid)
 RETURNS day_ends
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.day_ends;
begin
  if not public.is_supervisor_or_above() then
    raise exception 'Only supervisors or managers can clear a day end request';
  end if;

  update public.day_ends
  set
    requested_at = null,
    requested_by = null,
    request_manager = false
  where id = p_day_end_id
    and (
      status in ('closed', 'submitted')
      or (status = 'requested' and (submitted_at is not null or approved_at is not null))
    )
  returning * into v_row;

  if not found then
    select * into v_row
    from public.day_ends
    where id = p_day_end_id
      and status = 'requested';

    if found and exists (
      select 1
      from public.audit_events ae
      where ae.branch_id = v_row.branch_id
        and ae.event_type = 'day_end_approved'
        and (
          (ae.meta->>'day_end_id')::uuid = p_day_end_id
          or ae.meta->>'business_date' = v_row.business_date::text
        )
    ) then
      update public.day_ends
      set
        status = 'closed',
        requested_at = null,
        requested_by = null,
        request_manager = false,
        approved_at = coalesce(approved_at, now()),
        approved_by = coalesce(approved_by, p_staff_id),
        closed_at = coalesce(closed_at, now())
      where id = p_day_end_id
      returning * into v_row;
    end if;
  end if;

  if not found then
    raise exception 'No resolved day end request to clear';
  end if;

  return v_row;
end;
$function$;

create or replace function public.close_staff_shift(p_shift_id uuid, p_ending_cash numeric DEFAULT NULL::numeric, p_note text DEFAULT NULL::text, p_closed_by uuid DEFAULT NULL::uuid)
 RETURNS staff_shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_shift public.staff_shifts%rowtype;
  v_sales numeric(12,2) := 0;
  v_refunds numeric(12,2) := 0;
  v_paid_out numeric(12,2) := 0;
  v_pickups numeric(12,2) := 0;
  v_cash_in numeric(12,2) := 0;
  v_expected numeric(12,2);
  v_row public.staff_shifts%rowtype;
  v_move_paid numeric(12,2) := 0;
  v_move_pick numeric(12,2) := 0;
begin
  select * into v_shift from public.staff_shifts where id = p_shift_id;
  if not found then
    raise exception 'SHIFT_NOT_FOUND: no shift with id %', p_shift_id;
  end if;

  if v_shift.branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'SHIFT_NOT_ALLOWED: that shift belongs to another branch';
  end if;

  if v_shift.clock_out is not null then
    return v_shift;
  end if;

  if not v_shift.holds_drawer then
    update public.staff_shifts
    set clock_out = now(),
        close_note = nullif(trim(coalesce(p_note, '')), ''),
        closed_by = coalesce(p_closed_by, staff_id)
    where id = p_shift_id
    returning * into v_row;
    return v_row;
  end if;

  select
    coalesce(sum(case when t.status = 'completed' then t.total_amount else 0 end), 0),
    coalesce(sum(
      case when t.status = 'completed' then coalesce(t.refunded_amount, 0) else 0 end
    ), 0)
  into v_sales, v_refunds
  from public.transactions t
  where t.shift_id = p_shift_id
    and coalesce(t.payment_method, 'cash') = 'cash';

  select
    coalesce(sum(case when c.kind = 'paid_out' and c.status = 'fulfilled' then c.amount else 0 end), 0),
    coalesce(sum(case when c.kind = 'pickup' then c.amount else 0 end), 0)
  into v_paid_out, v_pickups
  from public.cash_drawer_entries c
  where c.shift_id = p_shift_id;

  select
    coalesce(sum(case when m.type = 'petty_cash' then m.amount else 0 end), 0),
    coalesce(sum(case when m.type = 'pickup' then m.amount else 0 end), 0),
    coalesce(sum(case when m.type = 'cash_in' then m.amount else 0 end), 0)
  into v_move_paid, v_move_pick, v_cash_in
  from public.cash_movements m
  where m.shift_id = p_shift_id
    and public.cash_movement_counts(m.status);

  v_paid_out := v_paid_out + v_move_paid;
  v_pickups := v_pickups + v_move_pick;

  v_expected := round(
    coalesce(v_shift.starting_cash, 0) + v_cash_in + v_sales - v_refunds - v_paid_out - v_pickups, 2);

  update public.staff_shifts
  set clock_out = now(),
      ending_cash = case when p_ending_cash is null then null else round(p_ending_cash, 2) end,
      expected_cash = case when p_ending_cash is null then null else v_expected end,
      variance = case when p_ending_cash is null then null else round(round(p_ending_cash, 2) - v_expected, 2) end,
      cash_sales = v_sales,
      cash_refunds = v_refunds,
      cash_paid_out = v_paid_out,
      cash_pickups = v_pickups,
      close_note = nullif(trim(coalesce(p_note, '')), ''),
      closed_by = coalesce(p_closed_by, staff_id)
  where id = p_shift_id
  returning * into v_row;

  return v_row;
end;
$function$;
-- Hardened: touches shift cash accounting, callable only by an authenticated session.
revoke execute on function public.close_staff_shift(uuid, numeric, text, uuid) from public;
grant execute on function public.close_staff_shift(uuid, numeric, text, uuid) to authenticated;

create or replace function public.complete_sale(p_branch_id uuid, p_staff_id uuid, p_items jsonb, p_total numeric, p_tendered numeric, p_client_id text DEFAULT NULL::text, p_client_or_number text DEFAULT NULL::text, p_order_type text DEFAULT 'dine_in'::text, p_ulam_combo text DEFAULT NULL::text, p_payment_method text DEFAULT 'cash'::text, p_payment_reference text DEFAULT NULL::text, p_vat_amount numeric DEFAULT 0, p_vatable_sales numeric DEFAULT 0, p_vat_exempt_sales numeric DEFAULT 0, p_zero_rated_sales numeric DEFAULT 0, p_sc_pwd_discount numeric DEFAULT 0, p_vat_rate_applied numeric DEFAULT 0.12, p_discount_amount numeric DEFAULT 0, p_discount_type text DEFAULT NULL::text, p_discount_id_note text DEFAULT NULL::text, p_shift_id uuid DEFAULT NULL::uuid)
 RETURNS transactions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_txn public.transactions;
  v_existing public.transactions;
  v_or_number text;
  v_branch_type text;
  v_is_restaurant boolean;
  v_item jsonb;
  v_payment_method text;
  v_payment_reference text;
begin
  if public.current_staff_branch() is distinct from p_branch_id and not public.is_manager() then
    raise exception 'Branch access denied';
  end if;

  if p_client_id is not null then
    select * into v_existing
    from public.transactions
    where branch_id = p_branch_id and client_id = p_client_id;
    if found then
      return v_existing;
    end if;
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'complete_sale requires at least one cart line';
  end if;

  perform public.assert_till_open(p_branch_id);

  if p_client_or_number is not null and length(trim(p_client_or_number)) > 0 then
    v_or_number := public.reserve_or_number(p_branch_id, p_client_or_number);
  else
    update public.branches
    set or_next = or_next + 1
    where id = p_branch_id
    returning coalesce(nullif(or_prefix, ''), 'OR') || '-' || lpad((or_next - 1)::text, 8, '0')
    into v_or_number;

    if not found then
      raise exception 'Branch not found';
    end if;
  end if;

  select branch_type into v_branch_type from public.branches where id = p_branch_id;
  v_is_restaurant := v_branch_type = 'restaurant';

  v_payment_method := case when p_payment_method in ('cash', 'card', 'ewallet') then p_payment_method else 'cash' end;
  v_payment_reference := case
    when p_payment_method = 'ewallet' then nullif(trim(coalesce(p_payment_reference, '')), '')
    else null
  end;

  insert into public.transactions (
    branch_id, staff_id, total_amount, amount_tendered, change_given, status,
    payment_method, payment_reference, or_number, client_id,
    vat_amount, vatable_sales, vat_exempt_sales, zero_rated_sales, sc_pwd_discount,
    vat_rate_applied, discount_amount, discount_type, discount_id_note, shift_id,
    order_type, ulam_combo
  ) values (
    p_branch_id, p_staff_id, p_total, p_tendered, greatest(0, p_tendered - p_total), 'completed',
    v_payment_method, v_payment_reference, v_or_number, p_client_id,
    coalesce(p_vat_amount, 0), coalesce(p_vatable_sales, 0), coalesce(p_vat_exempt_sales, 0),
    coalesce(p_zero_rated_sales, 0), coalesce(p_sc_pwd_discount, 0), coalesce(p_vat_rate_applied, 0.12),
    coalesce(p_discount_amount, 0), p_discount_type, p_discount_id_note, p_shift_id,
    case when v_is_restaurant then (case when p_order_type = 'takeout' then 'takeout' else 'dine_in' end) else null end,
    case when v_is_restaurant then p_ulam_combo else null end
  )
  returning * into v_txn;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.transaction_items (
      transaction_id, product_id, quantity, unit_price, line_total,
      discount_eligible, discount_amount, promo_name, promo_group_id, vat_category, price_tier
    ) values (
      v_txn.id,
      (v_item ->> 'product_id')::uuid,
      (v_item ->> 'quantity')::numeric,
      (v_item ->> 'unit_price')::numeric,
      (v_item ->> 'line_total')::numeric,
      coalesce((v_item ->> 'discount_eligible')::boolean, false),
      coalesce((v_item ->> 'discount_amount')::numeric, 0),
      nullif(v_item ->> 'promo_name', ''),
      nullif(v_item ->> 'promo_group_id', '')::uuid,
      coalesce(nullif(v_item ->> 'vat_category', ''), 'vatable'),
      case when v_is_restaurant then coalesce(nullif(v_item ->> 'price_tier', ''), 'regular') else null end
    );

    if not v_is_restaurant then
      perform public.record_stock_movement(
        p_branch_id,
        (v_item ->> 'product_id')::uuid,
        p_staff_id,
        'sale',
        0,
        (v_item ->> 'quantity')::numeric,
        v_txn.id::text,
        coalesce(nullif(v_item ->> 'detail', ''), v_item ->> 'product_id')
      );
    end if;
  end loop;

  insert into public.sale_events (branch_id, transaction_id, staff_id, event_type, or_number, amount, payload)
  values (
    p_branch_id, v_txn.id, p_staff_id, 'sale', v_txn.or_number, p_total,
    jsonb_build_object('client_id', p_client_id, 'order_type', v_txn.order_type, 'ulam_combo', v_txn.ulam_combo)
  );

  return v_txn;
exception
  when unique_violation then
    if p_client_id is not null then
      select * into v_existing
      from public.transactions
      where branch_id = p_branch_id and client_id = p_client_id;
      if found then
        return v_existing;
      end if;
    end if;
    raise;
end;
$function$;
-- Hardened: the atomic checkout RPC — must be signed in, cannot be reached anonymously.
revoke execute on function public.complete_sale(uuid, uuid, jsonb, numeric, numeric, text, text, text, text, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, text, text, uuid) from public;
grant execute on function public.complete_sale(uuid, uuid, jsonb, numeric, numeric, text, text, text, text, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, text, text, uuid) to authenticated;

create or replace function public.create_cash_movement_approved(p_shift_id uuid, p_branch_id uuid, p_drawer_id text, p_drawer_label text, p_type text, p_amount numeric, p_reason text, p_requested_by uuid, p_approved_by uuid, p_client_id uuid DEFAULT NULL::uuid, p_created_offline boolean DEFAULT false)
 RETURNS cash_movements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_shift public.staff_shifts%rowtype;
  v_row public.cash_movements%rowtype;
  v_self_approved boolean;
begin
  if not public.cash_movement_type_allowed(p_type) then
    raise exception 'MOVE01: invalid movement type';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'MOVE02: amount must be positive';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'MOVE03: reason is required';
  end if;
  if p_approved_by is null then
    raise exception 'MOVE04: supervisor approval required';
  end if;
  v_self_approved := p_approved_by is not distinct from p_requested_by;
  if v_self_approved and not public.is_supervisor_or_above() then
    raise exception 'MOVE04: supervisor approval required';
  end if;

  select * into v_shift from public.staff_shifts where id = p_shift_id for update;
  if not found then
    raise exception 'MOVE05: shift not found';
  end if;
  if v_shift.clock_out is not null then
    raise exception 'MOVE06: shift is closed';
  end if;
  if v_shift.holds_drawer is false then
    raise exception 'MOVE07: floor shift cannot hold drawer cash';
  end if;
  if v_shift.branch_id is distinct from p_branch_id then
    raise exception 'MOVE08: branch mismatch';
  end if;
  if v_shift.staff_id is distinct from p_requested_by
     and not public.is_supervisor_or_above() then
    raise exception 'MOVE09: only the drawer holder can request';
  end if;

  perform public.validate_cash_movement_opening_float(p_shift_id, p_type);

  insert into public.cash_movements (
    client_id, shift_id, branch_id, drawer_id, drawer_label,
    type, amount, reason, requested_by, status,
    approved_by, approved_at, created_offline, synced_at
  ) values (
    p_client_id, p_shift_id, p_branch_id,
    coalesce(nullif(trim(p_drawer_id), ''), 'main'),
    coalesce(nullif(trim(p_drawer_label), ''), 'Main drawer'),
    p_type, round(p_amount, 2), trim(p_reason), p_requested_by, 'approved',
    p_approved_by, now(), coalesce(p_created_offline, false),
    case when coalesce(p_created_offline, false) then null else now() end
  )
  returning * into v_row;

  perform public.apply_counted_cash_movement_effects(v_row);

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_approved_by,
    case when v_self_approved then 'cash_movement_self_approved' else 'cash_movement_approved' end,
    (case when v_self_approved then 'Self-approved ' else 'Approved ' end)
      || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object(
      'cash_movement_id', v_row.id, 'type', v_row.type,
      'amount', v_row.amount, 'via', case when v_self_approved then 'self' else 'pin' end
    )
  );

  return v_row;
end;
$function$;

create or replace function public.create_cash_movement_pending(p_shift_id uuid, p_branch_id uuid, p_drawer_id text, p_drawer_label text, p_type text, p_amount numeric, p_reason text, p_requested_by uuid, p_client_id uuid DEFAULT NULL::uuid, p_created_offline boolean DEFAULT false)
 RETURNS cash_movements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_shift public.staff_shifts%rowtype;
  v_row public.cash_movements%rowtype;
begin
  if not public.cash_movement_type_allowed(p_type) then
    raise exception 'MOVE01: invalid movement type';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'MOVE02: amount must be positive';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'MOVE03: reason is required';
  end if;

  select * into v_shift from public.staff_shifts where id = p_shift_id for update;
  if not found then
    raise exception 'MOVE05: shift not found';
  end if;
  if v_shift.clock_out is not null then
    raise exception 'MOVE06: shift is closed';
  end if;
  if v_shift.holds_drawer is false then
    raise exception 'MOVE07: floor shift cannot hold drawer cash';
  end if;
  if v_shift.branch_id is distinct from p_branch_id then
    raise exception 'MOVE08: branch mismatch';
  end if;

  perform public.validate_cash_movement_opening_float(p_shift_id, p_type);

  insert into public.cash_movements (
    client_id, shift_id, branch_id, drawer_id, drawer_label,
    type, amount, reason, requested_by, status,
    created_offline, synced_at
  ) values (
    p_client_id, p_shift_id, p_branch_id,
    coalesce(nullif(trim(p_drawer_id), ''), 'main'),
    coalesce(nullif(trim(p_drawer_label), ''), 'Main drawer'),
    p_type, round(p_amount, 2), trim(p_reason), p_requested_by, 'pending_remote',
    coalesce(p_created_offline, false),
    case when coalesce(p_created_offline, false) then null else now() end
  )
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_requested_by, 'cash_movement_pending',
    'Requested manager approval for ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object(
      'cash_movement_id', v_row.id, 'type', v_row.type, 'amount', v_row.amount
    )
  );

  return v_row;
end;
$function$;

create or replace function public.create_till_action_request(p_branch_id uuid, p_requested_by uuid, p_action text, p_detail text, p_meta jsonb DEFAULT '{}'::jsonb, p_client_id uuid DEFAULT NULL::uuid)
 RETURNS till_action_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.till_action_requests%rowtype;
begin
  if p_action not in ('cart_line_remove') then
    raise exception 'TILL_ACT01: invalid action';
  end if;

  insert into public.till_action_requests (
    client_id, branch_id, action, detail, meta, requested_by, status
  ) values (
    p_client_id, p_branch_id, p_action,
    coalesce(nullif(trim(p_detail), ''), p_action),
    coalesce(p_meta, '{}'::jsonb),
    p_requested_by, 'pending'
  )
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_requested_by, 'till_action_requested',
    v_row.detail,
    jsonb_build_object('till_action_id', v_row.id, 'action', v_row.action)
  );

  return v_row;
end;
$function$;

create or replace function public.current_business_date(p_open_hour integer DEFAULT 7)
 RETURNS date
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select case
    when extract(hour from (timezone('Asia/Manila', now()))) < greatest(0, least(23, coalesce(p_open_hour, 7)))
      then (timezone('Asia/Manila', now()))::date - 1
    else (timezone('Asia/Manila', now()))::date
  end;
$function$;

create or replace function public.current_staff_branch()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select branch_id from public.staff where auth_user_id = auth.uid() and is_active = true limit 1;
$function$;

create or replace function public.current_staff_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id from staff where auth_user_id = auth.uid() and is_active limit 1;
$function$;

create or replace function public.current_staff_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select role from public.staff where auth_user_id = auth.uid() and is_active = true limit 1;
$function$;

create or replace function public.deny_cash_movement(p_id uuid, p_denied_by uuid)
 RETURNS cash_movements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.cash_movements%rowtype;
begin
  if not (public.is_manager() or public.is_supervisor_or_above()) then
    raise exception 'MOVE13: only supervisor or manager can deny';
  end if;

  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'pending_remote' then
    raise exception 'MOVE11: movement is not awaiting approval';
  end if;

  update public.cash_movements
  set status = 'denied',
      denied_by = p_denied_by,
      denied_at = now()
  where id = p_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_denied_by, 'cash_movement_denied',
    'Denied ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object('cash_movement_id', v_row.id)
  );

  return v_row;
end;
$function$;

create or replace function public.dismiss_import_revert_request(p_batch_id uuid, p_staff_id uuid)
 RETURNS import_batches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_batch public.import_batches;
begin
  if not public.is_manager() then
    raise exception 'Only managers can dismiss a revert request';
  end if;

  update import_batches
  set status = 'committed', revert_requested_by = null, revert_requested_at = null
  where id = p_batch_id and status = 'revert_requested'
  returning * into v_batch;

  if v_batch.id is null then
    raise exception 'Import batch not found or not pending a revert request';
  end if;

  return v_batch;
end;
$function$;

create or replace function public.drawer_holder(p_branch_id uuid, p_drawer_id text)
 RETURNS TABLE(shift_id uuid, staff_id uuid, staff_name text, clock_in timestamp with time zone, is_mine boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select s.id, s.staff_id, st.full_name, s.clock_in, s.staff_id = public.current_staff_id()
  from public.staff_shifts s
  left join public.staff st on st.id = s.staff_id
  where s.branch_id = p_branch_id
    and s.drawer_id = coalesce(nullif(trim(p_drawer_id), ''), 'main')
    and s.clock_out is null
    and s.holds_drawer
    and (p_branch_id = public.current_staff_branch() or public.is_manager())
  order by s.clock_in desc
  limit 1;
$function$;
-- Hardened: reveals another staff member's active drawer session.
revoke execute on function public.drawer_holder(uuid, text) from public;
grant execute on function public.drawer_holder(uuid, text) to authenticated;

create or replace function public.drawer_last_count(p_branch_id uuid, p_drawer_id text)
 RETURNS TABLE(shift_id uuid, staff_name text, clock_out timestamp with time zone, ending_cash numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select s.id, st.full_name, s.clock_out, s.ending_cash
  from public.staff_shifts s
  left join public.staff st on st.id = s.staff_id
  where s.branch_id = p_branch_id
    and s.drawer_id = coalesce(nullif(trim(p_drawer_id), ''), 'main')
    and s.clock_out is not null
    and s.holds_drawer
    and (p_branch_id = public.current_staff_branch() or public.is_manager())
  order by s.clock_out desc
  limit 1;
$function$;
-- Hardened: reveals another staff member's drawer cash count.
revoke execute on function public.drawer_last_count(uuid, text) from public;
grant execute on function public.drawer_last_count(uuid, text) to authenticated;

create or replace function public.enforce_staff_role_ceiling()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor_id   uuid;
  v_actor_role text;
  v_actor_rank integer;
  v_uid        uuid := auth.uid();
begin
  -- ==========================================================================
  -- GATE 0: does this write touch authority at all?
  -- ==========================================================================
  -- If an UPDATE changes none of the four columns that confer authority, it cannot
  -- escalate anything, so the role ceiling has no business inspecting it. Returning here
  -- first makes a whole class of outage impossible.
  --
  -- This is not a theoretical tidy-up. The first version of this migration checked
  -- new.role on every write, which meant the session heartbeat that runs at LOGIN —
  -- a cashier updating their own row, role unchanged — was rejected with
  -- "a cashier cannot assign the cashier role", and nobody could sign in. Any write that
  -- leaves role, permissions, is_active and branch_id alone (heartbeat, last-seen,
  -- display name, and every column added in future) is now none of this trigger's
  -- concern by construction, not by remembering to special-case it.
  if tg_op = 'UPDATE'
     and new.role is not distinct from old.role
     and new.permissions is not distinct from old.permissions
     and new.is_active is not distinct from old.is_active
     and new.branch_id is not distinct from old.branch_id then
    return new;
  end if;

  -- NO JWT AT ALL: the service role, the SQL editor, a seed script, or the SECURITY
  -- DEFINER login functions (resolve_pin_login runs before anyone is signed in, so
  -- auth.uid() is null there). These must stay unrestricted or the very first master
  -- account could never be created and PIN login would break.
  if v_uid is null then
    return new;
  end if;

  select id, role into v_actor_id, v_actor_role
  from public.staff
  where auth_user_id = v_uid and is_active
  limit 1;

  -- A JWT that maps to no ACTIVE staff row: a deactivated account whose token has not yet
  -- expired, or a staff row with a null auth_user_id.
  --
  -- Scoped to UPDATE deliberately. The risk the review identified is a deactivated
  -- manager continuing to REWRITE staff rows until their token ages out, and that is
  -- refused here. INSERT is left to fall through because legitimate account creation
  -- genuinely runs without a resolvable actor: handle_new_user() fires inside the
  -- auth.users insert, and supabase.auth.signUp() can leave the client briefly holding
  -- the new user's session — neither has a staff row yet, by definition. Denying those
  -- would break creating staff entirely, and INSERT is already gated: the RLS policy on
  -- `staff` requires is_manager(), which a stranger does not satisfy.
  if v_actor_role is null then
    if tg_op = 'UPDATE' then
      raise exception
        'Role ceiling: no active staff record for this session (SEC02).'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- master is the root of the tree; it may do anything, including create peers.
  if v_actor_role = 'master' then
    return new;
  end if;

  v_actor_rank := public.role_rank(v_actor_role);

  -- Rule 1: never assign a role at or above your own.
  --
  -- Only when the role is actually being SET — on insert, or on an update that changes it.
  -- Testing new.role unconditionally meant an unchanged role always failed its own
  -- ceiling test (a manager's row holds 'manager', and 30 >= 30), so every ordinary
  -- self-write — a session heartbeat, a display-name edit — was rejected with SEC01
  -- before Rule 3's targeted column check could run.
  -- Written as a nested IF rather than `tg_op = 'INSERT' or new.role is distinct from
  -- old.role`. In an INSERT trigger OLD is unassigned, and touching OLD.role there raises
  -- `record "old" is not assigned yet` — PostgreSQL does not promise to short-circuit the
  -- OR, so that form could fail on every staff INSERT. OLD is only referenced under
  -- tg_op = 'UPDATE' here, where it is guaranteed to exist.
  if tg_op = 'INSERT' then
    if public.role_rank(new.role) >= v_actor_rank then
      raise exception
        'Role ceiling: a % cannot create an account with the % role (SEC01).', v_actor_role, new.role
        using errcode = '42501';
    end if;
  elsif new.role is distinct from old.role then
    if public.role_rank(new.role) >= v_actor_rank then
      raise exception
        'Role ceiling: a % cannot assign the % role (SEC01).', v_actor_role, new.role
        using errcode = '42501';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if old.id = v_actor_id then
      -- Rule 3: your OWN row. You may touch it, but not the columns that confer
      -- authority. Checked per column rather than on the row as a whole so that ordinary
      -- self-writes — session heartbeat, display name — keep working.
      --
      -- This branch must come before Rule 2, because your own role is by definition equal
      -- to your own rank and Rule 2 would otherwise reject every self-write outright.
      if new.role is distinct from old.role
         or new.permissions is distinct from old.permissions
         or new.is_active is distinct from old.is_active
         or new.branch_id is distinct from old.branch_id then
        raise exception
          'Role ceiling: you cannot change your own role, access, branch or active status (SEC03). Ask someone above you.'
          using errcode = '42501';
      end if;
    -- Rule 2: never modify SOMEONE ELSE'S account at or above your own rank. Without this
    -- a manager could demote the admin who supervises them and then act freely.
    elsif public.role_rank(old.role) >= v_actor_rank then
      raise exception
        'Role ceiling: a % cannot modify a % account (SEC02).', v_actor_role, old.role
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$function$;
-- Hardened: internal trigger function, must never be reachable via RPC.
revoke execute on function public.enforce_staff_role_ceiling() from public;
revoke execute on function public.enforce_staff_role_ceiling() from authenticated;

create or replace function public.expire_ended_promos()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_manager() then
    raise exception 'Not authorized';
  end if;

  update promo_events
  set status = 'expired',
      stopped_at = coalesce(stopped_at, now())
  where status in ('active', 'stop_pending')
    and ends_at is not null
    and ends_at < now();
end;
$function$;

create or replace function public.fetch_branch_supervisor_verifiers(p_branch_id uuid)
 RETURNS TABLE(staff_id uuid, login_code text, full_name text, role text, branch_id uuid, pin_verifier jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_branch_id is null then
    raise exception 'Branch required';
  end if;

  return query
  select s.id, s.login_code, s.full_name, s.role, s.branch_id, s.pin_verifier
  from public.staff s
  where s.is_active
    and s.login_code is not null
    and s.pin_verifier is not null
    and (
      (s.branch_id = p_branch_id and s.role = 'supervisor')
      or s.role in ('manager', 'admin', 'master')
    )
  order by s.role, s.full_name;
end;
$function$;

create or replace function public.guard_transaction_updates()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'transactions cannot be deleted';
  end if;

  if old.status = 'voided' then
    raise exception 'voided transactions are locked';
  end if;

  if new.branch_id is distinct from old.branch_id
     or new.total_amount is distinct from old.total_amount
     or new.amount_tendered is distinct from old.amount_tendered
     or new.change_given is distinct from old.change_given
     or new.or_number is distinct from old.or_number
     or new.created_at is distinct from old.created_at
     or new.staff_id is distinct from old.staff_id
     or new.client_id is distinct from old.client_id then
    raise exception 'sale financial fields are immutable';
  end if;

  if new.status = 'voided' and old.status = 'completed' then
    new.voided_at := coalesce(new.voided_at, now());
    return new;
  end if;

  -- Partial refunds: only refunded_amount may change on a completed sale
  if old.status = 'completed'
     and new.status = 'completed'
     and new.refunded_amount is distinct from old.refunded_amount
     and coalesce(new.refunded_amount, 0) >= coalesce(old.refunded_amount, 0) then
    return new;
  end if;

  raise exception 'transactions are immutable except for voiding a completed sale';
end;
$function$;

create or replace function public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_branch uuid; v_role text; v_name text;
begin
  v_branch := nullif(new.raw_user_meta_data->>'branch_id', '')::uuid;
  v_role := coalesce(nullif(new.raw_user_meta_data->>'role', ''), 'cashier');
  v_name := coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), split_part(new.email, '@', 1));
  if v_branch is null then
    select id into v_branch from branches where is_active order by created_at limit 1;
  end if;
  if v_branch is not null and not exists (select 1 from staff where auth_user_id = new.id) then
    insert into staff (auth_user_id, branch_id, full_name, role)
    values (new.id, v_branch, v_name, v_role);
  end if;
  return new;
end;
$function$;

create or replace function public.heartbeat_branch(p_branch_id uuid, p_staff_id uuid DEFAULT NULL::uuid, p_app_version text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text)
 RETURNS branch_presence
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.branch_presence;
begin
  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Not allowed to heartbeat this branch';
  end if;

  insert into branch_presence (branch_id, staff_id, last_seen_at, is_online, app_version, user_agent, updated_at)
  values (p_branch_id, p_staff_id, now(), true, p_app_version, p_user_agent, now())
  on conflict (branch_id) do update set
    staff_id = excluded.staff_id,
    last_seen_at = now(),
    is_online = true,
    app_version = excluded.app_version,
    user_agent = excluded.user_agent,
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$function$;

create or replace function public.heartbeat_staff_session(p_staff_id uuid, p_session_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_staff_id is distinct from public.current_staff_id() then
    raise exception 'Not authorized';
  end if;

  update staff
  set session_heartbeat_at = now()
  where id = p_staff_id
    and active_session_id = p_session_id;

  if not found then
    raise exception 'Session is no longer active';
  end if;
  return true;
end;
$function$;

create or replace function public.is_manager()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(public.current_staff_role() in ('manager', 'admin', 'master'), false);
$function$;

create or replace function public.is_master()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.staff
    where auth_user_id = auth.uid()
      and is_active
      and role = 'master'
  );
$function$;

create or replace function public.is_supervisor_or_above()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from staff
    where auth_user_id = auth.uid()
      and is_active
      and role in ('supervisor', 'manager', 'admin', 'master')
  );
$function$;

create or replace function public.link_product_to_catalog()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.catalog_product_id is null and new.sku is not null and trim(new.sku) <> '' then
    select id into new.catalog_product_id
    from catalog_products
    where lower(trim(sku)) = lower(trim(new.sku))
    limit 1;
  end if;
  return new;
end;
$function$;

create or replace function public.log_audit_event(p_branch_id uuid, p_staff_id uuid, p_event_type text, p_detail text DEFAULT NULL::text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
begin
  perform public.assert_audit_log_caller(p_branch_id, p_staff_id, coalesce(p_meta, '{}'::jsonb));

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (p_branch_id, p_staff_id, p_event_type, p_detail, coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function public.log_audit_event_idempotent(p_branch_id uuid, p_staff_id uuid, p_event_type text, p_detail text DEFAULT NULL::text, p_meta jsonb DEFAULT '{}'::jsonb, p_client_id text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
  v_meta jsonb;
begin
  v_meta := coalesce(p_meta, '{}'::jsonb);
  perform public.assert_audit_log_caller(p_branch_id, p_staff_id, v_meta);

  if p_client_id is not null and length(trim(p_client_id)) > 0 then
    select ae.id into v_id
    from public.audit_events ae
    where ae.meta->>'offline_client_id' = trim(p_client_id)
    limit 1;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  if p_client_id is not null and length(trim(p_client_id)) > 0 then
    v_meta := v_meta || jsonb_build_object('offline_client_id', trim(p_client_id));
  end if;

  insert into public.audit_events (branch_id, staff_id, event_type, detail, meta)
  values (p_branch_id, p_staff_id, p_event_type, p_detail, v_meta)
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function public.manager_overview_metrics(p_days integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_days integer := greatest(1, coalesce(p_days, 1));
  v_start timestamptz;
  v_branches jsonb := '{}'::jsonb;
  v_cash_by jsonb := '{}'::jsonb;
  v_cash_total jsonb;
  r record;
  v_branch_id uuid;
  v_open integer;
  v_today date;
  v_gross numeric;
  v_net numeric;
  v_disc numeric;
  v_ref numeric;
  v_void numeric;
  v_orders integer;
  v_low integer;
  v_menu_on integer;
  v_menu_off integer;
  v_cash_sales numeric;
  v_card_sales numeric;
  v_ewallet_sales numeric;
  v_cash_refunds numeric;
  v_change_fund numeric;
  v_pickup numeric;
  v_paid_out numeric;
  v_move_cash_in numeric;
  v_move_pickup numeric;
  v_move_paid_out numeric;
begin
  if not public.is_manager() then
    raise exception 'Managers only';
  end if;

  v_start := date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila'
             - make_interval(days => v_days - 1);

  for r in
    select b.id, b.branch_type, coalesce(b.day_open_hour, 7)::integer as open_hour
    from branches b
    where b.is_active is distinct from false
  loop
    v_branch_id := r.id;
    v_open := r.open_hour;
    v_today := ((now() at time zone 'Asia/Manila') - make_interval(hours => v_open))::date;

    select
      coalesce(sum(case when t.status = 'completed'
        then t.total_amount + coalesce(t.discount_amount, 0) else 0 end), 0),
      coalesce(sum(case when t.status = 'completed'
        then t.total_amount - coalesce(t.refunded_amount, 0) else 0 end), 0),
      coalesce(sum(case when t.status = 'completed'
        then coalesce(t.discount_amount, 0) else 0 end), 0),
      coalesce(sum(case when t.status = 'completed'
        then coalesce(t.refunded_amount, 0) else 0 end), 0),
      coalesce(sum(case when t.status = 'voided' then t.total_amount else 0 end), 0),
      count(*) filter (where t.status = 'completed')
    into v_gross, v_net, v_disc, v_ref, v_void, v_orders
    from transactions t
    where t.branch_id = v_branch_id
      and t.created_at >= v_start;

    v_low := 0;
    v_menu_on := 0;
    v_menu_off := 0;
    if r.branch_type = 'restaurant' then
      select
        count(*) filter (where coalesce(p.available_today, true)),
        count(*) filter (where p.available_today = false)
      into v_menu_on, v_menu_off
      from products p
      where p.branch_id = v_branch_id and p.is_active;
    else
      select count(*) into v_low
      from branch_inventory bi
      join products p on p.id = bi.product_id
      where bi.branch_id = v_branch_id
        and p.is_active
        and bi.quantity_on_hand <= coalesce(p.low_stock_threshold, 5);
    end if;

    v_branches := v_branches || jsonb_build_object(
      v_branch_id::text,
      jsonb_build_object(
        'revenue', round(v_net, 2),
        'orders', v_orders,
        'lowStock', v_low,
        'menuOn', v_menu_on,
        'menuOff', v_menu_off,
        'branchType', case when r.branch_type = 'restaurant' then 'restaurant' else 'retail' end,
        'grossSales', round(v_gross, 2),
        'netSales', round(v_net, 2),
        'discounts', round(v_disc, 2),
        'refunds', round(v_ref, 2),
        'voidedSales', round(v_void, 2)
      )
    );

    -- Cash impact for THIS business day only (drawer counted once per day).
    select
      coalesce(sum(case
        when t.status = 'completed'
         and coalesce(lower(t.payment_method), 'cash') not in ('card', 'ewallet')
        then greatest(0, t.total_amount - coalesce(t.refunded_amount, 0)) else 0 end), 0),
      coalesce(sum(case
        when t.status = 'completed' and lower(t.payment_method) = 'card'
        then greatest(0, t.total_amount - coalesce(t.refunded_amount, 0)) else 0 end), 0),
      coalesce(sum(case
        when t.status = 'completed' and lower(t.payment_method) = 'ewallet'
        then greatest(0, t.total_amount - coalesce(t.refunded_amount, 0)) else 0 end), 0),
      coalesce(sum(case
        when t.status = 'completed'
         and coalesce(lower(t.payment_method), 'cash') not in ('card', 'ewallet')
        then coalesce(t.refunded_amount, 0) else 0 end), 0)
    into v_cash_sales, v_card_sales, v_ewallet_sales, v_cash_refunds
    from transactions t
    where t.branch_id = v_branch_id
      and ((t.created_at at time zone 'Asia/Manila') - make_interval(hours => v_open))::date = v_today;

    -- Same-branch, same-business-date drawer shifts. A shift carried forward from another
    -- shift in THIS set is a duplicate (exclude) only while its startingCash still equals
    -- the frozen carried_amount from shift-open — see migrate_fix_overview_cash_impact_carry.sql.
    select coalesce(sum(
      case
        when ss.carried_from_shift_id is not null
         and coalesce(ss.starting_cash, 0) = coalesce(ss.carried_amount, 0)
         and exists (
           select 1 from public.staff_shifts p
           where p.id = ss.carried_from_shift_id
             and p.branch_id = v_branch_id
             and p.business_date = v_today
         )
        then 0
        else coalesce(ss.starting_cash, 0)
      end
    ), 0) into v_change_fund
    from public.staff_shifts ss
    where ss.branch_id = v_branch_id
      and ss.holds_drawer is distinct from false
      and ss.business_date = v_today;

    select
      coalesce(sum(case when cde.kind = 'change_fund' then cde.amount else 0 end), 0)
        + v_change_fund,
      coalesce(sum(case when cde.kind = 'pickup' then cde.amount else 0 end), 0),
      coalesce(sum(case when cde.kind = 'paid_out' and cde.status = 'fulfilled' then cde.amount else 0 end), 0)
    into v_change_fund, v_pickup, v_paid_out
    from cash_drawer_entries cde
    where cde.branch_id = v_branch_id
      and cde.business_date = v_today;

    -- POS -> Open Drawer (cash_movements) — see file header. Only counting-statuses have
    -- actually moved cash; 'opening_float' is excluded (already counted via staff_shifts
    -- above).
    select
      coalesce(sum(case when cm.type = 'cash_in' then cm.amount else 0 end), 0),
      coalesce(sum(case when cm.type = 'pickup' then cm.amount else 0 end), 0),
      coalesce(sum(case when cm.type = 'petty_cash' then cm.amount else 0 end), 0)
    into v_move_cash_in, v_move_pickup, v_move_paid_out
    from cash_movements cm
    where cm.branch_id = v_branch_id
      and cm.status in ('approved', 'remote_approved', 'self_recorded', 'confirmed', 'flagged_for_investigation')
      and ((cm.requested_at at time zone 'Asia/Manila') - make_interval(hours => v_open))::date = v_today;

    v_change_fund := v_change_fund + v_move_cash_in;
    v_pickup := v_pickup + v_move_pickup;
    v_paid_out := v_paid_out + v_move_paid_out;

    v_cash_by := v_cash_by || jsonb_build_object(
      v_branch_id::text,
      jsonb_build_object(
        'cashSales', round(v_cash_sales, 2),
        'cardSales', round(v_card_sales, 2),
        'ewalletSales', round(v_ewallet_sales, 2),
        'cashRefunds', round(v_cash_refunds, 2),
        'changeFund', round(v_change_fund, 2),
        'pickup', round(v_pickup, 2),
        'paidOut', round(v_paid_out, 2),
        'expectedCash', round(v_change_fund + v_cash_sales - v_paid_out - v_pickup, 2)
      )
    );
  end loop;

  select jsonb_build_object(
    'cashSales', coalesce(sum((value->>'cashSales')::numeric), 0),
    'cardSales', coalesce(sum((value->>'cardSales')::numeric), 0),
    'ewalletSales', coalesce(sum((value->>'ewalletSales')::numeric), 0),
    'cashRefunds', coalesce(sum((value->>'cashRefunds')::numeric), 0),
    'changeFund', coalesce(sum((value->>'changeFund')::numeric), 0),
    'pickup', coalesce(sum((value->>'pickup')::numeric), 0),
    'paidOut', coalesce(sum((value->>'paidOut')::numeric), 0),
    'expectedCash', coalesce(sum((value->>'expectedCash')::numeric), 0)
  )
  into v_cash_total
  from jsonb_each(v_cash_by);

  return jsonb_build_object(
    'branches', v_branches,
    'cashByBranch', v_cash_by,
    'cashImpact', coalesce(v_cash_total, jsonb_build_object(
      'cashSales', 0, 'cardSales', 0, 'ewalletSales', 0, 'cashRefunds', 0,
      'changeFund', 0, 'pickup', 0, 'paidOut', 0, 'expectedCash', 0
    ))
  );
end;
$function$;

create or replace function public.open_staff_shift(p_branch_id uuid, p_staff_id uuid, p_drawer_id text, p_starting_cash numeric, p_shift_period text DEFAULT NULL::text, p_client_id text DEFAULT NULL::text, p_carried_from uuid DEFAULT NULL::uuid, p_carried_amount numeric DEFAULT NULL::numeric, p_business_date date DEFAULT NULL::date, p_drawer_label text DEFAULT NULL::text, p_holds_drawer boolean DEFAULT true)
 RETURNS staff_shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_drawer text := coalesce(nullif(trim(p_drawer_id), ''), 'main');
  v_holds boolean := coalesce(p_holds_drawer, true);
  v_existing public.staff_shifts%rowtype;
  v_row public.staff_shifts%rowtype;
begin
  -- SECURITY DEFINER means RLS does not apply inside this function, so the caller's right
  -- to open THIS shift has to be checked here. Without it any signed-in staff member could
  -- open a shift in someone else's name and hang a cash shortage on them.
  if p_staff_id is distinct from public.current_staff_id()
     and not public.is_manager()
     and not (public.is_supervisor_or_above() and p_branch_id = public.current_staff_branch()) then
    raise exception 'SHIFT_NOT_ALLOWED: you can only start your own shift';
  end if;

  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'SHIFT_NOT_ALLOWED: that branch is not yours';
  end if;

  if v_holds and (p_starting_cash is null or p_starting_cash < 0) then
    raise exception 'SHIFT_FLOAT_REQUIRED: enter the change fund counted into the drawer';
  end if;

  -- Replayed push (offline retry, or a double-tap) — hand back the shift already opened.
  if p_client_id is not null then
    select * into v_existing from public.staff_shifts where client_id = p_client_id limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  -- Same person already open on this drawer: resume, do not open a second shift and do
  -- not ask for another change fund. This is the accidental-logout case.
  select * into v_existing
  from public.staff_shifts
  where staff_id = p_staff_id and branch_id = p_branch_id and drawer_id = v_drawer
    and clock_out is null
  limit 1;
  if found then
    return v_existing;
  end if;

  if v_holds then
    select * into v_existing
    from public.staff_shifts
    where branch_id = p_branch_id and drawer_id = v_drawer and clock_out is null and holds_drawer
    limit 1;
    if found then
      raise exception
        'SHIFT_DRAWER_BUSY: drawer % still has an open shift for another cashier — they must cash out first', v_drawer;
    end if;
  end if;

  insert into public.staff_shifts (
    branch_id, staff_id, drawer_id, drawer_label, holds_drawer, clock_in, shift_period,
    business_date, starting_cash, carried_from_shift_id, carried_amount, client_id
  ) values (
    p_branch_id, p_staff_id, v_drawer, nullif(trim(coalesce(p_drawer_label, '')), ''), v_holds, now(),
    case when p_shift_period in ('am', 'pm') then p_shift_period else null end,
    coalesce(p_business_date, (timezone('Asia/Manila', now()))::date),
    case when v_holds then round(p_starting_cash, 2) else null end,
    p_carried_from, round(coalesce(p_carried_amount, 0), 2),
    nullif(trim(coalesce(p_client_id, '')), '')
  )
  returning * into v_row;

  return v_row;
end $function$;
-- Hardened: opens a shift / cash drawer, callable only by an authenticated session.
revoke execute on function public.open_staff_shift(uuid, uuid, text, numeric, text, text, uuid, numeric, date, text, boolean) from public;
grant execute on function public.open_staff_shift(uuid, uuid, text, numeric, text, text, uuid, numeric, date, text, boolean) to authenticated;

create or replace function public.prevent_transaction_item_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  raise exception 'transaction_items are immutable (BIR non-editable sales records)';
end;
$function$;

create or replace function public.realtime_pos_is_network_ops()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(realtime.topic(), '') = 'pos:network:operations';
$function$;

create or replace function public.realtime_pos_topic_branch_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select (
    regexp_match(
      coalesce(realtime.topic(), ''),
      '^pos:branch:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(inventory|operations)$'
    )
  )[1]::uuid;
$function$;

create or replace function public.receive_shift_handoff(p_shift_id uuid, p_received_by uuid DEFAULT NULL::uuid)
 RETURNS staff_shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_shift public.staff_shifts%rowtype;
  v_expected numeric(12,2);
  v_actor uuid := coalesce(p_received_by, public.current_staff_id());
  v_row public.staff_shifts%rowtype;
begin
  if not public.is_supervisor_or_above() then
    raise exception 'SHIFT_NOT_ALLOWED: only a supervisor or manager can receive a handoff';
  end if;

  select * into v_shift from public.staff_shifts where id = p_shift_id for update;
  if not found then
    raise exception 'SHIFT_NOT_FOUND: no shift with id %', p_shift_id;
  end if;

  if not (v_shift.branch_id = public.current_staff_branch() or public.is_manager()) then
    raise exception 'SHIFT_NOT_ALLOWED: that shift belongs to another branch';
  end if;

  if v_shift.clock_out is null then
    raise exception 'SHIFT_STILL_OPEN: close the shift before receiving handoff';
  end if;

  if v_shift.holds_drawer is false then
    raise exception 'SHIFT_NO_DRAWER: floor shifts have no drawer handoff';
  end if;

  -- Already received / counted — idempotent success.
  if v_shift.ending_cash is not null then
    return v_shift;
  end if;

  v_expected := round(
    coalesce(v_shift.starting_cash, 0)
      + coalesce(v_shift.cash_sales, 0)
      - coalesce(v_shift.cash_refunds, 0)
      - coalesce(v_shift.cash_paid_out, 0)
      - coalesce(v_shift.cash_pickups, 0),
    2
  );

  insert into public.shift_adjustments (
    shift_id, branch_id, field, old_value, new_value, reason, adjusted_by, approved_by
  ) values (
    p_shift_id,
    v_shift.branch_id,
    'ending_cash',
    null,
    v_expected,
    'Handoff received — drawer counted at day end',
    v_actor,
    v_actor
  );

  perform set_config('calepos.shift_adjustment', 'on', true);

  update public.staff_shifts
  set ending_cash = v_expected,
      expected_cash = v_expected,
      variance = 0
  where id = p_shift_id
  returning * into v_row;

  perform set_config('calepos.shift_adjustment', 'off', true);

  return v_row;
end;
$function$;
-- Hardened: closes/reconciles another staff member's drawer handoff.
revoke execute on function public.receive_shift_handoff(uuid, uuid) from public;
grant execute on function public.receive_shift_handoff(uuid, uuid) to authenticated;

create or replace function public.record_pin_login_failure(p_login_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count integer;
begin
  insert into public.pin_login_attempts (login_code, fail_count, last_attempt_at, locked_until)
  values (trim(p_login_code), 1, now(), null)
  on conflict (login_code) do update
    set
      fail_count = case
        when public.pin_login_attempts.locked_until is not null
          and public.pin_login_attempts.locked_until <= now()
        then 1
        else public.pin_login_attempts.fail_count + 1
      end,
      last_attempt_at = now(),
      locked_until = case
        when (
          case
            when public.pin_login_attempts.locked_until is not null
              and public.pin_login_attempts.locked_until <= now()
            then 1
            else public.pin_login_attempts.fail_count + 1
          end
        ) >= 5
        then now() + interval '15 minutes'
        else null
      end;
end;
$function$;
-- Hardened: internal helper for the PIN-login RPCs only.
revoke execute on function public.record_pin_login_failure(text) from public;
revoke execute on function public.record_pin_login_failure(text) from authenticated;

create or replace function public.record_price_change(p_branch_id uuid, p_product_id uuid, p_staff_id uuid, p_old_price numeric, p_new_price numeric, p_detail text DEFAULT NULL::text)
 RETURNS stock_movements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_stock numeric;
  v_movement public.stock_movements;
begin
  if not public.is_supervisor_or_above() then
    raise exception 'Not authorized';
  end if;

  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Not authorized';
  end if;

  if p_staff_id is not null
     and p_staff_id is distinct from public.current_staff_id()
     and not public.is_manager() then
    raise exception 'Not authorized';
  end if;

  if p_old_price is not distinct from p_new_price then
    return null;
  end if;

  select quantity_on_hand into v_stock
  from branch_inventory
  where branch_id = p_branch_id and product_id = p_product_id;

  v_stock := coalesce(v_stock, 0);

  insert into stock_movements (
    branch_id, product_id, staff_id, movement_type, reference, detail,
    quantity_in, quantity_out, quantity_on_hand_after, old_price, new_price
  ) values (
    p_branch_id, p_product_id, coalesce(p_staff_id, public.current_staff_id()), 'price_change', 'price',
    coalesce(p_detail, 'Price update'),
    0, 0, v_stock, p_old_price, p_new_price
  )
  returning * into v_movement;

  return v_movement;
end;
$function$;

create or replace function public.record_stock_movement(p_branch_id uuid, p_product_id uuid, p_staff_id uuid, p_movement_type text, p_quantity_in numeric, p_quantity_out numeric, p_reference text DEFAULT NULL::text, p_detail text DEFAULT NULL::text)
 RETURNS stock_movements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_stock numeric; v_movement public.stock_movements;
begin
  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Branch access denied';
  end if;
  insert into branch_inventory (branch_id, product_id, quantity_on_hand)
  values (p_branch_id, p_product_id, 0)
  on conflict (branch_id, product_id) do nothing;
  update branch_inventory
    set quantity_on_hand = quantity_on_hand + p_quantity_in - p_quantity_out, updated_at = now()
  where branch_id = p_branch_id and product_id = p_product_id
  returning quantity_on_hand into v_stock;
  insert into stock_movements (
    branch_id, product_id, staff_id, movement_type, reference, detail,
    quantity_in, quantity_out, quantity_on_hand_after
  ) values (
    p_branch_id, p_product_id, p_staff_id, p_movement_type, p_reference, p_detail,
    p_quantity_in, p_quantity_out, v_stock
  ) returning * into strict v_movement;
  return v_movement;
end;
$function$;
-- Hardened: mutates stock directly, callable only by an authenticated session.
revoke execute on function public.record_stock_movement(uuid, uuid, uuid, text, numeric, numeric, text, text) from public;
grant execute on function public.record_stock_movement(uuid, uuid, uuid, text, numeric, numeric, text, text) to authenticated;

create or replace function public.refund_sale_items(p_transaction_id uuid, p_staff_id uuid, p_reason text, p_items jsonb, p_approved_by uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_txn transactions;
  v_entry jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_line record;
  v_already numeric;
  v_refund_qty numeric;
  v_amount numeric;
  v_total numeric := 0;
  v_count int := 0;
  v_sold_total numeric;
  v_refunded_total numeric;
  v_fully_voided boolean;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Select at least one item to refund';
  end if;

  select * into v_txn from transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'Transaction not found';
  end if;

  perform public.assert_business_day_mutable(v_txn.branch_id, v_txn.created_at);

  if v_txn.status = 'voided' then
    raise exception 'Transaction already fully refunded / voided';
  end if;
  if v_txn.status is distinct from 'completed' then
    raise exception 'Only completed sales can be refunded';
  end if;

  for v_entry in select * from jsonb_array_elements(p_items)
  loop
    v_item_id := nullif(v_entry->>'item_id', '')::uuid;
    v_qty := coalesce((v_entry->>'quantity')::numeric, 0);
    if v_item_id is null or v_qty <= 0 then
      raise exception 'Invalid refund line';
    end if;

    select ti.id, ti.product_id, ti.quantity, ti.unit_price, ti.line_total
      into v_line
    from transaction_items ti
    where ti.id = v_item_id and ti.transaction_id = p_transaction_id;

    if not found then
      raise exception 'Refund item does not belong to this sale';
    end if;

    select coalesce(sum(quantity), 0) into v_already
    from sale_refund_lines
    where transaction_item_id = v_item_id;

    v_refund_qty := least(v_qty, greatest(0, v_line.quantity - v_already));
    if v_refund_qty <= 0 then
      raise exception 'Item already fully refunded';
    end if;

    v_amount := round((v_line.unit_price * v_refund_qty)::numeric, 2);
    v_total := v_total + v_amount;
    v_count := v_count + 1;

    insert into sale_refund_lines (
      branch_id, transaction_id, transaction_item_id, product_id,
      quantity, amount, staff_id, approved_by, reason
    ) values (
      v_txn.branch_id, p_transaction_id, v_item_id, v_line.product_id,
      v_refund_qty, v_amount, p_staff_id, p_approved_by,
      coalesce(nullif(trim(p_reason), ''), 'Item refund')
    );

    begin
      perform record_stock_movement(
        v_txn.branch_id,
        v_line.product_id,
        p_staff_id,
        'restock',
        v_refund_qty,
        0,
        v_txn.id::text,
        'Refund restock ' || coalesce(v_txn.or_number, v_txn.id::text)
      );
    exception when others then
      null;
    end;
  end loop;

  insert into sale_events (branch_id, transaction_id, staff_id, event_type, or_number, reason, amount, payload)
  values (
    v_txn.branch_id,
    v_txn.id,
    p_staff_id,
    'refund',
    v_txn.or_number,
    coalesce(nullif(trim(p_reason), ''), 'Item refund'),
    v_total,
    jsonb_build_object('items', p_items, 'approved_by', p_approved_by, 'partial', true)
  );

  select coalesce(sum(quantity), 0) into v_sold_total
  from transaction_items where transaction_id = p_transaction_id;

  select coalesce(sum(quantity), 0) into v_refunded_total
  from sale_refund_lines where transaction_id = p_transaction_id;

  v_fully_voided := v_sold_total > 0 and v_refunded_total >= v_sold_total;

  update transactions
  set refunded_amount = coalesce(refunded_amount, 0) + v_total
  where id = p_transaction_id;

  if v_fully_voided then
    update transactions
    set status = 'voided',
        void_reason = coalesce(nullif(trim(p_reason), ''), 'Fully refunded'),
        voided_at = now(),
        voided_by = p_staff_id,
        void_approved_by = p_approved_by
    where id = p_transaction_id;

    insert into sale_events (branch_id, transaction_id, staff_id, event_type, or_number, reason, amount, payload)
    values (
      v_txn.branch_id,
      v_txn.id,
      p_staff_id,
      'void',
      v_txn.or_number,
      'Auto-void after full item refund',
      v_txn.total_amount,
      jsonb_build_object('from_full_item_refund', true, 'approved_by', p_approved_by)
    );
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_txn.branch_id,
    p_staff_id,
    'sale_refund',
    'Refunded ' || v_count || ' line(s) on ' || coalesce(v_txn.or_number, v_txn.id::text),
    jsonb_build_object('transaction_id', v_txn.id, 'amount', v_total, 'reason', p_reason)
  );

  return jsonb_build_object(
    'ok', true,
    'refunded_amount', v_total,
    'line_count', v_count,
    'fully_voided', v_fully_voided
  );
end;
$function$;
-- Hardened: mutates immutable sales records, callable only by an authenticated session.
revoke execute on function public.refund_sale_items(uuid, uuid, text, jsonb, uuid) from public;
grant execute on function public.refund_sale_items(uuid, uuid, text, jsonb, uuid) to authenticated;

create or replace function public.reject_day_end_request(p_day_end_id uuid, p_staff_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS day_ends
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.day_ends;
  v_reason text;
begin
  if not public.is_supervisor_or_above() then
    raise exception 'Only supervisors or managers can decline a day end request';
  end if;

  v_reason := nullif(trim(coalesce(p_reason, '')), '');

  update public.day_ends
  set status = 'rejected',
      rejected_at = now(),
      rejected_by = p_staff_id,
      reject_reason = v_reason,
      requested_at = null,
      requested_by = null,
      request_manager = false
  where id = p_day_end_id
    and status = 'requested'
  returning * into v_row;

  if not found then
    raise exception 'No pending day end request found to decline';
  end if;

  insert into public.audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id,
    p_staff_id,
    'day_end_request_declined',
    'Declined day end request for ' || v_row.business_date::text
      || case when v_reason is not null then ': ' || left(v_reason, 200) else '' end,
    jsonb_build_object('day_end_id', v_row.id, 'business_date', v_row.business_date, 'reason', v_reason)
  );

  return v_row;
end;
$function$;

create or replace function public.reject_promo_event(p_promo_event_id uuid, p_staff_id uuid, p_reason text)
 RETURNS promo_events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.promo_events;
  v_reason text;
begin
  if not public.is_manager() then
    raise exception 'Only managers can reject promos';
  end if;

  v_reason := nullif(trim(p_reason), '');
  if v_reason is null then
    raise exception 'Reject reason is required';
  end if;

  update promo_events
  set status = 'rejected',
      approved_by = p_staff_id,
      approved_at = now(),
      reject_reason = v_reason
  where id = p_promo_event_id
    and status = 'pending'
  returning * into v_row;

  if not found then
    raise exception 'No pending promo found to reject';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'promo_rejected',
    'Rejected promo: ' || v_row.name || ' — ' || left(v_reason, 200),
    jsonb_build_object('promo_event_id', v_row.id, 'reason', v_reason)
  );

  return v_row;
end;
$function$;

create or replace function public.reject_refund_request(p_request_id uuid, p_staff_id uuid, p_reason text)
 RETURNS refund_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.refund_requests;
  v_reason text;
begin
  if not public.is_manager() then
    raise exception 'Only managers can reject refund requests';
  end if;

  v_reason := nullif(trim(p_reason), '');
  if v_reason is null then
    raise exception 'Reject reason is required';
  end if;

  update refund_requests
  set status = 'rejected', approved_by = p_staff_id, approved_at = now(), reject_reason = v_reason
  where id = p_request_id and status = 'pending'
  returning * into v_row;

  if not found then
    raise exception 'No pending refund request found';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'refund_request_rejected',
    'Rejected refund request on ' || v_row.transaction_id::text || ' — ' || left(v_reason, 200),
    jsonb_build_object('refund_request_id', v_row.id, 'transaction_id', v_row.transaction_id, 'reason', v_reason)
  );

  return v_row;
end;
$function$;

create or replace function public.reject_stop_promo(p_promo_event_id uuid, p_staff_id uuid)
 RETURNS promo_events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.promo_events;
begin
  if not public.is_manager() then
    raise exception 'Only managers can reject promo stop';
  end if;

  update promo_events
  set status = 'active',
      stop_requested_by = null,
      stop_reason = null
  where id = p_promo_event_id
    and status = 'stop_pending'
  returning * into v_row;

  if not found then
    raise exception 'No stop-pending promo found';
  end if;

  return v_row;
end;
$function$;

create or replace function public.release_staff_session(p_staff_id uuid, p_session_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_staff_id is distinct from public.current_staff_id() then
    raise exception 'Not authorized';
  end if;

  update staff
  set active_session_id = null,
      session_heartbeat_at = null
  where id = p_staff_id
    and (active_session_id = p_session_id or active_session_id is null);
  return true;
end;
$function$;

create or replace function public.reopen_day_end(p_day_end_id uuid, p_staff_id uuid, p_reason text)
 RETURNS day_ends
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.day_ends;
  v_reason text;
begin
  if not public.is_manager() then
    raise exception 'Only managers can reopen the till';
  end if;

  v_reason := nullif(trim(p_reason), '');
  if v_reason is null then
    raise exception 'Reopen reason is required';
  end if;

  update day_ends
  set
    status = 'reopened',
    reopened_at = now(),
    reopened_by = p_staff_id,
    reopen_reason = v_reason,
    reopen_requested_at = null,
    reopen_requested_by = null,
    reopen_request_reason = null
  where id = p_day_end_id
    and status = 'closed'
  returning * into v_row;

  if not found then
    raise exception 'Only a closed day can be reopened';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id,
    p_staff_id,
    'day_end_reopen',
    'Reopened till for ' || v_row.business_date::text || ': ' || left(v_reason, 200),
    jsonb_build_object(
      'day_end_id', v_row.id,
      'business_date', v_row.business_date,
      'reason', v_reason
    )
  );

  return v_row;
end;
$function$;

create or replace function public.request_day_end(p_branch_id uuid, p_staff_id uuid, p_business_date date, p_request_manager boolean DEFAULT false)
 RETURNS day_ends
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.day_ends;
begin
  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Not authorized for this branch';
  end if;

  select * into v_row
  from day_ends
  where branch_id = p_branch_id
    and business_date = p_business_date
  for update;

  if found and v_row.status in ('submitted', 'closed') then
    raise exception 'Day end is already % for this business date', v_row.status;
  end if;

  if found then
    update day_ends
    set status = 'requested',
        requested_at = now(),
        requested_by = p_staff_id,
        request_manager = coalesce(p_request_manager, false),
        submitted_at = null,
        submitted_by = null,
        approved_at = null,
        approved_by = null,
        closed_at = null
    where id = v_row.id
    returning * into v_row;
    return v_row;
  end if;

  insert into day_ends (
    branch_id, staff_id, business_date, status,
    requested_at, requested_by, request_manager,
    closed_at, submitted_at, approved_at
  ) values (
    p_branch_id, p_staff_id, p_business_date, 'requested',
    now(), p_staff_id, coalesce(p_request_manager, false),
    null, null, null
  )
  returning * into v_row;

  return v_row;
end;
$function$;

create or replace function public.request_day_reopen(p_day_end_id uuid, p_staff_id uuid, p_reason text)
 RETURNS day_ends
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.day_ends;
  v_reason text;
begin
  select * into v_row from day_ends where id = p_day_end_id for update;
  if not found then
    raise exception 'Day-end record not found';
  end if;

  if v_row.branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Not authorized for this branch';
  end if;

  if v_row.status is distinct from 'closed' then
    raise exception 'Only a closed day can have a reopen requested';
  end if;

  v_reason := nullif(trim(p_reason), '');

  update day_ends
  set
    reopen_requested_at = now(),
    reopen_requested_by = p_staff_id,
    reopen_request_reason = v_reason
  where id = p_day_end_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id,
    p_staff_id,
    'day_end_reopen_requested',
    'Requested reopen for ' || v_row.business_date::text
      || coalesce(': ' || left(v_reason, 200), ''),
    jsonb_build_object('day_end_id', v_row.id, 'business_date', v_row.business_date, 'reason', v_reason)
  );

  return v_row;
end;
$function$;

create or replace function public.request_import_revert(p_batch_id uuid, p_staff_id uuid)
 RETURNS import_batches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_batch public.import_batches;
begin
  select * into v_batch from import_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Import batch not found';
  end if;
  if v_batch.branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Branch access denied';
  end if;
  if v_batch.status <> 'committed' then
    raise exception 'Only a committed import can have a revert requested';
  end if;

  update import_batches
  set status = 'revert_requested', revert_requested_by = p_staff_id, revert_requested_at = now()
  where id = p_batch_id
  returning * into strict v_batch;

  return v_batch;
end;
$function$;
-- Hardened: null-unsafe branch check fixed in migrate_fix_null_unsafe_branch_checks.sql,
-- which also revoked the anon grant here.
revoke execute on function public.request_import_revert(uuid, uuid) from public;
grant execute on function public.request_import_revert(uuid, uuid) to authenticated;

create or replace function public.request_promo_edit(p_promo_event_id uuid, p_staff_id uuid)
 RETURNS promo_events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_source public.promo_events;
  v_new public.promo_events;
  v_rule record;
  v_prod record;
  v_new_rule_id uuid;
begin
  select * into v_source
  from promo_events
  where id = p_promo_event_id
  for update;

  if not found then
    raise exception 'Promo not found';
  end if;

  if v_source.status not in ('active', 'stop_pending') then
    raise exception 'Only live promos can be edited via reapproval';
  end if;

  if exists (
    select 1 from promo_events
    where supersedes_event_id = p_promo_event_id
      and status = 'pending'
  ) then
    raise exception 'An edit for this promo is already pending approval';
  end if;

  insert into promo_events (
    branch_id, name, description, status, starts_at, ends_at,
    requested_by, supersedes_event_id
  )
  values (
    v_source.branch_id,
    v_source.name,
    v_source.description,
    'pending',
    v_source.starts_at,
    v_source.ends_at,
    p_staff_id,
    v_source.id
  )
  returning * into v_new;

  for v_rule in
    select * from promo_rules where promo_event_id = v_source.id
  loop
    insert into promo_rules (
      promo_event_id, rule_type, discount_pct, buy_qty, get_qty, bundle_name
    )
    values (
      v_new.id,
      v_rule.rule_type,
      v_rule.discount_pct,
      v_rule.buy_qty,
      v_rule.get_qty,
      v_rule.bundle_name
    )
    returning id into v_new_rule_id;

    for v_prod in
      select * from promo_rule_products where promo_rule_id = v_rule.id
    loop
      insert into promo_rule_products (
        promo_rule_id, product_id, product_index, quantity_required
      )
      values (
        v_new_rule_id,
        v_prod.product_id,
        v_prod.product_index,
        v_prod.quantity_required
      );
    end loop;
  end loop;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_new.branch_id, p_staff_id, 'promo_edit_requested',
    'Requested edit for promo: ' || v_source.name,
    jsonb_build_object(
      'promo_event_id', v_new.id,
      'supersedes_event_id', v_source.id
    )
  );

  return v_new;
end;
$function$;

create or replace function public.request_refund_approval(p_transaction_id uuid, p_staff_id uuid, p_branch_id uuid, p_mode text, p_reason text, p_items jsonb DEFAULT NULL::jsonb)
 RETURNS refund_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.refund_requests;
begin
  if p_mode not in ('full', 'items') then
    raise exception 'Invalid refund mode';
  end if;
  if p_mode = 'items' and (p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0) then
    raise exception 'Select at least one item to refund';
  end if;

  insert into refund_requests (transaction_id, branch_id, mode, reason, items, requested_by)
  values (
    p_transaction_id, p_branch_id, p_mode,
    coalesce(nullif(trim(p_reason), ''), 'Refund'),
    case when p_mode = 'items' then p_items else null end,
    p_staff_id
  )
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'refund_requested',
    'Requested manager approval for refund on ' || v_row.transaction_id::text,
    jsonb_build_object('refund_request_id', v_row.id, 'transaction_id', v_row.transaction_id, 'mode', v_row.mode)
  );

  return v_row;
exception
  when unique_violation then
    raise exception 'A refund request is already pending for this sale';
end;
$function$;

create or replace function public.request_stop_promo(p_promo_event_id uuid, p_staff_id uuid, p_reason text)
 RETURNS promo_events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.promo_events;
  v_reason text;
begin
  v_reason := nullif(trim(p_reason), '');
  if v_reason is null then
    raise exception 'Stop reason is required';
  end if;

  update promo_events
  set status = 'stop_pending',
      stop_requested_by = p_staff_id,
      stop_reason = v_reason
  where id = p_promo_event_id
    and status = 'active'
  returning * into v_row;

  if not found then
    raise exception 'Only an active promo can request stop';
  end if;

  -- Stay live on POS until stop is approved
  -- is_active remains true

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'promo_stop_requested',
    'Requested stop: ' || v_row.name || ' — ' || left(v_reason, 200),
    jsonb_build_object('promo_event_id', v_row.id, 'reason', v_reason)
  );

  return v_row;
end;
$function$;

create or replace function public.reserve_or_number(p_branch_id uuid, p_or_number text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_prefix text;
  v_next bigint;
  v_seq bigint;
  v_expected text;
begin
  if p_or_number is null or trim(p_or_number) = '' then
    return allocate_or_number(p_branch_id);
  end if;

  select or_prefix, or_next
  into v_prefix, v_next
  from branches
  where id = p_branch_id
  for update;

  if not found then
    raise exception 'Branch not found';
  end if;

  v_seq := nullif(regexp_replace(trim(p_or_number), '^.*[^0-9]', '', 'g'), '')::bigint;
  if v_seq is null or v_seq < 1 then
    raise exception 'Invalid OR number format';
  end if;

  v_expected := coalesce(nullif(trim(v_prefix), ''), 'OR') || '-' || lpad(v_seq::text, 8, '0');
  if trim(p_or_number) <> v_expected then
    raise exception 'OR number does not match branch prefix/sequence';
  end if;

  if exists (
    select 1
    from transactions
    where branch_id = p_branch_id
      and or_number = trim(p_or_number)
  ) then
    raise exception 'OR number already in use';
  end if;

  update branches
  set or_next = greatest(or_next, v_seq + 1)
  where id = p_branch_id;

  return trim(p_or_number);
end;
$function$;
-- Hardened: reserve_or_number/allocate_or_number are the OR-numbering
-- authority for BIR compliance — must never be reachable anonymously.
revoke execute on function public.reserve_or_number(uuid, text) from public;
grant execute on function public.reserve_or_number(uuid, text) to authenticated;

create or replace function public.resolve_flagged_cash_movement(p_id uuid, p_resolved_by uuid, p_notes text DEFAULT NULL::text)
 RETURNS cash_movements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.cash_movements%rowtype;
begin
  if not public.is_manager() then
    raise exception 'MOVE21: only a manager can resolve a flagged movement';
  end if;

  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'flagged_for_investigation' then
    raise exception 'MOVE22: only flagged movements can be resolved this way';
  end if;
  if p_resolved_by is null then
    raise exception 'MOVE19: resolver required';
  end if;

  update public.cash_movements
  set status = 'confirmed',
      reviewed_by = p_resolved_by,
      reviewed_at = now(),
      review_action = 'confirmed',
      review_notes = case
        when nullif(trim(coalesce(p_notes, '')), '') is null then review_notes
        when review_notes is null or length(trim(review_notes)) = 0 then nullif(trim(p_notes), '')
        else review_notes || E'\n' || nullif(trim(p_notes), '')
      end
  where id = p_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_resolved_by, 'cash_movement_resolved',
    'Resolved flagged ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object('cash_movement_id', v_row.id, 'from_status', 'flagged_for_investigation')
  );

  return v_row;
end;
$function$;

create or replace function public.resolve_pin_login(p_login_code text, p_pin text)
 RETURNS TABLE(auth_email text, staff_id uuid, full_name text, role text, branch_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'extensions'
AS $function$
declare
  v_staff public.staff%rowtype;
  v_email text;
  v_pin text;
begin
  if p_login_code is null or length(trim(p_login_code)) < 4 then
    raise exception 'Invalid staff code';
  end if;

  v_pin := trim(coalesce(p_pin, ''));
  if length(v_pin) < 4 then
    raise exception 'Invalid staff code or PIN';
  end if;

  perform public.assert_pin_not_locked(trim(p_login_code));

  select s.* into v_staff
  from public.staff s
  where s.login_code = trim(p_login_code)
    and s.is_active
    and s.role in ('cashier', 'supervisor')
  limit 1;

  if not found then
    perform public.record_pin_login_failure(trim(p_login_code));
    raise exception 'Invalid staff code or PIN';
  end if;

  if v_staff.login_pin is distinct from v_pin then
    perform public.record_pin_login_failure(trim(p_login_code));
    raise exception 'Invalid staff code or PIN';
  end if;

  select u.email into v_email
  from auth.users u
  where u.id = v_staff.auth_user_id;

  if v_email is null then
    raise exception 'Staff account is not linked to a login';
  end if;

  -- Keep Auth password synced to till PIN so client can sign in with PIN (never returned here).
  begin
    update auth.users
    set
      encrypted_password = extensions.crypt(v_pin, extensions.gen_salt('bf')),
      email_confirmed_at = coalesce(email_confirmed_at, now()),
      updated_at = now()
    where id = v_staff.auth_user_id;
  exception
    when undefined_function then
      update auth.users
      set
        encrypted_password = crypt(v_pin, gen_salt('bf')),
        email_confirmed_at = coalesce(email_confirmed_at, now()),
        updated_at = now()
      where id = v_staff.auth_user_id;
  end;

  update public.staff
  set auth_secret = v_pin
  where id = v_staff.id
    and (auth_secret is distinct from v_pin);

  perform public.clear_pin_login_failures(trim(p_login_code));

  auth_email := v_email;
  staff_id := v_staff.id;
  full_name := v_staff.full_name;
  role := v_staff.role;
  branch_id := v_staff.branch_id;
  return next;
end;
$function$;

create or replace function public.resolve_staff_identities(p_ids uuid[])
 RETURNS TABLE(id uuid, full_name text, role text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select s.id, s.full_name, s.role
  from public.staff s
  where s.id = any(p_ids)
    and (
      public.is_manager()
      or s.id = public.current_staff_id()
      or (public.is_supervisor_or_above() and s.branch_id = public.current_staff_branch())
    );
$function$;

create or replace function public.resolve_till_action_request(p_id uuid, p_resolved_by uuid, p_status text, p_ack boolean DEFAULT false)
 RETURNS till_action_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.till_action_requests%rowtype;
begin
  if p_status not in ('approved', 'denied', 'self_allowed', 'cancelled') then
    raise exception 'TILL_ACT02: invalid status';
  end if;

  select * into v_row from public.till_action_requests where id = p_id for update;
  if not found then
    raise exception 'TILL_ACT03: request not found';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'TILL_ACT04: request already resolved';
  end if;

  if p_resolved_by = v_row.requested_by then
    raise exception 'TILL_ACT08: cannot resolve your own request';
  end if;

  if p_status = 'self_allowed' then
    if v_row.requested_by is distinct from p_resolved_by then
      raise exception 'TILL_ACT05: only requester can self-allow';
    end if;
    if p_ack is not true then
      raise exception 'TILL_ACT06: acknowledgment required';
    end if;
  elsif p_status in ('approved', 'denied') then
    if public.is_manager()
       or (
         public.is_supervisor_or_above()
         and public.current_staff_id() is distinct from v_row.requested_by
       ) then
      null;
    elsif p_status = 'approved'
      and public.current_staff_id() = v_row.requested_by
      and exists (
        select 1
        from public.staff s
        where s.id = p_resolved_by
          and s.branch_id = v_row.branch_id
          and s.is_active
          and s.role in ('supervisor', 'manager', 'admin', 'master')
      ) then
      -- Cashier till clearing the remote alert after an on-site supervisor PIN.
      null;
    else
      raise exception 'TILL_ACT07: supervisor or manager required';
    end if;
  elsif p_status = 'cancelled' then
    if v_row.requested_by is distinct from p_resolved_by
       and not (public.is_manager() or public.is_supervisor_or_above()) then
      raise exception 'TILL_ACT09: only requester, supervisor, or manager can cancel';
    end if;
  end if;

  update public.till_action_requests
  set status = p_status,
      resolved_by = p_resolved_by,
      resolved_at = now(),
      self_record_ack = case when p_status = 'self_allowed' then true else self_record_ack end
  where id = p_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_resolved_by, 'till_action_' || p_status,
    v_row.detail,
    jsonb_build_object('till_action_id', v_row.id, 'action', v_row.action, 'status', p_status)
  );

  return v_row;
end;
$function$;

create or replace function public.reveal_staff_pin(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row jsonb;
begin
  if not public.is_manager() then
    raise exception 'Not authorized to reveal staff PIN';
  end if;

  select jsonb_build_object(
    'id', s.id,
    'full_name', s.full_name,
    'login_code', s.login_code,
    'login_pin', s.login_pin,
    'role', s.role
  )
  into v_row
  from public.staff s
  where s.id = p_staff_id;

  if v_row is null then
    raise exception 'Staff not found';
  end if;

  return v_row;
end;
$function$;

create or replace function public.revert_import_batch(p_batch_id uuid, p_staff_id uuid)
 RETURNS import_batches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_batch public.import_batches;
  v_item public.import_batch_items;
begin
  if not public.is_manager() then
    raise exception 'Only managers can revert imports';
  end if;

  select * into v_batch from import_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Import batch not found';
  end if;
  if v_batch.status = 'reverted' then
    raise exception 'Import already reverted';
  end if;

  for v_item in
    select * from import_batch_items where batch_id = p_batch_id
  loop
    if v_item.quantity_added > 0 then
      perform public.record_stock_movement(
        v_batch.branch_id,
        v_item.product_id,
        p_staff_id,
        'adjustment',
        0,
        v_item.quantity_added,
        'revert:' || p_batch_id::text,
        'Revert import ' || coalesce(v_batch.filename, '')
      );
    end if;
    if v_item.action = 'create' then
      update products set is_active = false where id = v_item.product_id;
    end if;
  end loop;

  update import_batches
  set status = 'reverted', reverted_at = now(), reverted_by = p_staff_id
  where id = p_batch_id
  returning * into strict v_batch;

  return v_batch;
end;
$function$;

create or replace function public.review_cash_movement(p_id uuid, p_reviewed_by uuid, p_action text, p_notes text DEFAULT NULL::text)
 RETURNS cash_movements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.cash_movements%rowtype;
  v_status text;
begin
  if not (public.is_manager() or public.is_supervisor_or_above()) then
    raise exception 'MOVE16: only supervisor or manager can review';
  end if;
  if p_action not in ('confirmed', 'flagged_for_investigation') then
    raise exception 'MOVE17: invalid review action';
  end if;

  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'self_recorded' then
    raise exception 'MOVE18: only self_recorded movements need review';
  end if;
  if p_reviewed_by is null or p_reviewed_by = v_row.requested_by then
    raise exception 'MOVE19: reviewer cannot be the requester';
  end if;
  if not public.is_manager()
     and v_row.branch_id is distinct from public.current_staff_branch() then
    raise exception 'MOVE20: wrong branch';
  end if;

  v_status := p_action; -- confirmed | flagged_for_investigation

  update public.cash_movements
  set status = v_status,
      reviewed_by = p_reviewed_by,
      reviewed_at = now(),
      review_action = p_action,
      review_notes = nullif(trim(coalesce(p_notes, '')), '')
  where id = p_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_reviewed_by, 'cash_movement_reviewed',
    'Reviewed ' || v_row.type || ' as ' || p_action,
    jsonb_build_object('cash_movement_id', v_row.id, 'action', p_action)
  );

  return v_row;
end;
$function$;

-- Attached below (section 8) as an event trigger: keeps RLS on for any new
-- public table even if a future migration forgets an explicit ENABLE ROW
-- LEVEL SECURITY — defense in depth, not a substitute for section 4 above.
create or replace function public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

create or replace function public.role_rank(p_role text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case p_role
    when 'cashier'    then 10
    when 'supervisor' then 20
    when 'manager'    then 30
    when 'admin'      then 40  -- retired; should not appear on staff rows
    when 'master'     then 50
    else 0
  end;
$function$;

create or replace function public.save_staff_pin_verifier(p_staff_id uuid, p_verifier jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_staff_id is null or p_verifier is null then
    raise exception 'Staff id and verifier required';
  end if;
  if not public.is_manager() then
    raise exception 'Not authorized';
  end if;
  update public.staff
  set pin_verifier = p_verifier
  where id = p_staff_id;
  if not found then
    raise exception 'Staff not found';
  end if;
end;
$function$;

create or replace function public.self_record_cash_movement(p_id uuid, p_staff_id uuid, p_ack boolean)
 RETURNS cash_movements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.cash_movements%rowtype;
begin
  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'pending_remote' then
    raise exception 'MOVE11: movement is not awaiting approval';
  end if;
  if v_row.requested_by is distinct from p_staff_id then
    raise exception 'MOVE14: only the requester can self-record';
  end if;
  if p_ack is not true then
    raise exception 'MOVE15: acknowledgment required';
  end if;
  if nullif(trim(coalesce(v_row.reason, '')), '') is null then
    raise exception 'MOVE03: reason is required';
  end if;

  perform public.validate_cash_movement_opening_float(v_row.shift_id, v_row.type);

  update public.cash_movements
  set status = 'self_recorded',
      self_record_ack = true,
      self_recorded_at = now()
  where id = p_id
  returning * into v_row;

  perform public.apply_counted_cash_movement_effects(v_row);

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'cash_movement_self_recorded',
    'Self-recorded ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object('cash_movement_id', v_row.id)
  );

  return v_row;
end;
$function$;

create or replace function public.shift_cash_summary(p_shift_id uuid)
 RETURNS TABLE(starting_cash numeric, cash_sales numeric, cash_refunds numeric, cash_paid_out numeric, cash_pickups numeric, expected_cash numeric, sale_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with s as (
    select * from public.staff_shifts
    where id = p_shift_id
      and (
        staff_id = public.current_staff_id()
        or public.is_manager()
        or (public.is_supervisor_or_above() and branch_id = public.current_staff_branch())
      )
  ),
  t as (
    select
      coalesce(sum(case when status = 'completed' then total_amount else 0 end), 0) as sales,
      coalesce(sum(case when status = 'completed' then coalesce(refunded_amount, 0) else 0 end), 0) as refunds,
      count(*) filter (where status = 'completed') as sale_count
    from public.transactions
    where shift_id = p_shift_id and coalesce(payment_method, 'cash') = 'cash'
  ),
  c as (
    select
      coalesce(sum(case when kind = 'paid_out' and status = 'fulfilled' then amount else 0 end), 0) as paid_out,
      coalesce(sum(case when kind = 'pickup' then amount else 0 end), 0) as pickups
    from public.cash_drawer_entries
    where shift_id = p_shift_id
  ),
  m as (
    select
      coalesce(sum(case when type = 'petty_cash' then amount else 0 end), 0) as paid_out,
      coalesce(sum(case when type = 'pickup' then amount else 0 end), 0) as pickups,
      coalesce(sum(case when type = 'cash_in' then amount else 0 end), 0) as cash_in
    from public.cash_movements
    where shift_id = p_shift_id
      and public.cash_movement_counts(status)
  )
  select
    coalesce(s.starting_cash, 0),
    t.sales,
    t.refunds,
    c.paid_out + m.paid_out,
    c.pickups + m.pickups,
    round(
      coalesce(s.starting_cash, 0) + m.cash_in + t.sales - t.refunds
      - (c.paid_out + m.paid_out) - (c.pickups + m.pickups),
      2
    ),
    t.sale_count::integer
  from s, t, c, m;
$function$;
-- Hardened: exposes a shift's cash figures; authenticated staff only.
revoke execute on function public.shift_cash_summary(uuid) from public;
grant execute on function public.shift_cash_summary(uuid) to authenticated;

create or replace function public.staff_can_subscribe_branch(p_branch_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_branch_id is not null
    and (
      p_branch_id = public.current_staff_branch()
      or public.is_manager()
    );
$function$;
-- Explicit grant: Realtime Broadcast authorization check (see
-- migrate_realtime_broadcast_v1.sql / migrate_realtime_broadcast_policies.sql)
-- — called for the Realtime authorize request before a client is fully
-- signed in, so both anon and authenticated need EXECUTE.
revoke execute on function public.staff_can_subscribe_branch(uuid) from public;
grant execute on function public.staff_can_subscribe_branch(uuid) to anon, authenticated;

create or replace function public.staff_shifts_freeze_closed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- Only guards a shift that was ALREADY closed. Closing one (clock_out going from null
  -- to a value) writes all of these in the same statement and must be allowed.
  if old.clock_out is null then
    return new;
  end if;

  if coalesce(current_setting('calepos.shift_adjustment', true), '') = 'on' then
    return new;
  end if;

  if new.starting_cash is distinct from old.starting_cash
     or new.ending_cash is distinct from old.ending_cash
     or new.expected_cash is distinct from old.expected_cash
     or new.variance is distinct from old.variance
     or new.clock_in is distinct from old.clock_in
     or new.clock_out is distinct from old.clock_out
     or new.staff_id is distinct from old.staff_id
     or new.drawer_id is distinct from old.drawer_id then
    raise exception 'SHIFT_CLOSED: a closed shift''s cash figures cannot be edited — record an adjustment instead';
  end if;

  return new;
end $function$;

create or replace function public.submit_day_end(p_branch_id uuid, p_staff_id uuid, p_business_date date, p_recorded_cash numeric, p_cash_on_hand numeric, p_variance numeric, p_expected_cash numeric, p_note text DEFAULT NULL::text, p_day_report jsonb DEFAULT NULL::jsonb, p_day_end_id uuid DEFAULT NULL::uuid)
 RETURNS day_ends
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.day_ends;
begin
  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Not authorized for this branch';
  end if;

  select * into v_row
  from day_ends
  where branch_id = p_branch_id
    and business_date = p_business_date
  for update;

  if found and v_row.status = 'closed' then
    raise exception 'Day is already closed';
  end if;

  if found then
    update day_ends
    set
      staff_id = p_staff_id,
      recorded_cash = p_recorded_cash,
      cash_on_hand = p_cash_on_hand,
      variance = p_variance,
      expected_cash = p_expected_cash,
      note = p_note,
      day_report = coalesce(p_day_report, day_report),
      status = 'submitted',
      submitted_at = now(),
      submitted_by = p_staff_id,
      approved_at = null,
      approved_by = null,
      closed_at = coalesce(closed_at, now()),
      requested_at = null,
      requested_by = null,
      request_manager = false,
      reopened_at = null,
      reopened_by = null,
      reopen_reason = null,
      reopen_requested_at = null,
      reopen_requested_by = null,
      reopen_request_reason = null
    where id = v_row.id
    returning * into v_row;
  else
    insert into day_ends (
      branch_id, staff_id, business_date,
      recorded_cash, cash_on_hand, variance, expected_cash,
      note, day_report, status,
      submitted_at, submitted_by, closed_at
    ) values (
      p_branch_id, p_staff_id, p_business_date,
      p_recorded_cash, p_cash_on_hand, p_variance, p_expected_cash,
      p_note, p_day_report, 'submitted',
      now(), p_staff_id, now()
    )
    returning * into v_row;
  end if;

  if public.is_supervisor_or_above() then
    return public.approve_day_end(v_row.id, p_staff_id);
  end if;

  return v_row;
end;
$function$;

create or replace function public.tg_branch_inventory_broadcast()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.broadcast_pos_event(
    new.branch_id,
    'inventory',
    'INVENTORY_CHANGED',
    jsonb_build_object(
      'product_id', new.product_id,
      'version', new.change_version
    )
  );
  return null;
end;
$function$;

create or replace function public.tg_branch_inventory_bump_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.change_version := coalesce(old.change_version, 0) + 1;
  new.updated_at := coalesce(new.updated_at, now());
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end;
$function$;

create or replace function public.tg_ops_broadcast()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_branch uuid;
begin
  v_branch := coalesce(new.branch_id, old.branch_id);
  if v_branch is null then
    return null;
  end if;
  perform public.broadcast_pos_event(
    v_branch,
    'operations',
    'OPERATIONS_CHANGED',
    jsonb_build_object('kind', tg_table_name, 'op', tg_op)
  );
  return null;
end;
$function$;

create or replace function public.tg_products_catalog_broadcast()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'UPDATE'
     and new.price is not distinct from old.price
     and new.name is not distinct from old.name
     and new.is_active is not distinct from old.is_active
     and new.discount_eligible is not distinct from old.discount_eligible
     and new.available_today is not distinct from old.available_today
     and new.budget_price is not distinct from old.budget_price
  then
    return null;
  end if;

  perform public.broadcast_pos_event(
    new.branch_id,
    'inventory',
    'CATALOG_CHANGED',
    jsonb_build_object('product_id', new.id)
  );
  return null;
end;
$function$;

create or replace function public.touch_cash_movement_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

-- Attaches to auth.users (see section 8 header note): stamps
-- email_confirmed_at for the app's synthetic PIN-login auth users
-- (pin.<code>@calepos.local) so they can sign in without a real email flow.
create or replace function public.trg_confirm_pin_auth_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'extensions'
AS $function$
begin
  if new.email is not null and new.email like 'pin.%@calepos.local' then
    new.email_confirmed_at := coalesce(new.email_confirmed_at, now());
  end if;
  return new;
end;
$function$;

create or replace function public.validate_cash_movement_opening_float(p_shift_id uuid, p_type text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_shift public.staff_shifts%rowtype;
begin
  if p_type <> 'opening_float' then
    return;
  end if;
  select * into v_shift from public.staff_shifts where id = p_shift_id;
  if not found then
    raise exception 'MOVE05: shift not found';
  end if;
  if coalesce(v_shift.starting_cash, 0) > 0 then
    raise exception 'MOVE20: opening float only when shift has no float yet';
  end if;
end;
$function$;
-- Hardened: internal helper called only from the cash-movement RPCs above.
revoke execute on function public.validate_cash_movement_opening_float(uuid, text) from public;
revoke execute on function public.validate_cash_movement_opening_float(uuid, text) from authenticated;

create or replace function public.verify_own_pin(p_staff_id uuid, p_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ok boolean;
begin
  -- Must be the currently authenticated staff member
  if p_staff_id is distinct from (
    select id from staff where auth_user_id = auth.uid() and is_active limit 1
  ) then
    raise exception 'Not authorized';
  end if;

  select exists (
    select 1
    from staff s
    where s.id = p_staff_id
      and s.is_active
      and s.login_pin is not null
      and s.login_pin = trim(p_pin)
  ) into v_ok;

  if not v_ok then
    -- Also allow Auth password for email-login managers unlocking
    begin
      -- Fallback: PIN matches auth_secret hash path not available here;
      -- email managers unlock via client signIn check. Return false.
      null;
    end;
  end if;

  if not coalesce(v_ok, false) then
    raise exception 'Invalid PIN';
  end if;
  return true;
end;
$function$;

create or replace function public.verify_supervisor_pin(p_branch_id uuid, p_login_code text, p_pin text)
 RETURNS TABLE(staff_id uuid, full_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_staff public.staff%rowtype;
  v_pin text;
begin
  if p_branch_id is null then
    raise exception 'Branch required';
  end if;

  v_pin := trim(coalesce(p_pin, ''));
  if p_login_code is null or length(trim(p_login_code)) < 4 or length(v_pin) < 4 then
    raise exception 'Invalid supervisor code or PIN';
  end if;

  perform public.assert_pin_not_locked(trim(p_login_code));

  -- Branch supervisors first
  select s.* into v_staff
  from public.staff s
  where s.login_code = trim(p_login_code)
    and s.is_active
    and s.branch_id = p_branch_id
    and s.role = 'supervisor'
  limit 1;

  -- Managers / admin / master may approve any cashier branch (cover when supervisor away)
  if not found then
    select s.* into v_staff
    from public.staff s
    where s.login_code = trim(p_login_code)
      and s.is_active
      and s.role in ('manager', 'admin', 'master')
    limit 1;
  end if;

  if not found or v_staff.login_pin is distinct from v_pin then
    perform public.record_pin_login_failure(trim(p_login_code));
    raise exception 'Invalid supervisor code or PIN';
  end if;

  perform public.clear_pin_login_failures(trim(p_login_code));

  staff_id := v_staff.id;
  full_name := v_staff.full_name;
  return next;
end;
$function$;

create or replace function public.void_sale_secure(p_transaction_id uuid, p_staff_id uuid, p_reason text, p_approved_by uuid DEFAULT NULL::uuid)
 RETURNS transactions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_txn transactions;
  v_line record;
begin
  select * into v_txn from transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'Transaction not found';
  end if;

  perform public.assert_business_day_mutable(v_txn.branch_id, v_txn.created_at);

  if v_txn.status = 'voided' then
    raise exception 'Transaction already voided';
  end if;

  update transactions
  set
    status = 'voided',
    void_reason = coalesce(nullif(trim(p_reason), ''), 'Voided'),
    voided_at = now(),
    voided_by = p_staff_id,
    void_approved_by = p_approved_by
  where id = p_transaction_id
  returning * into v_txn;

  for v_line in
    select product_id, quantity from transaction_items where transaction_id = p_transaction_id
  loop
    perform record_stock_movement(
      v_txn.branch_id,
      v_line.product_id,
      p_staff_id,
      'restock',
      v_line.quantity,
      0,
      v_txn.id::text,
      'Void restock ' || coalesce(v_txn.or_number, v_txn.id::text)
    );
  end loop;

  insert into sale_events (branch_id, transaction_id, staff_id, event_type, or_number, reason, amount, payload)
  values (
    v_txn.branch_id,
    v_txn.id,
    p_staff_id,
    'void',
    v_txn.or_number,
    v_txn.void_reason,
    v_txn.total_amount,
    jsonb_build_object('voided_at', v_txn.voided_at, 'approved_by', p_approved_by)
  );

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_txn.branch_id,
    p_staff_id,
    'sale_void',
    'Voided ' || coalesce(v_txn.or_number, v_txn.id::text),
    jsonb_build_object('transaction_id', v_txn.id, 'reason', v_txn.void_reason)
  );

  return v_txn;
end;
$function$;
-- Hardened: fiscal RPC (voids a sale record); authenticated staff only.
revoke execute on function public.void_sale_secure(uuid, uuid, text, uuid) from public;
grant execute on function public.void_sale_secure(uuid, uuid, text, uuid) to authenticated;

-- =============================================================================
-- 6. TRIGGERS
--    Every function referenced below already exists from section 5. The two
--    auth.users triggers are this app's own provisioning hooks attached to a
--    Supabase-managed table; nothing else under auth/storage is touched.
-- =============================================================================
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
create trigger confirm_pin_auth_user before insert or update of email on auth.users for each row execute function public.trg_confirm_pin_auth_user();

create trigger trg_assign_product_no before insert on public.products for each row execute function public.assign_product_no();
create trigger trg_link_product_to_catalog before insert or update of sku on public.products for each row execute function public.link_product_to_catalog();
create trigger trg_products_catalog_broadcast after insert or update on public.products for each row execute function public.tg_products_catalog_broadcast();

create trigger trg_branch_inventory_bump_version before update on public.branch_inventory for each row execute function public.tg_branch_inventory_bump_version();
create trigger trg_branch_inventory_broadcast after insert or update on public.branch_inventory for each row execute function public.tg_branch_inventory_broadcast();

create trigger trg_guard_transaction_updates before delete or update on public.transactions for each row execute function public.guard_transaction_updates();
create trigger trg_transactions_ops_broadcast after insert or delete or update on public.transactions for each row execute function public.tg_ops_broadcast();

create trigger trg_no_update_transaction_items before delete or update on public.transaction_items for each row execute function public.prevent_transaction_item_mutation();

create trigger staff_role_ceiling before insert or update on public.staff for each row execute function public.enforce_staff_role_ceiling();

create trigger staff_shifts_freeze_closed before update on public.staff_shifts for each row execute function public.staff_shifts_freeze_closed();
create trigger trg_staff_shifts_ops_broadcast after insert or delete or update on public.staff_shifts for each row execute function public.tg_ops_broadcast();

create trigger trg_cash_drawer_entries_ops_broadcast after insert or delete or update on public.cash_drawer_entries for each row execute function public.tg_ops_broadcast();

create trigger trg_cash_movements_updated_at before update on public.cash_movements for each row execute function public.touch_cash_movement_updated_at();
create trigger trg_cash_movements_ops_broadcast after insert or delete or update on public.cash_movements for each row execute function public.tg_ops_broadcast();

create trigger trg_day_ends_ops_broadcast after insert or delete or update on public.day_ends for each row execute function public.tg_ops_broadcast();
create trigger trg_import_batches_ops_broadcast after insert or delete or update on public.import_batches for each row execute function public.tg_ops_broadcast();
create trigger trg_promo_events_ops_broadcast after insert or delete or update on public.promo_events for each row execute function public.tg_ops_broadcast();
create trigger trg_refund_requests_ops_broadcast after insert or delete or update on public.refund_requests for each row execute function public.tg_ops_broadcast();
create trigger trg_till_action_requests_ops_broadcast after insert or delete or update on public.till_action_requests for each row execute function public.tg_ops_broadcast();

-- =============================================================================
-- 7. RLS POLICIES
--    One row per (table, policy) from pg_policies on CalePOS_Demo. All are
--    PERMISSIVE, scoped to `authenticated` unless noted. Where a table has no
--    INSERT/UPDATE/DELETE policy below (e.g. cash_movements, refund_requests,
--    till_action_requests, shift_adjustments), writes to it are intentionally
--    only reachable through a SECURITY DEFINER RPC in section 5 — this is by
--    design (RLS is bypassed inside a SECURITY DEFINER body owned by the
--    table owner), not a gap to fill with a matching direct-write policy.
-- =============================================================================

-- branches
create policy "read branches" on public.branches for select to authenticated
  using (id = current_staff_branch() or is_manager());
create policy "managers write branches" on public.branches for all to authenticated
  using (is_manager()) with check (is_manager());

-- roles
create policy "read roles" on public.roles for select to authenticated using (true);
create policy "managers write roles" on public.roles for all to authenticated
  using (is_manager()) with check (is_manager());

-- staff
create policy "read staff" on public.staff for select to authenticated
  using (auth_user_id = (select auth.uid()) or is_manager());
create policy "managers manage staff" on public.staff for all to authenticated
  using (is_manager()) with check (is_manager());

-- categories
create policy "read categories" on public.categories for select to authenticated using (true);
create policy "managers write categories" on public.categories for all to authenticated
  using (is_manager()) with check (is_manager());

-- catalog_products
create policy "read catalog products" on public.catalog_products for select to authenticated using (true);
create policy "managers write catalog products" on public.catalog_products for all to authenticated
  using (is_manager()) with check (is_manager());

-- products
create policy "read products" on public.products for select to authenticated
  using ((branch_id = current_staff_branch() and is_active = true) or is_manager());
create policy "write products" on public.products for all to authenticated
  using (branch_id = current_staff_branch() or is_manager())
  with check (branch_id = current_staff_branch() or is_manager());

-- branch_inventory
create policy "read inventory" on public.branch_inventory for select to authenticated
  using (branch_id = current_staff_branch() or is_manager());
create policy "write inventory privileged" on public.branch_inventory for all to authenticated
  using (is_manager() or (is_supervisor_or_above() and branch_id = current_staff_branch()))
  with check (is_manager() or (is_supervisor_or_above() and branch_id = current_staff_branch()));

-- stock_movements
create policy "read movements" on public.stock_movements for select to authenticated
  using (branch_id = current_staff_branch() or is_manager());
create policy "write movements" on public.stock_movements for insert to authenticated
  with check (branch_id = current_staff_branch() or is_manager());

-- transactions
create policy "read transactions" on public.transactions for select to authenticated
  using (branch_id = current_staff_branch() or is_manager());
create policy "write transactions" on public.transactions for insert to authenticated
  with check (branch_id = current_staff_branch() or is_manager());
create policy "update transactions" on public.transactions for update to authenticated
  using (branch_id = current_staff_branch() or is_manager())
  with check (branch_id = current_staff_branch() or is_manager());

-- transaction_items
create policy "read txn items" on public.transaction_items for select to authenticated
  using (exists (select 1 from transactions t where t.id = transaction_items.transaction_id
    and (t.branch_id = current_staff_branch() or is_manager())));
create policy "write txn items" on public.transaction_items for insert to authenticated
  with check (exists (select 1 from transactions t where t.id = transaction_items.transaction_id
    and (t.branch_id = current_staff_branch() or is_manager())));

-- sale_events (append-only: no update/delete policy at all)
create policy "read sale events" on public.sale_events for select to authenticated
  using (branch_id = current_staff_branch() or is_manager());
create policy "insert sale events" on public.sale_events for insert to authenticated
  with check (branch_id = current_staff_branch() or is_manager());
create policy "no update sale events" on public.sale_events for update to authenticated
  using (false) with check (false);
create policy "no delete sale events" on public.sale_events for delete to authenticated
  using (false);

-- sale_refund_lines
create policy "read sale refund lines" on public.sale_refund_lines for select to authenticated
  using (branch_id = current_staff_branch() or is_manager());
create policy "insert sale refund lines" on public.sale_refund_lines for insert to authenticated
  with check (branch_id = current_staff_branch() or is_manager());

-- refund_requests (approve/reject/cancel go through RPCs, no direct update policy)
create policy "read refund requests" on public.refund_requests for select to authenticated
  using (branch_id = current_staff_branch() or is_manager());
create policy "create refund requests" on public.refund_requests for insert to authenticated
  with check (branch_id = current_staff_branch() or is_manager());

-- promo_events
create policy "branch staff reads promo events" on public.promo_events for select to authenticated
  using (branch_id = current_staff_branch() or is_manager());
create policy "managers manage promo events" on public.promo_events for all to authenticated
  using (is_manager() or (current_staff_role() = 'supervisor' and branch_id = current_staff_branch()))
  with check (is_manager() or (current_staff_role() = 'supervisor' and branch_id = current_staff_branch()));

-- promo_rules
create policy "branch staff reads promo rules" on public.promo_rules for select to authenticated
  using (exists (select 1 from promo_events e where e.id = promo_rules.promo_event_id
    and (e.branch_id = current_staff_branch() or is_manager())));
create policy "managers manage promo rules" on public.promo_rules for all to authenticated
  using (exists (select 1 from promo_events e where e.id = promo_rules.promo_event_id
    and (is_manager() or (current_staff_role() = 'supervisor' and e.branch_id = current_staff_branch()))))
  with check (exists (select 1 from promo_events e where e.id = promo_rules.promo_event_id
    and (is_manager() or (current_staff_role() = 'supervisor' and e.branch_id = current_staff_branch()))));

-- promo_rule_products
create policy "branch staff reads promo rule products" on public.promo_rule_products for select to authenticated
  using (exists (select 1 from promo_rules r join promo_events e on e.id = r.promo_event_id
    where r.id = promo_rule_products.promo_rule_id and (e.branch_id = current_staff_branch() or is_manager())));
create policy "managers manage promo rule products" on public.promo_rule_products for all to authenticated
  using (exists (select 1 from promo_rules r join promo_events e on e.id = r.promo_event_id
    where r.id = promo_rule_products.promo_rule_id
      and (is_manager() or (current_staff_role() = 'supervisor' and e.branch_id = current_staff_branch()))))
  with check (exists (select 1 from promo_rules r join promo_events e on e.id = r.promo_event_id
    where r.id = promo_rule_products.promo_rule_id
      and (is_manager() or (current_staff_role() = 'supervisor' and e.branch_id = current_staff_branch()))));

-- day_ends
create policy "read day ends" on public.day_ends for select to authenticated
  using (branch_id = current_staff_branch() or is_manager());
create policy "write day ends" on public.day_ends for insert to authenticated
  with check (branch_id = current_staff_branch() or is_manager());
create policy "update day ends" on public.day_ends for update to authenticated
  using (branch_id = current_staff_branch() or is_manager())
  with check (branch_id = current_staff_branch() or is_manager());

-- import_batches / import_batch_items
create policy "branch read import batches" on public.import_batches for select to authenticated
  using (branch_id = current_staff_branch() or is_manager());
create policy "branch write import batches" on public.import_batches for all to authenticated
  using (branch_id = current_staff_branch() or is_manager())
  with check (branch_id = current_staff_branch() or is_manager());
create policy "branch read import items" on public.import_batch_items for select to authenticated
  using (exists (select 1 from import_batches b where b.id = import_batch_items.batch_id
    and (b.branch_id = current_staff_branch() or is_manager())));
create policy "branch write import items" on public.import_batch_items for all to authenticated
  using (exists (select 1 from import_batches b where b.id = import_batch_items.batch_id
    and (b.branch_id = current_staff_branch() or is_manager())))
  with check (exists (select 1 from import_batches b where b.id = import_batch_items.batch_id
    and (b.branch_id = current_staff_branch() or is_manager())));

-- staff_shifts (a shift's holder can update their own OPEN shift only; closing/adjusting
-- a closed shift's cash figures goes through close_staff_shift()/adjust_shift_cash())
create policy "staff read own shifts" on public.staff_shifts for select to authenticated
  using (staff_id = current_staff_id() or is_manager()
    or (is_supervisor_or_above() and branch_id = current_staff_branch()));
create policy "staff open own shift" on public.staff_shifts for insert to authenticated
  with check ((staff_id = current_staff_id() and branch_id = current_staff_branch())
    or is_manager() or (is_supervisor_or_above() and branch_id = current_staff_branch()));
create policy "staff update own open shift" on public.staff_shifts for update to authenticated
  using ((staff_id = current_staff_id() and clock_out is null)
    or is_manager() or (is_supervisor_or_above() and branch_id = current_staff_branch()))
  with check (staff_id = current_staff_id() or is_manager()
    or (is_supervisor_or_above() and branch_id = current_staff_branch()));

-- cash_drawer_entries
create policy "read cash drawer entries" on public.cash_drawer_entries for select to authenticated
  using (branch_id = current_staff_branch() or is_manager());
create policy "write cash drawer entries" on public.cash_drawer_entries for all to authenticated
  using (branch_id = current_staff_branch() or is_manager())
  with check (branch_id = current_staff_branch() or is_manager());

-- shift_adjustments (read-only to clients; writes only via adjust_shift_cash())
create policy "read shift adjustments" on public.shift_adjustments for select to authenticated
  using (branch_id = current_staff_branch() or is_manager());

-- cash_movements (approve/deny/cancel/self-record/review all go through RPCs)
create policy "read cash movements" on public.cash_movements for select to authenticated
  using (branch_id = current_staff_branch() or is_manager());
create policy "insert cash movements" on public.cash_movements for insert to authenticated
  with check ((branch_id = current_staff_branch() and requested_by = current_staff_id()) or is_manager());

-- till_action_requests (resolution goes through resolve_till_action_request())
create policy "read till action requests" on public.till_action_requests for select to authenticated
  using (branch_id = current_staff_branch() or is_manager());
create policy "insert till action requests" on public.till_action_requests for insert to authenticated
  with check ((branch_id = current_staff_branch() and requested_by = current_staff_id()) or is_manager());

-- branch_presence
create policy "read branch presence" on public.branch_presence for select to authenticated
  using (branch_id = current_staff_branch() or is_manager());
create policy "upsert branch presence" on public.branch_presence for insert to authenticated
  with check (branch_id = current_staff_branch() or is_manager());
create policy "update branch presence" on public.branch_presence for update to authenticated
  using (branch_id = current_staff_branch() or is_manager())
  with check (branch_id = current_staff_branch() or is_manager());

-- branch_devices
create policy "read branch devices" on public.branch_devices for select to authenticated
  using (branch_id = current_staff_branch() or is_manager());
create policy "write branch devices" on public.branch_devices for all to authenticated
  using (branch_id = current_staff_branch() or is_manager())
  with check (branch_id = current_staff_branch() or is_manager());

-- audit_events (append-only: no update/delete policy at all)
create policy "read audit events" on public.audit_events for select to authenticated
  using (is_manager() or staff_id = (select staff.id from staff
    where staff.auth_user_id = (select auth.uid()) and staff.is_active limit 1));
create policy "insert audit events" on public.audit_events for insert to authenticated with check (true);
create policy "no update audit events" on public.audit_events for update to authenticated
  using (false) with check (false);
create policy "no delete audit events" on public.audit_events for delete to authenticated
  using (false);

-- pin_login_attempts (no client access at all — written only by SECURITY DEFINER RPCs)
create policy "deny all pin_login_attempts" on public.pin_login_attempts for all to anon, authenticated
  using (false) with check (false);

-- company_profile (singleton settings row)
create policy "read company profile" on public.company_profile for select to authenticated using (true);
create policy "write company profile" on public.company_profile for all to authenticated
  using (is_manager()) with check (is_manager());

-- =============================================================================
-- 8. EVENT TRIGGER — defense in depth so a future CREATE TABLE in public
--    always gets RLS enabled even if the migration adding it forgets to.
-- =============================================================================
create event trigger ensure_rls on ddl_command_end execute function public.rls_auto_enable();

-- =============================================================================
-- End of schema. A fresh Supabase project already grants the default
-- anon/authenticated table privileges (SELECT/REFERENCES/TRIGGER for anon;
-- + INSERT/UPDATE/DELETE/TRUNCATE for authenticated) on every public table
-- automatically at project creation — verified identical across all 29
-- tables on CalePOS_Demo, so no explicit GRANT ON TABLE statements are
-- needed here. RLS policies above are what actually restrict access; the
-- table-level grant only gets a role past PostgREST's own permission check
-- far enough to hit (and be blocked or filtered by) those policies.
-- =============================================================================
