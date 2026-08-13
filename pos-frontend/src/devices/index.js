/**
 * Hardware device service contracts.
 * Receipt printing falls back to browser print until a thermal printer is wired.
 * Manager enable/disable is stored on branches.device_settings.
 */

import { printReceiptBrowser } from '../utils/receipt'

/** @typedef {'disconnected' | 'connecting' | 'connected' | 'error'} DeviceConnectionState */

/**
 * @typedef {Object} DeviceStatus
 * @property {string} id
 * @property {string} label
 * @property {DeviceConnectionState} state
 * @property {string} [detail]
 * @property {string | null} [lastSeenAt]
 * @property {boolean} [enabled]
 */

export const BRANCH_DEVICES = [
  {
    key: 'barcode_scanner',
    id: 'barcode-scanner',
    label: 'Barcode Scanner',
    hint: 'Scan into POS search (USB wedge / HID)',
  },
  {
    key: 'receipt_printer',
    id: 'receipt-printer',
    label: 'Receipt Printer',
    hint: 'Print receipts after sale (thermal or browser)',
  },
  {
    key: 'cash_drawer',
    id: 'cash-drawer',
    label: 'Cash Drawer',
    hint: 'Open drawer with cash sales',
  },
]

export const DEFAULT_DEVICE_SETTINGS = {
  barcode_scanner: false,
  receipt_printer: false,
  cash_drawer: false,
}

export function normalizeDeviceSettings(raw) {
  const next = { ...DEFAULT_DEVICE_SETTINGS }
  if (!raw || typeof raw !== 'object') return next
  for (const key of Object.keys(DEFAULT_DEVICE_SETTINGS)) {
    if (key in raw) next[key] = raw[key] === true
  }
  return next
}

/** Heartbeat is 45s; treat a till/device as gone if nothing landed for this long. */
export const DEVICE_STALE_MS = 3 * 60 * 1000

export function isTelemetryFresh(iso, now = Date.now()) {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return false
  return now - t < DEVICE_STALE_MS
}

export function isDeviceEnabled(settings, keyOrId) {
  const normalized = normalizeDeviceSettings(settings)
  const key =
    keyOrId === 'barcode-scanner' || keyOrId === 'barcode_scanner'
      ? 'barcode_scanner'
      : keyOrId === 'receipt-printer' || keyOrId === 'receipt_printer'
        ? 'receipt_printer'
        : keyOrId === 'cash-drawer' || keyOrId === 'cash_drawer'
          ? 'cash_drawer'
          : keyOrId
  return normalized[key] === true
}

function stubStatus(id, label, detail = 'Not Connected') {
  return {
    id,
    label,
    state: /** @type {DeviceConnectionState} */ ('disconnected'),
    detail,
    lastSeenAt: null,
  }
}

export const barcodeScanner = {
  async getStatus() {
    return stubStatus('barcode-scanner', 'Barcode Scanner')
  },
  async connect() {
    throw new Error('Barcode scanner hardware not configured yet.')
  },
  async disconnect() {},
  onScan() {
    return () => {}
  },
}

export const receiptPrinter = {
  async getStatus() {
    // Browser print works, but no physical thermal printer is wired yet.
    return stubStatus(
      'receipt-printer',
      'Receipt Printer',
      'Browser print only — thermal printer not connected',
    )
  },
  async connect() {},
  async disconnect() {},
  /**
   * @param {object} receipt — from buildReceipt()
   * @param {{ forceBrowser?: boolean }} [options]
   */
  async printReceipt(receipt, options = {}) {
    // Hardware ESC/POS bridge goes here later. Until then, browser print.
    if (options.forceBrowser !== false) {
      printReceiptBrowser(receipt)
      return { mode: 'browser' }
    }
    throw new Error('Receipt printer hardware not configured yet.')
  },
}

export const cashDrawer = {
  async getStatus() {
    return stubStatus('cash-drawer', 'Cash Drawer')
  },
  async connect() {
    throw new Error('Cash drawer hardware not configured yet.')
  },
  async disconnect() {},
  async openDrawer() {
    throw new Error('Cash drawer hardware not configured yet.')
  },
}

export const deviceServices = {
  barcodeScanner,
  receiptPrinter,
  cashDrawer,
}

export async function getAllDeviceStatuses(settings = null) {
  const enabled = normalizeDeviceSettings(settings)
  const rows = await Promise.all([
    barcodeScanner.getStatus(),
    receiptPrinter.getStatus(),
    cashDrawer.getStatus(),
  ])
  return rows.map((row) => {
    const key =
      row.id === 'barcode-scanner'
        ? 'barcode_scanner'
        : row.id === 'receipt-printer'
          ? 'receipt_printer'
          : 'cash_drawer'
    const on = enabled[key] === true
    const hardwareDetail = row.detail && row.detail !== 'Disabled by manager' ? row.detail : 'Not Connected'
    return {
      ...row,
      enabled: on,
      state: on ? row.state : 'disconnected',
      detail: on ? hardwareDetail : 'Disabled by manager',
    }
  })
}
