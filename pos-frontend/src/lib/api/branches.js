import { supabase } from '../supabase'
import { normalizeBranchType } from '../../utils/features'
import { clampIdleLockMinutes, IDLE_LOCK_MINUTES_DEFAULT } from '../../utils/sessionPolicy'
import { APP_VERSION } from '../../utils/version'
import { isMissingColumnError } from './shared.js'

const BRANCH_LIST_COLS =
  'id, name, address, is_active, sort_order, day_open_hour, branch_type, device_settings, vat_rate, tin, branch_tin_code, business_name, bir_permit_no, machine_identification_no, serial_number, invoice_prefix'
const BRANCH_LIST_COLS_LEGACY =
  'id, name, address, is_active, sort_order, day_open_hour, branch_type, device_settings, vat_rate'

/**
 * A business has ONE TIN; a branch has a BIR branch code appended to it (head office
 * 00000, then 00001, …) — see migrate_company_tin.sql. Composed here, in one place, so
 * the invoice, the X/Z reading and the settings screen can never print three versions
 * of the same number.
 *
 * Falls back to the branch's own legacy `tin` when the company TIN has not been set,
 * which is what every environment looks like until that migration is run.
 */
export function composeTin(companyTin, branchCode, legacyBranchTin = null) {
  const main = String(companyTin || '').trim()
  if (!main) return legacyBranchTin || ''
  const code = String(branchCode || '').trim()
  return code ? `${main}-${code}` : main
}

let companyProfileCache = null

const COMPANY_PROFILE_SELECT = 'id, business_name, tin, address, idle_lock_minutes'
const COMPANY_PROFILE_SELECT_LEGACY = 'id, business_name, tin, address'

function mapCompanyProfile(row, { missing = false } = {}) {
  return {
    id: row?.id ?? true,
    business_name: row?.business_name ?? null,
    tin: row?.tin ?? null,
    address: row?.address ?? null,
    idle_lock_minutes: clampIdleLockMinutes(row?.idle_lock_minutes ?? IDLE_LOCK_MINUTES_DEFAULT),
    missing,
  }
}

/** The single company-level fiscal identity row. Cached — it changes about never. */
export async function fetchCompanyProfile({ force = false } = {}) {
  if (!supabase) return null
  if (companyProfileCache && !force) return companyProfileCache
  let { data, error } = await supabase
    .from('company_profile')
    .select(COMPANY_PROFILE_SELECT)
    .limit(1)
    .maybeSingle()
  if (error && /idle_lock_minutes|schema cache|column/i.test(String(error.message || ''))) {
    ;({ data, error } = await supabase
      .from('company_profile')
      .select(COMPANY_PROFILE_SELECT_LEGACY)
      .limit(1)
      .maybeSingle())
  }
  if (error) {
    // Table not created yet (migration not applied) — degrade to branch-level TIN rather
    // than failing every screen that prints a receipt.
    if (/company_profile|schema cache|does not exist/i.test(String(error.message || ''))) {
      companyProfileCache = mapCompanyProfile(null, { missing: true })
      return companyProfileCache
    }
    throw error
  }
  companyProfileCache = mapCompanyProfile(data)
  return companyProfileCache
}

export async function saveCompanyProfile({ businessName, tin, address, idleLockMinutes } = {}) {
  const payload = {
    id: true,
    updated_at: new Date().toISOString(),
  }
  if (businessName !== undefined) payload.business_name = businessName ?? null
  if (tin !== undefined) payload.tin = tin ?? null
  if (address !== undefined) payload.address = address ?? null
  if (idleLockMinutes !== undefined) payload.idle_lock_minutes = clampIdleLockMinutes(idleLockMinutes)

  const run = (selectCols) =>
    supabase.from('company_profile').upsert(payload, { onConflict: 'id' }).select(selectCols).single()

  let { data, error } = await run(COMPANY_PROFILE_SELECT)
  if (error && /idle_lock_minutes|schema cache|column/i.test(String(error.message || ''))) {
    if (idleLockMinutes !== undefined) throw error
    ;({ data, error } = await run(COMPANY_PROFILE_SELECT_LEGACY))
  }
  if (error) throw error
  companyProfileCache = mapCompanyProfile(data)
  branchHeaderCache.clear()
  return companyProfileCache
}

