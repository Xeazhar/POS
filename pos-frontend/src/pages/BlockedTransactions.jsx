import { useEffect, useState } from 'react'
import {
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  TableCard,
  tableHeadClass,
  tableRowClass,
  moneyClass,
} from '../components/ui'
import {
  listBlocked,
  markManuallyRecorded,
  unmarkManuallyRecorded,
  retryBlockedItem,
  retryBlocked,
} from '../offline/syncQueue'
import { syncBranch } from '../offline'
import { useAuthStore } from '../stores/posStore'
import { useSyncStore } from '../stores/syncStore'
import { money } from '../utils/format'
import { downloadText } from '../utils/terminalReports'

const TYPE_LABELS = {
  complete_sale: 'Sale',
  void_sale: 'Void',
  adjust_stock: 'Stock adjustment',
  set_inventory: 'Inventory set',
  submit_day: 'Day-end submit',
  approve_day: 'Day-end approve',
  close_day: 'Day-end close',
  reopen_day: 'Day-end reopen',
  request_day_end: 'Day-end request',
  reject_day_request: 'Day-end reject',
  create_product: 'Product create',
  update_product: 'Product update',
  price_change: 'Price change',
  open_shift: 'Shift open',
  close_shift: 'Shift close',
  cash_movement_approved: 'Cash movement',
  cash_movement_pending: 'Cash movement (pending)',
  cash_movement_pin_approve: 'Cash movement (PIN approve)',
  cash_movement_self_record: 'Cash movement (self-record)',
  log_approval_event: 'Approval log',
}

function typeLabel(type) {
  return TYPE_LABELS[type] || type
}

function saleAmount(row) {
  if (row.type !== 'complete_sale') return null
  const total = Number(row.payload?.total)
  return Number.isFinite(total) ? total : null
}

function csvEscape(value) {
  const s = value == null ? '' : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(rows) {
  const header = [
    'id',
    'clientId',
    'type',
    'createdAt',
    'attempts',
    'lastError',
    'amount',
    'invoiceNumber',
    'manuallyRecordedAt',
  ]
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.clientId,
        row.type,
        row.createdAt,
        row.attempts,
        row.lastError,
        saleAmount(row) ?? '',
        row.payload?.invoiceNumber ?? '',
        row.manuallyRecordedAt ?? '',
      ]
        .map(csvEscape)
        .join(','),
    )
  }
  return lines.join('\n')
}

export default function BlockedTransactions() {
  const user = useAuthStore((state) => state.user)
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [showRecorded, setShowRecorded] = useState(false)
  const [expandedId, setExpandedId] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const load = async () => {
    setLoading(true)
    const blocked = await listBlocked(user?.branchId || null)
    setRows(blocked)
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.branchId])

  const visible = rows.filter((r) => (showRecorded ? true : !r.manuallyRecordedAt))

  const refreshSyncChip = () => useSyncStore.getState().refresh(user?.branchId)

  const handleRetryAll = async () => {
    await retryBlocked(user?.branchId || null)
    if (user?.branchId) await syncBranch(user.branchId)
    await refreshSyncChip()
    await load()
  }

  const handleRetryOne = async (id) => {
    setBusyId(id)
    await retryBlockedItem(id)
    if (user?.branchId) await syncBranch(user.branchId)
    await refreshSyncChip()
    await load()
    setBusyId(null)
  }

  const handleToggleRecorded = async (row) => {
    setBusyId(row.id)
    if (row.manuallyRecordedAt) await unmarkManuallyRecorded(row.id)
    else await markManuallyRecorded(row.id)
    await load()
    setBusyId(null)
  }

  const handleExportAll = () => {
    downloadText(toCsv(visible), `blocked-transactions-${Date.now()}.csv`)
  }

  const handleExportOne = (row) => {
    downloadText(toCsv([row]), `blocked-transaction-${row.clientId || row.id}.csv`)
  }

  return (
    <div>
      <PageHeader eyebrow="Sync" title="Blocked transactions">
        <div className="flex gap-2">
          <SecondaryButton compact onClick={() => setShowRecorded((v) => !v)}>
            {showRecorded ? 'Hide recorded' : 'Show recorded'}
          </SecondaryButton>
          <SecondaryButton compact onClick={handleExportAll} disabled={visible.length === 0}>
            Export CSV
          </SecondaryButton>
          <PrimaryButton compact onClick={handleRetryAll} disabled={rows.length === 0}>
            Retry all
          </PrimaryButton>
        </div>
      </PageHeader>

      <p className="mb-4 text-xs leading-snug text-brand-muted">
        These records could not sync to the server after repeated attempts. They stay stored on
        this device only — nothing is deleted. Use the row detail to manually record a sale in
        your books, or retry once the underlying cause is fixed.
      </p>

      <TableCard>
        <table className="w-full min-w-[720px] border-collapse text-[12px]">
          <thead>
            <tr className={tableHeadClass}>
              <th className="px-4 py-2.5 text-left">Time</th>
              <th className="px-4 py-2.5 text-left">Type</th>
              <th className="px-4 py-2.5 text-right">Amount</th>
              <th className="px-4 py-2.5 text-left">Attempts</th>
              <th className="px-4 py-2.5 text-left">Last error</th>
              <th className="px-4 py-2.5 text-left">Status</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-brand-muted">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-brand-muted">
                  No blocked transactions{showRecorded ? '' : ' needing attention'}.
                </td>
              </tr>
            )}
            {visible.map((row) => {
              const amount = saleAmount(row)
              const expanded = expandedId === row.id
              return (
                <>
                  <tr
                    key={row.id}
                    className={`${tableRowClass} cursor-pointer`}
                    onClick={() => setExpandedId(expanded ? null : row.id)}
                  >
                    <td className="px-4 py-2.5">{new Date(row.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-2.5">{typeLabel(row.type)}</td>
                    <td className={`px-4 py-2.5 text-right ${moneyClass}`}>
                      {amount != null ? money(amount) : '—'}
                    </td>
                    <td className="px-4 py-2.5">{row.attempts}</td>
                    <td className="max-w-[240px] truncate px-4 py-2.5" title={row.lastError || ''}>
                      {row.lastError || '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      {row.manuallyRecordedAt ? (
                        <StatusBadge tone="success" compact>
                          Recorded
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="danger" compact>
                          Needs attention
                        </StatusBadge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-1.5">
                        <SecondaryButton
                          compact
                          disabled={busyId === row.id}
                          onClick={() => handleRetryOne(row.id)}
                        >
                          Retry
                        </SecondaryButton>
                        <SecondaryButton
                          compact
                          disabled={busyId === row.id}
                          onClick={() => handleToggleRecorded(row)}
                        >
                          {row.manuallyRecordedAt ? 'Unmark' : 'Mark recorded'}
                        </SecondaryButton>
                        <SecondaryButton compact onClick={() => handleExportOne(row)}>
                          Export
                        </SecondaryButton>
                      </div>
                    </td>
                  </tr>
                  {expanded && (
                    <tr key={`${row.id}-detail`} className="border-t border-brand-softline bg-brand-n50">
                      <td colSpan={7} className="px-4 py-3">
                        <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words text-[11px] text-brand-n700">
                          {JSON.stringify(row.payload, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </TableCard>
    </div>
  )
}
