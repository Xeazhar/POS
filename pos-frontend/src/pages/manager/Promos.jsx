import { useEffect, useMemo, useState } from 'react'
import {
  hasSupabase,
  bootstrapBranchData,
  createAndActivatePromoEvent,
  createPromoRule,
  fetchActivePromoEventWithRules,
  deletePromoRule,
  updatePromoEventDetails,
  fetchPromoEventsForBranch,
  deletePromoEvent,
  fetchBranches,
} from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { isManagerRole } from '../../utils/roles'
import {
  Eyebrow,
  Field,
  Modal,
  ModalActions,
  PageHeader,
  PrimaryButton,
  SelectField,
  SecondaryButton,
  TableCard,
} from '../../components/ui'
import { FiPlus } from 'react-icons/fi'

/**
 * Manager / Supervisor Promos
 * - Promos are always scoped to one branch (never all branches)
 * - Managers pick the branch first, then manage that branch's promos
 * - Supervisors only see / manage the promo for their assigned branch
 *
 * Promo rules:
 *  - item_pct: applies % off to a selected product (all units)
 *  - pair_pct: applies % off to both matched products (for matched quantity pairs)
 *  - bundle_pct: applies % off to all products in the bundle (for matched bundle sets)
 *  - bogo_pct: buy_qty/get_qty (default 1/1). Applies % discount to get units (second unit for B1T1)
 *
 * POS side will fetch `fetchActivePromoEventWithRules(branchId)` and apply discounts automatically.
 */