export async function fetchBranches({ includeCompany = true } = {}) {
  let { data, error } = await supabase
    .from('branches')
    .select(BRANCH_LIST_COLS)
    .order('sort_order')
    .order('name')
  if (error && /branch_tin_code|tin|business_name|schema cache|column/i.test(String(error.message || ''))) {
    ;({ data, error } = await supabase
      .from('branches')
      .select(BRANCH_LIST_COLS_LEGACY)
      .order('sort_order')
      .order('name'))
  }
  if (error) {
    // Older schemas may lack sort_order / device_settings / vat_rate — fall back broadly.
    const fallback = await supabase.from('branches').select('*').order('name')
    if (fallback.error) throw error
    data = fallback.data || []
  }
  const rows = (data || []).map((row) => ({
    ...row,
    branch_type: normalizeBranchType(row.branch_type),
  }))
  // Branch cards / dashboards only need identity + type. Skip company_profile round-trip
  // unless a caller needs composed TIN (receipts, fiscal settings).
  if (!includeCompany) return rows

  // Every consumer (receipt, X/Z reading, settings form) reads `full_tin` and gets the
  // same composed value — no caller has to know about the two-level structure.
  const company = await fetchCompanyProfile().catch(() => null)
  return rows.map((row) => ({
    ...row,
    company_tin: company?.tin || null,
    company_business_name: company?.business_name || null,
    full_tin: composeTin(company?.tin, row.branch_tin_code, row.tin),
  }))
}

const branchHeaderCache = new Map()

/** Branch row → receipt header block (composed TIN when company profile is known). */
export function mapBranchFiscalHeader(row, company = null) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name || '',
    business_name: row.business_name || row.name || '',
    address: row.address || '',
    tin: row.tin || '',
    branch_tin_code: row.branch_tin_code || '',
    company_tin: company?.tin || row.company_tin || null,
    full_tin: composeTin(
      company?.tin || row.company_tin,
      row.branch_tin_code,
      row.tin,
    ),
    bir_permit_no: row.bir_permit_no || '',
    machine_identification_no: row.machine_identification_no || '',
    serial_number: row.serial_number || '',
    invoice_prefix: row.invoice_prefix || 'SI',
  }
}

/**
 * Branch identity block for printing (business name, address, composed TIN, permit, MIN,
 * serial). Memory cache → IndexedDB (offline) → network (online only, with timeout).
 */
export async function fetchBranchFiscalHeader(branchId) {
  if (!branchId) return null
  if (branchHeaderCache.has(branchId)) return branchHeaderCache.get(branchId)

  const { getLocalBranchFiscalHeader, saveBranchFiscalHeader } = await import('../../offline/repository')
  const local = await getLocalBranchFiscalHeader(branchId)
  if (local) {
    branchHeaderCache.set(branchId, local)
    return local
  }

  if (!supabase) return null

  const { canSyncWithBackend } = await import('../../offline/reachability')
  const { withTimeout } = await import('../../utils/withTimeout')
  if (!(await canSyncWithBackend())) return null

  const branches = await withTimeout(fetchBranches(), 10000, 'Branch fiscal header').catch(() => [])
  for (const row of branches) {
    branchHeaderCache.set(row.id, row)
    void saveBranchFiscalHeader(row.id, row)
  }
  return branchHeaderCache.get(branchId) || null
}

export async function reorderBranches(orderedIds = []) {
  branchHeaderCache.clear()
  await Promise.all(
    orderedIds.map((id, index) =>
      supabase.from('branches').update({ sort_order: index + 1 }).eq('id', id),
    ),
  )
}

/** Seconds without heartbeat before a branch is considered offline. */
export const BRANCH_ONLINE_WINDOW_SEC = 120

export function isBranchOnline(presence, now = Date.now()) {
  if (!presence?.last_seen_at) return false
  const last = new Date(presence.last_seen_at).getTime()
  if (Number.isNaN(last)) return false
  return now - last <= BRANCH_ONLINE_WINDOW_SEC * 1000
}

