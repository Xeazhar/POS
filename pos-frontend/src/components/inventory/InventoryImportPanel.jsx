import { useEffect, useState } from 'react'
import { FiUpload } from 'react-icons/fi'
import {
  ErrorBanner,
  Eyebrow,
  Modal,
  ModalActions,
  PrimaryButton,
  SecondaryButton,
  StatusOverlay,
  TableCard,
} from '../ui'
import {
  commitInventoryImport,
  dismissImportRevertRequest,
  fetchCatalogProducts,
  fetchImportBatches,
  findRecentImportByHash,
  hasSupabase,
  requestImportRevert,
  revertInventoryImport,
} from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { isManagerRole } from '../../utils/roles'
import {
  buildImportPreview,
  normalizeSheetRows,
  sha256Hex,
  validateImportFile,
  validateImportHeaders,
} from '../../utils/inventoryImport'
import { formatSupportError } from '../../utils/errors'
import ImportPreviewLines from '../shared/ImportPreviewLines'

import { readSpreadsheetBuffer, loadXlsx } from '../../lib/xlsxLoader'

const REVERT_REQUEST_WINDOW_MS = 5 * 60 * 1000

/**
 * Import inventory restock data from a CSV or spreadsheet file for the current branch.
 * Existing products are restocked, while new products are imported only when their SKU or barcode
 * exists in the network catalog; other rows are shown as skipped with a reason.
 * @param {Object} props - Component properties.
 * @param {Array} props.products - Products currently available at the branch.
 * @param {Function} props.onDone - Callback invoked after a successful import.
 * @returns {JSX.Element|null} The import panel, or `null` for restaurant branches.
 */
