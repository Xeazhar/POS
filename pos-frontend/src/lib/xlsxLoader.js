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

/**
 * Load the SheetJS library.
 * @returns {Promise< object>} The loaded SheetJS module.
 */
export function loadXlsx() {
  if (!xlsxPromise) xlsxPromise = import('xlsx')
  return xlsxPromise
}

/**
 * Parse spreadsheet data from an array buffer.
 * @param {ArrayBuffer} buf - The spreadsheet data to parse.
 * @param {Object} [opts] - Parsing options that override the default safe options.
 * @return {Object} The parsed spreadsheet workbook.
 */
export async function readSpreadsheetBuffer(buf, opts = {}) {
  const XLSX = await loadXlsx()
  return XLSX.read(buf, { type: 'array', ...XLSX_READ_OPTS, ...opts })
}

/**
 * Serializes a spreadsheet workbook in the specified format.
 * @param {object} wb - The workbook to serialize.
 * @param {string} [bookType='xlsx'] - The output format.
 * @return {ArrayBuffer} The serialized workbook data.
 */
export async function writeSpreadsheetWorkbook(wb, bookType = 'xlsx') {
  const XLSX = await loadXlsx()
  return XLSX.write(wb, { bookType, type: 'array' })
}
