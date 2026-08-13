/**
 * Lazy SheetJS loader — xlsx is ~410KB and only needed for import/export actions.
 * Uses @e965/xlsx (patched SheetJS 0.20.x) via the `xlsx` package alias in package.json.
 */

let xlsxPromise = null

/** Safe defaults when parsing staff-uploaded spreadsheets. */
export const XLSX_READ_OPTS = {
  cellFormula: false,
  cellHTML: false,
  cellStyles: false,
  sheetRows: 10_000,
  bookSheets: false,
  bookProps: false,
  bookVBA: false,
}

export function loadXlsx() {
  if (!xlsxPromise) xlsxPromise = import('xlsx')
  return xlsxPromise
}

export async function readSpreadsheetBuffer(buf, opts = {}) {
  const XLSX = await loadXlsx()
  return XLSX.read(buf, { type: 'array', ...XLSX_READ_OPTS, ...opts })
}

export async function writeSpreadsheetWorkbook(wb, bookType = 'xlsx') {
  const XLSX = await loadXlsx()
  return XLSX.write(wb, { bookType, type: 'array' })
}