export default function InventoryImportPanel({ products, onDone }) {
  const user = useAuthStore((s) => s.user)
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)
  const [duplicate, setDuplicate] = useState(null)
  const [acknowledgeDuplicate, setAcknowledgeDuplicate] = useState(false)
  const [importProgress, setImportProgress] = useState(null)
  const [recentBatches, setRecentBatches] = useState([])
  const [confirmRevert, setConfirmRevert] = useState(null)
  const [revertBusy, setRevertBusy] = useState(false)
  const [requestBusyId, setRequestBusyId] = useState(null)
  const [dismissBusyId, setDismissBusyId] = useState(null)
  const canRevert = isManagerRole(user?.role)

  const loadRecentBatches = async () => {
    if (!hasSupabase || !user?.branchId) return
    try {
      const rows = await fetchImportBatches(user.branchId)
      setRecentBatches((rows || []).slice(0, 5))
    } catch {
      /* best-effort — recent-imports list is a convenience, not load-bearing */
    }
  }

  useEffect(() => {
    void loadRecentBatches()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.branchId])

  const revertBatch = async () => {
    if (!confirmRevert) return
    setRevertBusy(true)
    setError('')
    setSuccess('')
    try {
      await revertInventoryImport(confirmRevert.id, user.id)
      setConfirmRevert(null)
      await loadRecentBatches()
      onDone?.()
    } catch (err) {
      setError(formatSupportError(err, 'IMP03'))
    } finally {
      setRevertBusy(false)
    }
  }

  // No confirm modal here — a request only flags the batch for a manager's attention,
  // it does not touch products or stock. The actual revert (revertBatch above) is the
  // one that mutates anything, and already confirms.
  const requestRevert = async (batch) => {
    setRequestBusyId(batch.id)
    setError('')
    setSuccess('')
    try {
      await requestImportRevert(batch.id, user.id)
      await loadRecentBatches()
    } catch (err) {
      setError(formatSupportError(err, 'IMP03'))
    } finally {
      setRequestBusyId(null)
    }
  }

  const dismissRevert = async (batch) => {
    setDismissBusyId(batch.id)
    setError('')
    setSuccess('')
    try {
      await dismissImportRevertRequest(batch.id, user.id)
      await loadRecentBatches()
    } catch (err) {
      setError(formatSupportError(err, 'IMP03'))
    } finally {
      setDismissBusyId(null)
    }
  }

  const onFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !user?.branchId) return
    setError('')
    setSuccess('')
    setDuplicate(null)
    setAcknowledgeDuplicate(false)
    setPreview(null)
    // Checked BEFORE the file is read. xlsx parses on the main thread, so a huge or
    // mistyped file freezes the till with no message — this turns that hang into a
    // sentence. Cheap, and the only guard that runs before the expensive work starts.
    const fileCheck = validateImportFile(file)
    if (!fileCheck.ok) {
      setError(fileCheck.message)
      return
    }
    setBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const wb = await readSpreadsheetBuffer(buf)
      const XLSX = await loadXlsx()
      const sheet = wb.Sheets[wb.SheetNames[0]]
      const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
      const restaurant = user?.branchType === 'restaurant'

      const format = validateImportHeaders(rawRows, { restaurant, mode: 'inventory' })
      if (!format.ok) {
        setError(format.message)
        return
      }

      const hash = await sha256Hex(buf)
      const rows = normalizeSheetRows(rawRows)
      const networkCatalog = hasSupabase
        ? await fetchCatalogProducts({ branchType: restaurant ? 'restaurant' : 'retail' })
        : []
      const catalogSkus = new Set(
        networkCatalog.map((row) => String(row.sku || '').toLowerCase().trim()).filter(Boolean),
      )
      const catalogBarcodes = new Set(
        networkCatalog.map((row) => String(row.barcode || '').trim()).filter(Boolean),
      )

      const built = buildImportPreview(rows, products, { restaurant })
      const allowedCreates = []
      const skippedNotInCatalog = []
      for (const line of built.creates || []) {
        const sku = String(line.values?.sku || '').toLowerCase().trim()
        const barcode = String(line.values?.barcode || '').trim()
        const inCatalog =
          (sku && catalogSkus.has(sku)) || (barcode && catalogBarcodes.has(barcode))
        if (inCatalog) allowedCreates.push(line)
        else {
          skippedNotInCatalog.push({
            ...line,
            action: 'skip',
            reason: 'Not in network catalog — add it in Manager Data first, or adopt from Catalog',
          })
        }
      }

      const lines = [...(built.updates || []), ...allowedCreates]
      const skipped = [...(built.skipped || []), ...skippedNotInCatalog]
      setPreview({
        ...built,
        lines,
        creates: allowedCreates,
        updates: built.updates || [],
        createCount: allowedCreates.length,
        updateCount: (built.updates || []).length,
        skippedCount: skipped.length,
        skipped,
        filename: file.name,
        fileHash: hash,
        restaurant,
      })
      if (hasSupabase) {
        const recent = await findRecentImportByHash(user.branchId, hash).catch(() => null)
        if (recent) setDuplicate(recent)
      }
    } catch (err) {
      setError(formatSupportError(err, 'IMP01'))
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    if (!preview || !user?.branchId) return
    if (!preview.lines?.length) {
      setError('Nothing to import — every row was skipped. See reasons below and the import guide.')
      return
    }
    if (duplicate && !acknowledgeDuplicate) {
      setError('Acknowledge that this file was imported before, or pick a different file.')
      return
    }
    setBusy(true)
    setError('')
    setSuccess('')
    setImportProgress({ done: 0, total: preview.lines?.length || 0 })
    try {
      const batch = await commitInventoryImport({
        branchId: user.branchId,
        staffId: user.id,
        filename: preview.filename,
        fileHash: preview.fileHash,
        preview,
        onProgress: (done, total) => setImportProgress({ done, total }),
      })
      setPreview(null)
      setDuplicate(null)
      setAcknowledgeDuplicate(false)
      // The preview panel (and its Confirm button) disappears on success with nothing
      // else on screen saying so — easy to read as "the click didn't register" and
      // re-import the same file. This is the only signal that it actually worked.
      setSuccess(
        `Imported "${batch.filename}" — ${batch.created_count} new, ${batch.updated_count} restocked.`,
      )
      onDone?.()
      void loadRecentBatches()
    } catch (err) {
      setError(formatSupportError(err, 'IMP02'))
    } finally {
      setBusy(false)
      setImportProgress(null)
    }
  }

  if (user?.branchType === 'restaurant') return null

  return (
    <>
      {importProgress && (
        <StatusOverlay
          title="Importing stock"
          message={`${importProgress.done} / ${importProgress.total} lines`}
        />
      )}

      <TableCard className="mb-4 max-h-none overflow-visible p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="m-0 text-sm">Quick restock import</h2>
            <p className="m-0 mt-1 text-[11px] text-brand-subtle">
              Restock items already on this branch. New SKUs only if they exist in the network
              catalog — others are listed as skipped with a reason.
            </p>
          </div>
          <label
            className={`inline-flex h-8 cursor-pointer items-center gap-1 rounded-[5px] border border-brand-border bg-brand-card px-2.5 text-[11px] font-bold text-brand-n800 ${
              busy ? 'pointer-events-none opacity-35' : ''
            }`}
          >
            <FiUpload className="text-sm" /> Import file
            <input
              className="hidden"
              type="file"
              accept=".csv,.xlsx,.xls"
              disabled={busy}
              onChange={onFile}
            />
          </label>
        </div>
        {error && <ErrorBanner className="mt-3 mb-0" error={error} onDismiss={() => setError('')} />}
        {success && (
          <p className="mt-3 mb-0 rounded-md bg-brand-success-bg px-3 py-2 text-xs text-brand-success">
            {success}
          </p>
        )}
      </TableCard>

      <TableCard className="mb-4 max-h-none p-5">
        <h2 className="m-0 text-base">Import guide</h2>
        <p className="mt-1 text-xs text-brand-muted">
          Files that do not match this format are rejected. Required columns must be present.
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-brand-muted">
          <li>
            Required: <code>name</code>, <code>sku</code>, <code>barcode</code>, <code>category</code>,{' '}
            <code>pricingMode</code> (pc/kg), <code>price</code>, <code>stock</code>,{' '}
            <code>discountEligible</code> (true/false)
          </li>
          <li>
            Optional: <code>lowStockAt</code>
          </li>
          <li>
            <code>stock</code> is the quantity to <strong>add</strong> for restock (not the final
            on-hand total)
          </li>
          <li>Skipped if the SKU is not in the network catalog</li>
          <li>
            Sample:{' '}
            <a className="font-bold text-brand-ink" href="/samples/inventory-import.csv" download>
              inventory-import.csv
            </a>
          </li>
        </ul>
        <pre className="mt-3 overflow-auto rounded-md bg-brand-n100 p-3 text-[11px] text-brand-ink">
{`name,sku,barcode,category,pricingMode,price,stock,discountEligible,lowStockAt
White Sugar 1kg,GRO-SUG-1,4801000000011,Groceries,pc,65,24,true,5
Pork Belly,MEA-BELLY,4801000000042,Meat,kg,320,12.5,false,3`}
        </pre>
      </TableCard>

      {recentBatches.length > 0 && (
        <TableCard className="mb-4 max-h-none p-5">
          <h2 className="m-0 text-base">Recent imports</h2>
          <p className="mt-1 text-xs text-brand-muted">
            Undo removes the products this import created and reverses the stock it added
            (including restocks to existing products) — an existing product&apos;s own details
            are not changed.
          </p>
          <div className="mt-3 divide-y divide-brand-softline">
            {recentBatches.map((batch) => (
              <div key={batch.id} className="flex items-center justify-between gap-3 py-2.5 text-xs">
                <div className="min-w-0">
                  <strong className="block truncate text-brand-ink">{batch.filename || 'Import'}</strong>
                  <span className="text-[11px] text-brand-subtle">
                    {new Date(batch.created_at).toLocaleString()} · {batch.created_count} new ·{' '}
                    {batch.updated_count} restocked
                    {batch.status === 'reverted' ? ' · Reverted' : ''}
                    {batch.status === 'revert_requested'
                      ? ` · Revert requested${canRevert ? ` by ${batch.requester?.full_name || 'supervisor'}` : ' — awaiting manager'}`
                      : ''}
                  </span>
                </div>
                {canRevert && batch.status !== 'reverted' && (
                  <div className="flex shrink-0 items-center gap-2">
                    {batch.status === 'revert_requested' && (
                      <SecondaryButton
                        compact
                        type="button"
                        disabled={dismissBusyId === batch.id}
                        onClick={() => dismissRevert(batch)}
                      >
                        {dismissBusyId === batch.id ? 'Dismissing…' : 'Dismiss'}
                      </SecondaryButton>
                    )}
                    <SecondaryButton compact type="button" onClick={() => setConfirmRevert(batch)}>
                      Undo
                    </SecondaryButton>
                  </div>
                )}
                {!canRevert &&
                  batch.status === 'committed' &&
                  Date.now() - new Date(batch.created_at).getTime() <= REVERT_REQUEST_WINDOW_MS && (
                    <SecondaryButton
                      compact
                      type="button"
                      className="shrink-0"
                      disabled={requestBusyId === batch.id}
                      onClick={() => requestRevert(batch)}
                    >
                      {requestBusyId === batch.id ? 'Requesting…' : 'Request revert'}
                    </SecondaryButton>
                  )}
              </div>
            ))}
          </div>
        </TableCard>
      )}

      {preview && (
        <TableCard className="mb-4 max-h-none p-5">
          <h2 className="m-0 text-lg">Import preview</h2>
          <p className="mt-1 text-xs text-brand-muted">
            {preview.filename} · {preview.updateCount} restock · {preview.createCount} new ·{' '}
            {preview.skippedCount} skipped — review updates below before confirming.
          </p>
          {duplicate && (
            <div className="mt-3 rounded-md border border-brand-warn-line bg-brand-warn-surface px-3 py-3 text-xs text-brand-warn">
              <p className="m-0 font-bold">
                This file was already imported on {new Date(duplicate.created_at).toLocaleString()}
                {duplicate.status === 'reverted' ? ' (later reverted)' : ''}.
              </p>
              <label className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={acknowledgeDuplicate}
                  onChange={(e) => setAcknowledgeDuplicate(e.target.checked)}
                />
                Import again anyway
              </label>
            </div>
          )}

          {(preview.lines || []).length > 0 && (
            <div className="mt-3">
              <ImportPreviewLines
                lines={preview.lines}
                creates={preview.creates}
                updates={preview.updates}
              />
            </div>
          )}

          {(preview.skipped || []).length > 0 && (
            <div className="mt-4">
              <p className="m-0 mb-1 text-[11px] font-bold text-brand-warn">
                Skipped ({preview.skippedCount}) — not added
              </p>
              <div className="max-h-48 overflow-auto text-xs">
                {(preview.skipped || []).map((line, i) => (
                  <div
                    key={`skip-${i}`}
                    className="border-t border-brand-softline py-1.5 first:border-t-0"
                  >
                    <strong className="text-brand-ink">
                      {line.values?.name || line.values?.sku || `Row ${(line.index ?? 0) + 1}`}
                    </strong>
                    {line.values?.sku ? (
                      <span className="text-brand-subtle"> · {line.values.sku}</span>
                    ) : null}
                    <div className="text-[11px] text-brand-warn">{line.reason || 'Skipped'}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <SecondaryButton compact type="button" disabled={busy} onClick={() => setPreview(null)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton
              compact
              type="button"
              disabled={busy || !(preview.lines || []).length}
              onClick={commit}
            >
              {busy ? 'Importing…' : 'Confirm import'}
            </PrimaryButton>
          </div>
        </TableCard>
      )}

      {confirmRevert && (
        <Modal wide layer onClose={() => !revertBusy && setConfirmRevert(null)}>
          <Eyebrow>UNDO IMPORT</Eyebrow>
          <h2 className="mb-3 text-[22px]">Undo &ldquo;{confirmRevert.filename}&rdquo;?</h2>
          <p className="mb-3 text-sm text-brand-muted">
            Deactivates the {confirmRevert.created_count} product(s) this import created and
            reverses the stock it added, including restocks to existing products. Existing
            products stay active — only the stock and any newly-created rows are undone.
          </p>
          <ModalActions>
            <SecondaryButton compact type="button" disabled={revertBusy} onClick={() => setConfirmRevert(null)}>
              Back
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={revertBusy} onClick={revertBatch}>
              {revertBusy ? 'Undoing…' : 'Undo import'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </>
  )
}