export async function heartbeatBranch({ branchId, staffId }) {
  if (!supabase || !branchId) return null
  const { data, error } = await supabase.rpc('heartbeat_branch', {
    p_branch_id: branchId,
    p_staff_id: staffId || null,
    p_app_version: APP_VERSION,
    p_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 180) : null,
  })
  if (error) {
    // Table/RPC may not be migrated yet — don't break the POS
    console.warn('heartbeat_branch', error.message)
    return null
  }
  return data
}

const DEVICE_KEY_MAP = {
  'barcode-scanner': 'barcode_scanner',
  'receipt-printer': 'receipt_printer',
  'cash-drawer': 'cash_drawer',
  barcode_scanner: 'barcode_scanner',
  receipt_printer: 'receipt_printer',
  cash_drawer: 'cash_drawer',
}

const DEVICE_LABELS = {
  barcode_scanner: 'Barcode Scanner',
  receipt_printer: 'Receipt Printer',
  cash_drawer: 'Cash Drawer',
}

export async function fetchBranchDeviceSettings(branchId) {
  if (!supabase || !branchId) return null
  const { data, error } = await supabase
    .from('branches')
    .select('device_settings')
    .eq('id', branchId)
    .maybeSingle()
  if (error) {
    if (!/device_settings|schema cache|column/i.test(String(error.message || ''))) {
      console.warn('fetchBranchDeviceSettings', error.message)
    }
    return null
  }
  return data?.device_settings ?? null
}

export async function reportBranchDevices(branchId, devices) {
  if (!supabase || !branchId || !devices?.length) return
  const rows = devices.map((device) => {
    const key = DEVICE_KEY_MAP[device.id] || DEVICE_KEY_MAP[device.device_key] || device.id
    return {
      branch_id: branchId,
      device_key: key,
      state: device.state === 'connected' ? 'connected' : device.state || 'disconnected',
      detail: device.detail || (device.state === 'connected' ? 'Connected' : 'Not Connected'),
      updated_at: new Date().toISOString(),
    }
  })
  const { error } = await supabase.from('branch_devices').upsert(rows, { onConflict: 'branch_id,device_key' })
  if (error) console.warn('reportBranchDevices', error.message)
}

export async function fetchBranchTelemetry(branchIds = []) {
  if (!supabase) return { presence: {}, devices: {} }
  const ids = branchIds.filter(Boolean)
  if (!ids.length) return { presence: {}, devices: {} }

  const [presenceRes, devicesRes] = await Promise.all([
    supabase
      .from('branch_presence')
      .select('branch_id, staff_id, last_seen_at, is_online, updated_at')
      .in('branch_id', ids),
    supabase
      .from('branch_devices')
      .select('branch_id, device_key, state, detail, updated_at')
      .in('branch_id', ids),
  ])

  if (presenceRes.error) console.warn('branch_presence', presenceRes.error.message)
  if (devicesRes.error) console.warn('branch_devices', devicesRes.error.message)

  const presence = Object.fromEntries((presenceRes.data || []).map((row) => [row.branch_id, row]))
  const devices = {}
  for (const row of devicesRes.data || []) {
    if (!devices[row.branch_id]) devices[row.branch_id] = []
    devices[row.branch_id].push({
      key: row.device_key,
      label: DEVICE_LABELS[row.device_key] || row.device_key,
      state: row.state,
      detail: row.detail || '',
      updatedAt: row.updated_at,
    })
  }
  // Ensure all three slots exist for UI
  for (const id of ids) {
    const list = devices[id] || []
    const byKey = Object.fromEntries(list.map((d) => [d.key, d]))
    devices[id] = ['barcode_scanner', 'receipt_printer', 'cash_drawer'].map(
      (key) =>
        byKey[key] || {
          key,
          label: DEVICE_LABELS[key],
          state: 'disconnected',
          detail: 'Not Connected',
          updatedAt: null,
        },
    )
  }

  return { presence, devices }
}

export function deviceSummary(deviceList = []) {
  const connected = deviceList.filter((d) => d.state === 'connected').length
  return { connected, total: deviceList.length || 3 }
}

