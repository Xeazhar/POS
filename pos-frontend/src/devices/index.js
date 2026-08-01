/**
 * Hardware device service contracts.
 * Implementations today are stubs — swap in Web Serial / USB / native bridge later
 * without changing POS call sites.
 */

/** @typedef {'disconnected' | 'connecting' | 'connected' | 'error'} DeviceConnectionState */

/**
 * @typedef {Object} DeviceStatus
 * @property {string} id
 * @property {string} label
 * @property {DeviceConnectionState} state
 * @property {string} [detail]
 * @property {string | null} [lastSeenAt]
 */

/**
 * @typedef {Object} BarcodeScannerService
 * @property {() => Promise<DeviceStatus>} getStatus
 * @property {() => Promise<void>} connect
 * @property {() => Promise<void>} disconnect
 * @property {(handler: (code: string) => void) => () => void} onScan
 */

/**
 * @typedef {Object} ReceiptPrinterService
 * @property {() => Promise<DeviceStatus>} getStatus
 * @property {() => Promise<void>} connect
 * @property {() => Promise<void>} disconnect
 * @property {(receipt: object) => Promise<void>} printReceipt
 */

/**
 * @typedef {Object} CashDrawerService
 * @property {() => Promise<DeviceStatus>} getStatus
 * @property {() => Promise<void>} connect
 * @property {() => Promise<void>} disconnect
 * @property {() => Promise<void>} openDrawer
 */

function stubStatus(id, label) {
  return {
    id,
    label,
    state: /** @type {DeviceConnectionState} */ ('disconnected'),
    detail: 'Not Connected',
    lastSeenAt: null,
  }
}

/** @type {BarcodeScannerService} */
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

/** @type {ReceiptPrinterService} */
export const receiptPrinter = {
  async getStatus() {
    return stubStatus('receipt-printer', 'Receipt Printer')
  },
  async connect() {
    throw new Error('Receipt printer hardware not configured yet.')
  },
  async disconnect() {},
  async printReceipt() {
    throw new Error('Receipt printer hardware not configured yet.')
  },
}

/** @type {CashDrawerService} */
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
