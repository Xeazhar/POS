/**
 * Hardware device service contracts.
 * Receipt printing falls back to browser print until a thermal printer is wired.
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
 */

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
    return {
      id: 'receipt-printer',
      label: 'Receipt Printer',
      state: /** @type {DeviceConnectionState} */ ('connected'),
      detail: 'Browser print ready (thermal hardware pending)',
      lastSeenAt: new Date().toISOString(),
    }
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

export async function getAllDeviceStatuses() {
  return Promise.all([
    barcodeScanner.getStatus(),
    receiptPrinter.getStatus(),
    cashDrawer.getStatus(),
  ])
}