export default function ManagerPromos() {
  const user = useAuthStore((s) => s.user)
  const managerView = isManagerRole(user?.role)

  const [branches, setBranches] = useState([])
  const [branchId, setBranchId] = useState('')
  const [products, setProducts] = useState([])

  const [active, setActive] = useState(null)
  const [busy, setBusy] = useState(false)
  const [eventName, setEventName] = useState('')
  const [error, setError] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')

  const [ruleType, setRuleType] = useState('item_pct')
  const [discountPct, setDiscountPct] = useState(20)
  const [productSingle, setProductSingle] = useState(null)
  const [productA, setProductA] = useState(null)
  const [productB, setProductB] = useState(null)
  const [bundleSelected, setBundleSelected] = useState([])

  const [history, setHistory] = useState([])
  const [editingEventId, setEditingEventId] = useState(null)
  const [editStartsAt, setEditStartsAt] = useState('')
  const [editEndsAt, setEditEndsAt] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)

  const selectedBranch = branches.find((b) => b.id === branchId)
  const selectedProductsForRule = useMemo(() => {
    if (ruleType === 'item_pct' || ruleType === 'bogo_pct') return [productSingle].filter(Boolean)
    if (ruleType === 'pair_pct') return [productA, productB].filter(Boolean)
    if (ruleType === 'bundle_pct') return bundleSelected
    return []
  }, [ruleType, productSingle, productA, productB, bundleSelected])

  // Managers: load all branches and require an explicit selection.
  // Supervisors: lock to their assigned branch only.
  useEffect(() => {
    if (!managerView) {
      const id = user?.branchId || (hasSupabase ? '' : 'demo-main-branch')
      setBranches([
        {
          id,
          name: user?.branchName || 'Assigned branch',
        },
      ])
      setBranchId(id)
      return
    }
    if (!hasSupabase) {
      setBranches([
        {
          id: user?.branchId || 'demo-main-branch',
          name: user?.branchName || 'Demo branch',
        },
      ])
      setBranchId('')
      return
    }
    fetchBranches()
      .then((rows) => {
        setBranches(rows)
        setBranchId('')
      })
      .catch((err) => setError(err.message))
  }, [user, managerView])

  useEffect(() => {
    setActive(null)
    setHistory([])
    setProducts([])
    setProductSingle(null)
    setProductA(null)
    setProductB(null)
    setBundleSelected([])
    setEventName('')
    setStartsAt('')
    setEndsAt('')
    setEditingEventId(null)
    setEditStartsAt('')
    setEditEndsAt('')
    setPendingDelete(null)

    if (!hasSupabase || !branchId) return

    void (async () => {
      try {
        const data = await bootstrapBranchData(branchId)
        setProducts(data.products || [])
        const next = await fetchActivePromoEventWithRules(branchId, { respectDuration: false })
        setActive(next)
        const rows = await fetchPromoEventsForBranch(branchId)
        setHistory(rows)
      } catch (e) {
        setError(e?.message || 'Failed to load branch promos.')
      }
    })()
  }, [branchId])

  useEffect(() => {
    const isoToLocalValue = (iso) => {
      if (!iso) return ''
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      // datetime-local expects: YYYY-MM-DDTHH:mm
      return d.toISOString().slice(0, 16)
    }
    setStartsAt(isoToLocalValue(active?.event?.startsAt))
    setEndsAt(isoToLocalValue(active?.event?.endsAt))
  }, [active?.event?.startsAt, active?.event?.endsAt])

  const refreshHistory = async () => {
    if (!hasSupabase || !branchId) {
      setHistory([])
      return
    }
    const rows = await fetchPromoEventsForBranch(branchId)
    setHistory(rows)
  }

  const refreshActive = async () => {
    if (!branchId) {
      setActive(null)
      setHistory([])
      return
    }
    const next = await fetchActivePromoEventWithRules(branchId, { respectDuration: false })
    setActive(next)
    await refreshHistory()
  }

  const onCreateEvent = async () => {
    if (!branchId) {
      setError('Select a branch before creating a promo.')
      return
    }
    if (!eventName.trim()) return
    if (!startsAt || !endsAt) {
      setError('Enter a promo duration (Starts at + Ends at) before creating.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await createAndActivatePromoEvent({
        branchId,
        name: eventName.trim(),
        startsAt: startsAt || null,
        endsAt: endsAt || null,
      })
      setEventName('')
      await refreshActive()
    } catch (e) {
      setError(e?.message || 'Failed to create promo event.')
    } finally {
      setBusy(false)
    }
  }

  const onDeleteRule = async (ruleId) => {
    if (!ruleId) return
    setBusy(true)
    setError('')
    try {
      await deletePromoRule(ruleId)
      await refreshActive()
    } catch (e) {
      setError(e?.message || 'Failed to delete promo rule.')
    } finally {
      setBusy(false)
    }
  }

  const isoToLocalValueForEdit = (iso) => {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toISOString().slice(0, 16)
  }

  const onDeleteEvent = async (promoEventId) => {
    if (!promoEventId) return
    setBusy(true)
    setError('')
    try {
      await deletePromoEvent(promoEventId)
      await refreshActive()
    } catch (e) {
      setError(e?.message || 'Failed to delete promo event.')
    } finally {
      setBusy(false)
    }
  }

  const onStartEditEvent = (row) => {
    if (!row?.id) return
    setEditingEventId(row.id)
    setEditStartsAt(isoToLocalValueForEdit(row.starts_at))
    setEditEndsAt(isoToLocalValueForEdit(row.ends_at))
  }

  const onCancelEditEvent = () => {
    setEditingEventId(null)
    setEditStartsAt('')
    setEditEndsAt('')
  }

  const openDeleteConfirm = (payload) => {
    setPendingDelete(payload)
  }

  const closeDeleteConfirm = () => {
    if (busy) return
    setPendingDelete(null)
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    if (pendingDelete.kind === 'rule') {
      await onDeleteRule(pendingDelete.id)
    } else if (pendingDelete.kind === 'event') {
      await onDeleteEvent(pendingDelete.id)
    }
    setPendingDelete(null)
  }

  const onSaveEditEvent = async () => {
    if (!editingEventId) return
    if (!editStartsAt || !editEndsAt) {
      setError('Enter Starts + Ends when modifying an event.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await updatePromoEventDetails({
        promoEventId: editingEventId,
        startsAt: editStartsAt || null,
        endsAt: editEndsAt || null,
      })
      await refreshActive()
      onCancelEditEvent()
    } catch (e) {
      setError(e?.message || 'Failed to modify promo event duration.')
    } finally {
      setBusy(false)
    }
  }

  const onAddRule = async () => {
    if (!active?.event?.id) return
    if (!selectedProductsForRule.length) return
    if (discountPct < 0 || discountPct > 100) return
    setBusy(true)
    setError('')
    try {
      let buyQty = 1
      let getQty = 1
      // MVP: B1T1 only (buy 1, get 1)
      if (ruleType !== 'bogo_pct') {
        buyQty = 1
        getQty = 1
      }
      await createPromoRule({
        promoEventId: active.event.id,
        ruleType,
        discountPct: Number(discountPct),
        productIds: selectedProductsForRule,
        buyQty,
        getQty,
      })

      setProductSingle(null)
      setProductA(null)
      setProductB(null)
      setBundleSelected([])
      await refreshActive()
    } catch (e) {
      setError(e?.message || 'Failed to create promo rule.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader eyebrow={managerView ? 'MANAGER' : 'SUPERVISOR'} title="Manage promo events" />
      {error && <div className="mb-3 rounded-md border border-brand-danger bg-white px-3 py-2 text-xs text-brand-danger">{error}</div>}

      <TableCard className="mb-4 max-h-none overflow-visible p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          {managerView ? (
            <SelectField
              label="Branch"
              className="w-full min-w-0 sm:max-w-[280px]"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="">Select a branch…</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </SelectField>
          ) : (
            <p className="m-0 text-xs text-brand-muted sm:pb-1">
              Branch: <strong className="text-brand-ink">{user?.branchName || selectedBranch?.name || 'Assigned branch'}</strong>
              <span className="mt-1 block text-brand-subtle">You can only view promos for your assigned branch.</span>
            </p>
          )}
          {managerView && branchId && (
            <p className="m-0 text-xs text-brand-subtle sm:pb-1">
              Promo applies only to <strong className="text-brand-ink">{selectedBranch?.name || 'this branch'}</strong>
            </p>
          )}
        </div>
      </TableCard>

      {!branchId ? (
        <TableCard className="max-h-none overflow-visible p-5">
          <p className="m-0 text-sm text-brand-muted">
            {managerView
              ? 'Select a branch first. Promos are per-branch and never apply to all branches automatically.'
              : 'No assigned branch found for this account.'}
          </p>
        </TableCard>
      ) : (
        <>
      <TableCard className="mb-4 max-h-none overflow-visible p-5">
        <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
          <div>
            <Eyebrow>Active promo</Eyebrow>
            <h2 className="m-0 text-lg">{active?.event?.name || 'No active promo event'}</h2>
            <p className="m-0 mt-1 text-xs text-brand-muted">
              One event can be active at a time for this branch, but that event can contain multiple promo rules.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Field
                  label="New promo event name"
                  value={eventName}
                  onChange={(e) => setEventName(e.target.value)}
                  placeholder="e.g. Valentines"
                />
              </div>
              <PrimaryButton
                compact
                type="button"
                disabled={busy || !branchId || !eventName.trim() || !startsAt || !endsAt}
                onClick={onCreateEvent}
              >
                {busy ? 'Saving…' : 'Create'}
              </PrimaryButton>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs">
                <div className="mb-1 font-bold text-brand-muted">Starts at</div>
                <input
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  className="w-full rounded border border-brand-line bg-white p-2.5 text-brand-ink outline-none"
                />
              </label>
              <label className="block text-xs">
                <div className="mb-1 font-bold text-brand-muted">Ends at</div>
                <input
                  type="datetime-local"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                  className="w-full rounded border border-brand-line bg-white p-2.5 text-brand-ink outline-none"
                />
              </label>
              {/* Duration is required before creating an event; no separate save button. */}
            </div>
          </div>
        </div>
      </TableCard>

      <TableCard className="mb-4 max-h-none overflow-visible p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="m-0 text-base">Rules</h2>
            <p className="m-0 mt-1 text-xs text-brand-subtle">
              {active?.rules?.length ? `${active.rules.length} rule(s)` : 'Add rules to the active event.'}
            </p>
          </div>
        </div>

        {active?.rules?.length ? (
          <div className="mt-4 overflow-x-auto overflow-y-visible">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-[#f7f7f4] text-[9px] tracking-[1px] text-[#989e99] uppercase">
                <tr>
                  <th className="px-3 py-3">Type</th>
                  <th className="px-3 py-3">Discount</th>
                  <th className="px-3 py-3">Involved products</th>
                  <th className="px-3 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {active.rules.map((r) => (
                  <tr key={r.id} className="border-t border-brand-softline">
                    <td className="px-3 py-3 font-bold text-brand-ink">{r.ruleType}</td>
                    <td className="px-3 py-3">
                      {r.discountPct}% off
                    </td>
                    <td className="px-3 py-3">
                      {r.ruleType === 'item_pct' && r.products[0]?.productName
                        ? `${r.products[0].productName}${r.products[0].sku ? ` (${r.products[0].sku})` : ''}`
                        : r.products.map((p) => p.productName || p.productId).join(', ')}
                      {r.ruleType === 'pair_pct' && r.products.length >= 2 && (
                        <span className="text-brand-subtle"> (pair)</span>
                      )}
                      {r.ruleType === 'bundle_pct' && r.products.length >= 2 && (
                        <span className="text-brand-subtle"> (bundle)</span>
                      )}
                      {r.ruleType === 'bogo_pct' && r.products[0] && (
                        <span className="text-brand-subtle">
                          {' '}
                          (buy {r.buyQty || 1} get {r.getQty || 1})
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        type="button"
                        className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                        disabled={busy}
                        onClick={() =>
                          openDeleteConfirm({
                            kind: 'rule',
                            id: r.id,
                            label: r.ruleType,
                          })}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-4 text-xs text-brand-subtle">No rules yet.</div>
        )}
      </TableCard>

      <TableCard className="mb-4 max-h-none p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="m-0 text-base">Promo history</h2>
            <p className="m-0 mt-1 text-xs text-brand-subtle">
              Inactive promo events can be deleted or have their duration modified.
            </p>
          </div>
        </div>

        {history.length ? (
          <div className="mt-4 overflow-x-auto overflow-y-visible">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-[#f7f7f4] text-[9px] tracking-[1px] text-[#989e99] uppercase">
                <tr>
                  <th className="px-3 py-3">Event</th>
                  <th className="px-3 py-3">Duration</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {history.map((e) => {
                  const isActive = Boolean(e.is_active)
                  const isEditing = editingEventId === e.id
                  const fmt = (iso) => {
                    if (!iso) return '—'
                    const d = new Date(iso)
                    if (Number.isNaN(d.getTime())) return '—'
                    return d.toLocaleString([], { month: '2-digit', day: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
                  }

                  return (
                    <tr key={e.id} className="border-t border-brand-softline">
                      <td className="px-3 py-3 font-bold text-brand-ink">{e.name}</td>
                      <td className="px-3 py-3">{fmt(e.starts_at)} → {fmt(e.ends_at)}</td>
                      <td className="px-3 py-3">{isActive ? 'Active' : 'Inactive'}</td>
                      <td className="px-3 py-3 text-right">
                        {isActive ? (
                          <span className="text-brand-subtle">—</span>
                        ) : (
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                              disabled={busy}
                              onClick={() => onStartEditEvent(e)}
                            >
                              Modify
                            </button>
                            <button
                              type="button"
                              className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                              disabled={busy}
                              onClick={() =>
                                openDeleteConfirm({
                                  kind: 'event',
                                  id: e.id,
                                  label: e.name,
                                })}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-4 text-xs text-brand-subtle">No promo events yet.</div>
        )}
      </TableCard>

      <TableCard className="max-h-none overflow-visible p-5">
        <h2 className="m-0 text-base">Add promo rule</h2>
        <p className="m-0 mt-1 text-xs text-brand-muted">
          Applied only when cashier did not select PWD/Senior (no stacking).
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <SelectField label="Rule type" value={ruleType} onChange={(e) => setRuleType(e.target.value)}>
            <option value="item_pct">Individual item % off</option>
            <option value="pair_pct">Pair % off (both items)</option>
            <option value="bundle_pct">Bundle % off (all bundle items)</option>
            <option value="bogo_pct">Buy 1 Take 1 % off second (B1T1)</option>
          </SelectField>

          <Field
            label="Discount % (0-100)"
            inputMode="decimal"
            value={String(discountPct)}
            onChange={(e) => setDiscountPct(Number(e.target.value.replace(/[^\d.]/g, '')))}
          />

          {(ruleType === 'item_pct' || ruleType === 'bogo_pct') && (
            <SelectField
              label="Product"
              value={productSingle || ''}
              onChange={(e) => setProductSingle(e.target.value || null)}
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.sku})
                </option>
              ))}
            </SelectField>
          )}

          {ruleType === 'pair_pct' && (
            <>
              <SelectField label="Product A" value={productA || ''} onChange={(e) => setProductA(e.target.value || null)}>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </SelectField>
              <SelectField label="Product B" value={productB || ''} onChange={(e) => setProductB(e.target.value || null)}>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </SelectField>
            </>
          )}

          {ruleType === 'bundle_pct' && (
            <div className="sm:col-span-2">
              <div className="mb-1 text-xs font-bold text-[#646a66]">Select bundle products</div>
              <div className="max-h-[240px] overflow-auto rounded border border-brand-softline bg-white p-2.5">
                {products.map((p) => {
                  const checked = bundleSelected.includes(p.id)
                  return (
                    <label key={p.id} className="flex items-center justify-between gap-3 py-1.5 text-xs">
                      <span className="min-w-0 truncate">
                        {p.name} <span className="text-brand-subtle">({p.sku})</span>
                      </span>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setBundleSelected((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(p.id)
                            else next.delete(p.id)
                            return [...next]
                          })
                        }}
                      />
                    </label>
                  )
                })}
              </div>
              {bundleSelected.length < 2 && (
                <div className="mt-2 text-[11px] text-brand-subtle">Select at least 2 products for a bundle.</div>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <SecondaryButton
            compact
            type="button"
            disabled={busy || !active?.event?.id || !selectedProductsForRule.length}
            onClick={onAddRule}
          >
            <FiPlus className="mr-1" />
            {busy ? 'Adding…' : 'Add rule'}
          </SecondaryButton>
        </div>
      </TableCard>
        </>
      )}

      {editingEventId && (
        <Modal onClose={onCancelEditEvent}>
          <Eyebrow>MODIFY PROMO</Eyebrow>
          <h2 className="m-0 text-lg">Update promo duration</h2>
          <p className="mt-1 mb-4 text-xs text-brand-muted">
            Set the new start and end date for this promo event.
          </p>

          <div className="grid gap-3">
            <label className="block text-xs">
              <div className="mb-1 font-bold text-brand-muted">Starts at</div>
              <input
                type="datetime-local"
                value={editStartsAt}
                onChange={(ev) => setEditStartsAt(ev.target.value)}
                className="w-full rounded border border-brand-line bg-white p-2.5 text-brand-ink outline-none"
              />
            </label>
            <label className="block text-xs">
              <div className="mb-1 font-bold text-brand-muted">Ends at</div>
              <input
                type="datetime-local"
                value={editEndsAt}
                onChange={(ev) => setEditEndsAt(ev.target.value)}
                className="w-full rounded border border-brand-line bg-white p-2.5 text-brand-ink outline-none"
              />
            </label>
          </div>

          <ModalActions>
            <SecondaryButton compact type="button" disabled={busy} onClick={onCancelEditEvent}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy} onClick={onSaveEditEvent}>
              {busy ? 'Saving…' : 'Save changes'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {pendingDelete && (
        <Modal onClose={closeDeleteConfirm}>
          <Eyebrow>CONFIRM DELETE</Eyebrow>
          <h2 className="m-0 text-lg">
            Delete {pendingDelete.kind === 'rule' ? 'rule' : 'promo event'}?
          </h2>
          <p className="mt-1 mb-0 text-xs text-brand-muted">
            {pendingDelete.label ? `This will remove "${pendingDelete.label}". ` : ''}
            This action cannot be undone.
          </p>

          <ModalActions>
            <SecondaryButton compact type="button" disabled={busy} onClick={closeDeleteConfirm}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy} onClick={() => void confirmDelete()}>
              {busy ? 'Deleting…' : 'Confirm delete'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </div>
  )
}