export async function saveBranch(payload) {
  // Settings just changed — the next receipt must not print the old header.
  branchHeaderCache.clear()
  const fields = {
    name: payload.name,
    address: payload.address,
    is_active: payload.is_active,
  }
  if (payload.branch_type != null) {
    fields.branch_type = normalizeBranchType(payload.branch_type)
  }
  // Optional fiscal / settings fields — only write when provided (Branch settings)
  // branches.tin / business_name are LEGACY fallbacks — prefer company_profile + branch_tin_code.
  // App no longer writes tin/business_name (migrate_schema_cleanup_v1.sql).
  if ('branch_tin_code' in payload || 'branchTinCode' in payload) {
    fields.branch_tin_code = payload.branch_tin_code ?? payload.branchTinCode ?? null
  }
  if ('bir_permit_no' in payload || 'birPermitNo' in payload) {
    fields.bir_permit_no = payload.bir_permit_no ?? payload.birPermitNo ?? null
  }
  if ('machine_identification_no' in payload || 'machineId' in payload) {
    fields.machine_identification_no =
      payload.machine_identification_no ?? payload.machineId ?? null
  }
  if ('serial_number' in payload || 'serialNumber' in payload) {
    fields.serial_number = payload.serial_number ?? payload.serialNumber ?? null
  }
  if ('invoice_prefix' in payload || 'invoicePrefix' in payload) {
    fields.invoice_prefix = payload.invoice_prefix ?? payload.invoicePrefix
  }
  if (payload.day_open_hour != null) {
    fields.day_open_hour = Math.min(23, Math.max(0, Number(payload.day_open_hour)))
  }
  if (payload.vat_rate != null || payload.vatRate != null) {
    fields.vat_rate = Number(payload.vat_rate ?? payload.vatRate)
  }
  if (payload.sort_order != null || payload.sortOrder != null) {
    fields.sort_order = Number(payload.sort_order ?? payload.sortOrder)
  }
  if ('device_settings' in payload || 'deviceSettings' in payload) {
    const raw = payload.device_settings ?? payload.deviceSettings
    fields.device_settings = {
      barcode_scanner: raw?.barcode_scanner === true,
      receipt_printer: raw?.receipt_printer === true,
      cash_drawer: raw?.cash_drawer === true,
    }
  }
  Object.keys(fields).forEach((key) => {
    if (fields[key] === undefined) delete fields[key]
  })
  if (payload.id) {
    let { data, error } = await supabase
      .from('branches')
      .update(fields)
      .eq('id', payload.id)
      .select('*')
      .single()
    if (
      error &&
      (isMissingColumnError(error, 'vat_rate') ||
        isMissingColumnError(error, 'sort_order') ||
        isMissingColumnError(error, 'branch_tin_code'))
    ) {
      const fallback = { ...fields }
      delete fallback.vat_rate
      delete fallback.sort_order
      // Frontend can ship ahead of migrate_company_tin.sql.
      delete fallback.branch_tin_code
      ;({ data, error } = await supabase.from('branches').update(fallback).eq('id', payload.id).select('*').single())
    }
    if (
      error &&
      fields.device_settings &&
      /device_settings|schema cache|column|Could not find/i.test(String(error.message || ''))
    ) {
      // Do NOT soft-succeed — toggle must actually persist
      const missing = new Error(
        'Device settings DB column missing — run migrate_device_settings.sql in Supabase.',
      )
      missing.code = 'DEV01'
      missing.supportCode = 'DEV01'
      throw missing
    }
    if (error) {
      const wrapped = new Error(error.message || 'Could not save device on/off setting.')
      wrapped.code = fields.device_settings ? 'DEV02' : 'GEN01'
      wrapped.supportCode = wrapped.code
      throw wrapped
    }
    if (fields.device_settings && data && data.device_settings == null) {
      const missing = new Error(
        'Device settings DB column missing — run migrate_device_settings.sql in Supabase.',
      )
      missing.code = 'DEV01'
      missing.supportCode = 'DEV01'
      throw missing
    }
    return data
  }
  const { data, error } = await supabase
    .from('branches')
    .insert({
      ...fields,
      is_active: payload.is_active ?? true,
      branch_type: fields.branch_type || 'retail',
      invoice_prefix: fields.invoice_prefix || 'SI',
    })
    .select('*')
    .single()
  if (error) throw error
  return data
}
