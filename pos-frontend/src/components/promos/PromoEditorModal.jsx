import { useEffect, useMemo, useRef, useState } from 'react'
import { FiPlus, FiRefreshCw } from 'react-icons/fi'
import {
  bootstrapPosCatalog,
  createPromoAcrossBranches,
  createPromoRule,
  createPromoWithRules,
  deletePromoRule,
  fetchPromoRulesForEvent,
  updatePromoEventDetails,
} from '../../lib/api'
import { formatSupportError } from '../../utils/errors'
import { expandPromoRuleRows, validatePromoDates, validatePromoRuleDraft } from '../../utils/promo'
import {
  Eyebrow,
  Field,
  Modal,
  ModalActions,
  PrimaryButton,
  SecondaryButton,
  SelectField,
  tableHeadClass,
} from '../ui'

function ProductMultiSelect({ products, selected, onChange, label, hint, invalid = false }) {
  const [search, setSearch] = useState('')
  const term = search.trim().toLowerCase()
  const visible = term
    ? products.filter(
        (p) =>
          String(p.name || '').toLowerCase().includes(term) ||
          String(p.sku || '').toLowerCase().includes(term),
      )
    : products
  const selectedSet = new Set(selected)
  const visibleIds = visible.map((p) => p.id)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id))
  const selectedProducts = useMemo(
    () => selected.map((id) => products.find((p) => p.id === id)).filter(Boolean),
    [selected, products],
  )

  const toggle = (id, on) => {
    const next = new Set(selected)
    if (on) next.add(id)
    else next.delete(id)
    onChange([...next])
  }

  return (
    <div className="sm:col-span-2">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold text-brand-n700">
          {label}
          {selected.length > 0 && <span className="ml-1 text-brand-subtle">· {selected.length} selected</span>}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="border-0 bg-transparent text-[11px] font-bold text-brand-ink underline"
            onClick={() => {
              const next = new Set(selected)
              if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id))
              else visibleIds.forEach((id) => next.add(id))
              onChange([...next])
            }}
          >
            {allVisibleSelected ? 'Clear shown' : 'Select all shown'}
          </button>
          {selected.length > 0 && (
            <button
              type="button"
              className="border-0 bg-transparent text-[11px] font-bold text-brand-ink underline"
              onClick={() => onChange([])}
            >
              Clear all
            </button>
          )}
        </div>
      </div>
      {selectedProducts.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selectedProducts.map((p) => (
            <button
              key={p.id}
              type="button"
              className="rounded-full border border-brand-line bg-brand-n100 px-2 py-0.5 text-[10px] text-brand-ink"
              onClick={() => toggle(p.id, false)}
            >
              {p.name} ×
            </button>
          ))}
        </div>
      )}
      <input
        className="mb-2 w-full rounded border border-brand-line bg-brand-card p-2 text-xs text-brand-ink outline-none"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search name or SKU…"
      />
      <div
        className={`max-h-[200px] overflow-auto rounded border bg-brand-card p-2.5 ${invalid ? 'border-brand-danger' : 'border-brand-softline'}`}
      >
        {visible.map((p) => (
          <label key={p.id} className="flex cursor-pointer items-center justify-between gap-3 py-1.5 text-xs">
            <span className="min-w-0 truncate">
              {p.name} <span className="text-brand-subtle">({p.sku})</span>
            </span>
            <input
              type="checkbox"
              checked={selectedSet.has(p.id)}
              onChange={(e) => toggle(p.id, e.target.checked)}
            />
          </label>
        ))}
        {visible.length === 0 && (
          <div className="py-3 text-center text-[11px] text-brand-subtle">No products match that search.</div>
        )}
      </div>
      {invalid && <div className="mt-2 text-[10px] font-semibold text-brand-danger">Required: select at least one product.</div>}
      {hint && <div className="mt-2 text-[11px] text-brand-subtle">{hint}</div>}
    </div>
  )
}

const RULE_TYPE_LABELS = {
  item_pct: 'individual item %',
  pair_pct: 'pair %',
  bundle_pct: 'bundle %',
  bogo_pct: 'buy-1-take-1',
}

function localDateTimeValue(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

let stagedRuleSeq = 0

/**
 * Create or edit a pending promo (event + rules) in one modal.
 * Live promos are edited via requestPromoEdit → opens this modal on the pending revision.
 */
export default function PromoEditorModal({
  open,
  onClose,
  mode = 'create',
  branchId: initialBranchId = '',
  branches = [],
  products: initialProducts = [],
  event = null,
  managerView = false,
  staffId = null,
  onSaved,
  onError,
}) {
  const isEdit = mode === 'edit' && event?.id

  const [branchId, setBranchId] = useState(initialBranchId || '')
  const [eventName, setEventName] = useState('')
  const [eventDescription, setEventDescription] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyLabel, setBusyLabel] = useState('')
  const [localError, setLocalError] = useState('')
  const [ruleError, setRuleError] = useState('')
  const [formAttempted, setFormAttempted] = useState(false)
  const [ruleAttempted, setRuleAttempted] = useState(false)
  const [extraBranchIds, setExtraBranchIds] = useState([])

  const [serverRules, setServerRules] = useState([])
  const [stagedRules, setStagedRules] = useState([])

  const [ruleType, setRuleType] = useState('item_pct')
  const [discountPct, setDiscountPct] = useState(20)
  const [productSingle, setProductSingle] = useState(null)
  const [productA, setProductA] = useState(null)
  const [productB, setProductB] = useState(null)
  const [bundleSelected, setBundleSelected] = useState([])
  const [bundleName, setBundleName] = useState('')
  const [itemSelected, setItemSelected] = useState([])
  const [catalogProducts, setCatalogProducts] = useState([])
  const [productsBusy, setProductsBusy] = useState(false)

  const sessionKey = open ? `${mode}:${event?.id || 'new'}:${initialBranchId || ''}` : ''
  const loadedSessionRef = useRef('')

  // Init form once per open/session — NOT on every parent re-render (live stats polling
  // was passing a new onError each time and re-running this effect, wiping bundle picks).
  useEffect(() => {
    if (!open) {
      loadedSessionRef.current = ''
      return
    }
    if (loadedSessionRef.current === sessionKey) return
    loadedSessionRef.current = sessionKey

    setLocalError('')
    setRuleError('')
    setBusyLabel('')
    setFormAttempted(false)
    setRuleAttempted(false)
    setExtraBranchIds([])
    setBranchId(initialBranchId || event?.branch_id || '')
    setEventName(event?.name || '')
    setEventDescription(event?.description || '')
    setStartsAt(event?.starts_at ? localDateTimeValue(event.starts_at) : localDateTimeValue(new Date()))
    setEndsAt(event?.ends_at ? localDateTimeValue(event.ends_at) : '')
    setStagedRules([])
    setServerRules([])
    setRuleType('item_pct')
    setDiscountPct(20)
    setProductSingle(null)
    setProductA(null)
    setProductB(null)
    setBundleSelected([])
    setBundleName('')
    setItemSelected([])
  }, [open, sessionKey, initialBranchId, event?.branch_id, event?.description, event?.ends_at, event?.name, event?.starts_at])

  useEffect(() => {
    if (!open || !isEdit || !event?.id) return undefined
    let cancelled = false
    fetchPromoRulesForEvent(event.id)
      .then((rules) => {
        if (!cancelled) setServerRules(rules)
      })
      .catch((e) => {
        if (!cancelled) setLocalError(formatSupportError(e, 'PROMO07'))
      })
    return () => {
      cancelled = true
    }
  }, [open, isEdit, event?.id])

  const effectiveBranchId = branchId || initialBranchId || event?.branch_id || ''

  // Load branch catalog whenever the effective branch is known (including in-modal branch pick).
  useEffect(() => {
    if (!open || !effectiveBranchId) {
      setCatalogProducts([])
      return undefined
    }
    let cancelled = false
    setProductsBusy(true)
    // Only data.products is ever read below — bootstrapPosCatalog (products/inventory/
    // categories/branch only) gets the same result at a fraction of bootstrapBranchData's
    // payload, which also pulls up to 200 recent transactions + 500 stock movements +
    // day-ends this modal never uses (see egress audit, 2026-08-15).
    bootstrapPosCatalog(effectiveBranchId)
      .then((data) => {
        if (!cancelled) setCatalogProducts(data.products || [])
      })
      .catch((e) => {
        if (!cancelled) {
          setCatalogProducts([])
          setLocalError(formatSupportError(e, 'PROMO07'))
        }
      })
      .finally(() => {
        if (!cancelled) setProductsBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, effectiveBranchId])

  const productList = catalogProducts.length ? catalogProducts : initialProducts

  const eligibleProducts = useMemo(() => {
    if (ruleType === 'pair_pct' || ruleType === 'bundle_pct' || ruleType === 'bogo_pct') {
      return productList.filter((p) => p.pricingMode !== 'kg')
    }
    return productList
  }, [ruleType, productList])

  // Inactive branches don't run a live catalog to match SKUs against — offering them here
  // just produces a guaranteed "no matching products" skip. `is_active` may be absent on
  // demo/legacy branch rows; treat missing as active rather than hiding everything.
  const otherActiveBranches = useMemo(
    () => branches.filter((b) => b.id !== effectiveBranchId && b.is_active !== false),
    [branches, effectiveBranchId],
  )

  const selectedProductsForRule = useMemo(() => {
    if (ruleType === 'item_pct') return itemSelected
    if (ruleType === 'bogo_pct') return [productSingle].filter(Boolean)
    if (ruleType === 'pair_pct') return [productA, productB].filter(Boolean)
    if (ruleType === 'bundle_pct') return bundleSelected
    return []
  }, [ruleType, itemSelected, productSingle, productA, productB, bundleSelected])

  const allRules = isEdit ? serverRules : stagedRules
  const ruleCount = allRules.length

  // Scoped per rule type — a product can sit in an item_pct rule AND a pair_pct rule AND a
  // bundle_pct rule at once (computePromoDiscounts resolves overlaps at checkout by taking
  // the best line discount, never stacking). Only a second rule of the SAME type for the
  // same product is ambiguous authoring, so that's the only combination blocked here.
  const usedProductIdsByType = useMemo(() => {
    const map = new Map()
    for (const r of allRules) {
      const set = map.get(r.ruleType) || new Set()
      for (const p of r.products || []) {
        if (p.productId) set.add(p.productId)
        else if (typeof p === 'string') set.add(p)
      }
      for (const pid of r.productIds || []) set.add(pid)
      map.set(r.ruleType, set)
    }
    return map
  }, [allRules])

  const resetRuleForm = () => {
    setProductSingle(null)
    setProductA(null)
    setProductB(null)
    setBundleSelected([])
    setBundleName('')
    setItemSelected([])
    setRuleError('')
    setRuleAttempted(false)
  }

  const formatProductNames = (ids) =>
    ids.map((id) => productList.find((p) => p.id === id)?.name || id).join(', ')

  const handleAddRule = async () => {
    setRuleAttempted(true)
    const result = validatePromoRuleDraft({
      ruleType,
      discountPct,
      productA,
      productB,
      bundleName,
      bundleSelected,
      selectedProductsForRule,
      usedProductIdsByType,
    })
    if (result?.message) {
      setRuleError(result.message)
      return
    }
    if (result?.duplicateIds) {
      setRuleError(
        `${formatProductNames(result.duplicateIds)} already ${result.duplicateIds.length > 1 ? 'have' : 'has'} a ${RULE_TYPE_LABELS[ruleType] || 'matching'} rule on this promo. Remove the existing rule or pick other products. A different rule type is fine (e.g. also in a pair or bundle).`,
      )
      return
    }

    setRuleError('')
    setBusy(true)
    setBusyLabel('Adding rule…')
    try {
      const rulePayload = {
        ruleType,
        discountPct: Number(discountPct),
        productIds: selectedProductsForRule,
        buyQty: 1,
        getQty: 1,
        bundleName: ruleType === 'bundle_pct' ? bundleName.trim() : null,
      }

      if (isEdit) {
        await createPromoRule({
          promoEventId: event.id,
          ...rulePayload,
        })
        const next = await fetchPromoRulesForEvent(event.id)
        setServerRules(next)
      } else {
        stagedRuleSeq += 1
        setStagedRules((prev) => [
          ...prev,
          {
            localId: `staged-${stagedRuleSeq}`,
            ...rulePayload,
            products: selectedProductsForRule.map((id) => {
              const p = productList.find((x) => x.id === id)
              return { productId: id, productName: p?.name, sku: p?.sku }
            }),
          },
        ])
      }
      resetRuleForm()
    } catch (e) {
      setRuleError(formatSupportError(e, 'PROMO02'))
    } finally {
      setBusy(false)
      setBusyLabel('')
    }
  }

  const handleDeleteRule = async (rule) => {
    setBusy(true)
    setBusyLabel('Removing rule…')
    setLocalError('')
    try {
      if (isEdit) {
        await deletePromoRule(rule.id)
        setServerRules((prev) => prev.filter((r) => r.id !== rule.id))
      } else {
        setStagedRules((prev) => prev.filter((r) => r.localId !== rule.localId))
      }
    } catch (e) {
      setLocalError(formatSupportError(e, 'PROMO02'))
    } finally {
      setBusy(false)
      setBusyLabel('')
    }
  }

  const handleSubmit = async () => {
    setFormAttempted(true)
    // Submitting the promo abandons whatever partial rule is still sitting in the "add rule"
    // staging fields — clear its attempted-validation flag too, or a product picker left
    // empty from an earlier "Add rule" click stays red here even though that draft was never
    // going to be included.
    setRuleAttempted(false)
    const targetBranch = effectiveBranchId
    if (!targetBranch) {
      setLocalError('Select a branch before creating a promo.')
      return
    }
    if (!eventName.trim()) {
      setLocalError('Enter a promo name.')
      return
    }
    const dateError = validatePromoDates(startsAt, endsAt, { allowPastStart: isEdit })
    if (dateError) {
      setLocalError(dateError)
      return
    }
    if (ruleCount < 1) {
      setLocalError('Add at least one promo rule before submitting.')
      return
    }

    const branchName = (id) => branches.find((b) => b.id === id)?.name || id

    setBusy(true)
    setLocalError('')
    try {
      if (isEdit) {
        setBusyLabel('Saving changes…')
        await updatePromoEventDetails({
          promoEventId: event.id,
          name: eventName.trim(),
          description: eventDescription.trim() || null,
          startsAt,
          endsAt,
        })
        onSaved?.()
      } else if (extraBranchIds.length > 0) {
        setBusyLabel(`Creating on ${branchName(targetBranch)}…`)
        const results = await createPromoAcrossBranches({
          branchIds: [targetBranch, ...extraBranchIds],
          name: eventName.trim(),
          description: eventDescription.trim() || null,
          startsAt,
          endsAt,
          staffId,
          rules: stagedRules.map((r) => ({
            ruleType: r.ruleType,
            discountPct: r.discountPct,
            buyQty: r.buyQty,
            getQty: r.getQty,
            bundleName: r.bundleName,
            skus: (r.products || []).map((p) => p.sku).filter(Boolean),
          })),
          onProgress: ({ branchId, index, total }) =>
            setBusyLabel(`Creating on ${branchName(branchId)} (${index + 1}/${total})…`),
        })
        const created = results.filter((r) => r.status === 'created')
        const skipped = results.filter((r) => r.status === 'skipped')
        const errored = results.filter((r) => r.status === 'error')
        if (!created.length) {
          throw new Error(
            `Could not create the promo on any selected branch: ${[...skipped, ...errored]
              .map((r) => `${branchName(r.branchId)}: ${r.reason || r.error}`)
              .join('; ')}`,
          )
        }
        const parts = [`Created on ${created.length} of ${results.length} branch${results.length === 1 ? '' : 'es'}.`]
        if (skipped.length) {
          parts.push(`Skipped (no matching products): ${skipped.map((r) => branchName(r.branchId)).join(', ')}.`)
        }
        if (errored.length) {
          parts.push(`Failed: ${errored.map((r) => `${branchName(r.branchId)} (${r.error})`).join('; ')}.`)
        }
        onSaved?.(parts.join(' '))
      } else {
        setBusyLabel(managerView ? 'Creating promo…' : 'Submitting for approval…')
        await createPromoWithRules({
          branchId: targetBranch,
          name: eventName.trim(),
          description: eventDescription.trim() || null,
          startsAt,
          endsAt,
          staffId,
          rules: stagedRules.map((r) => ({
            ruleType: r.ruleType,
            discountPct: r.discountPct,
            productIds: r.productIds,
            buyQty: r.buyQty,
            getQty: r.getQty,
            bundleName: r.bundleName,
          })),
        })
        onSaved?.()
      }
      onClose?.()
    } catch (e) {
      const msg = formatSupportError(e, isEdit ? 'PROMO03' : 'PROMO01')
      setLocalError(msg)
      onError?.(msg)
    } finally {
      setBusy(false)
      setBusyLabel('')
    }
  }

  if (!open) return null

  const showBranchPicker = !initialBranchId && mode === 'create'

  return (
    <Modal wide onClose={() => !busy && onClose?.()}>
      <Eyebrow>{isEdit ? 'EDIT PROMO' : managerView ? 'CREATE PROMO' : 'REQUEST PROMO'}</Eyebrow>
      <h2 className="m-0 text-lg">
        {isEdit
          ? event?.supersedes_event_id
            ? 'Edit revision (needs reapproval)'
            : 'Edit pending promo'
          : managerView
            ? 'New promo event'
            : 'Request new promo'}
      </h2>
      <p className="m-0 mt-1 text-xs text-brand-muted">
        {isEdit
          ? 'Change details and rules while pending. Approved promos cannot be edited directly.'
          : 'Set schedule and add rules before submitting. At least one rule is required.'}
      </p>

      {(localError) && (
        <div className="mt-3 rounded-md border border-brand-danger bg-brand-card px-3 py-2 text-xs text-brand-danger">
          {localError}
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {showBranchPicker && (
          <SelectField
            label="Branch"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            error={formAttempted && !branchId ? 'Required' : ''}
          >
            <option value="">Select a branch…</option>
            {branches.filter((b) => b.is_active !== false).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </SelectField>
        )}
        <Field
          label="Promo name"
          value={eventName}
          onChange={(e) => setEventName(e.target.value)}
          placeholder="e.g. Valentines"
          error={formAttempted && !eventName.trim() ? 'Required' : ''}
        />
        <label className="block text-xs sm:col-span-2">
          <div className="mb-1 font-bold text-brand-muted">Description (optional)</div>
          <textarea
            rows={2}
            value={eventDescription}
            onChange={(e) => setEventDescription(e.target.value)}
            placeholder="What is this promo about?"
            className="w-full rounded border border-brand-line bg-brand-card p-2.5 text-brand-ink outline-none"
          />
        </label>
        <label className="block text-xs">
          <div className="mb-1 font-bold text-brand-muted">Starts at</div>
          <input
            type="datetime-local"
            value={startsAt}
            min={isEdit ? undefined : localDateTimeValue(new Date())}
            onChange={(e) => setStartsAt(e.target.value)}
            className={`w-full rounded border bg-brand-card p-2.5 text-brand-ink outline-none ${formAttempted && !startsAt ? 'border-brand-danger' : 'border-brand-line'}`}
          />
          {formAttempted && !startsAt && <span className="mt-1 block text-[10px] font-semibold text-brand-danger">Required</span>}
        </label>
        <label className="block text-xs">
          <div className="mb-1 font-bold text-brand-muted">Ends at</div>
          <input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className={`w-full rounded border bg-brand-card p-2.5 text-brand-ink outline-none ${formAttempted && !endsAt ? 'border-brand-danger' : 'border-brand-line'}`}
          />
          {formAttempted && !endsAt && <span className="mt-1 block text-[10px] font-semibold text-brand-danger">Required</span>}
        </label>
        {showBranchPicker && effectiveBranchId && otherActiveBranches.length > 0 && (
          <div className="sm:col-span-2">
            <div className="mb-1 text-xs font-bold text-brand-n700">
              Also create on
              {extraBranchIds.length > 0 && (
                <span className="ml-1 text-brand-subtle">· {extraBranchIds.length} more branch{extraBranchIds.length > 1 ? 'es' : ''}</span>
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 rounded border border-brand-softline bg-brand-card p-2.5">
              {otherActiveBranches.map((b) => (
                  <label key={b.id} className="flex cursor-pointer items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={extraBranchIds.includes(b.id)}
                      onChange={(e) => {
                        setExtraBranchIds((prev) =>
                          e.target.checked ? [...prev, b.id] : prev.filter((id) => id !== b.id),
                        )
                      }}
                    />
                    {b.name}
                  </label>
                ))}
            </div>
            <div className="mt-1 text-[11px] text-brand-subtle">
              Same name, dates, and rules. Products are matched by SKU on each branch; a branch
              missing a product just skips it for that branch.
            </div>
          </div>
        )}
      </div>

      <div className="mt-5">
        <h3 className="m-0 text-sm font-bold text-brand-ink">Rules ({ruleCount})</h3>
        <p className="m-0 mt-1 text-xs text-brand-subtle">Applied only when cashier did not select PWD/Senior.</p>

        {allRules.length > 0 && (
          <div className="mt-3 overflow-x-auto rounded border border-brand-softline">
            <table className="min-w-full text-left text-xs">
              <thead className={tableHeadClass}>
                <tr>
                  <th className="px-3 py-2.5">Rule type</th>
                  <th className="px-3 py-2.5">Discount %</th>
                  <th className="px-3 py-2.5">Products</th>
                  <th className="px-3 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {expandPromoRuleRows(allRules).map((r) => (
                  <tr key={r.key} className="border-t border-brand-softline">
                    <td className="px-3 py-2 font-bold text-brand-ink">
                      {r.ruleType}
                      {r.bundleName && <span className="block font-normal text-brand-subtle">{r.bundleName}</span>}
                    </td>
                    <td className="px-3 py-2">{r.discountPct}% off</td>
                    <td className="px-3 py-2">
                      {(r.products || []).map((p, idx) => (
                        <span key={p.productId || idx} className="block">
                          {p.productName || p.productId}
                          {p.sku ? ` (${p.sku})` : ''}
                        </span>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.isFirstOfGroup && (
                        <button
                          type="button"
                          className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                          disabled={busy}
                          onClick={() => void handleDeleteRule(r)}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {showBranchPicker && !branchId && (
          <p className="m-0 mt-2 text-xs text-brand-warn sm:col-span-2">Select a branch to load products.</p>
        )}

        {productsBusy && (
          <p className="m-0 mt-2 text-xs text-brand-subtle sm:col-span-2">Loading products…</p>
        )}

        {!productsBusy && effectiveBranchId && productList.length === 0 && (
          <p className="m-0 mt-2 text-xs text-brand-warn sm:col-span-2">
            No active products on this branch. Add products in Catalog first.
          </p>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Rule type"
            value={ruleType}
            onChange={(e) => {
              setRuleType(e.target.value)
              setRuleError('')
              setRuleAttempted(false)
            }}
          >
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
          {ruleType === 'item_pct' && (
            <ProductMultiSelect
              label="Products on this promo"
              products={productList}
              selected={itemSelected}
              onChange={(ids) => {
                setItemSelected(ids)
                setRuleError('')
              }}
              hint="Every ticked product gets this % off. A product can also sit in a pair/bundle/BOGO rule, they just won't stack at checkout."
              invalid={ruleAttempted && itemSelected.length === 0}
            />
          )}
          {ruleType === 'bogo_pct' && (
            <SelectField
              label="Product"
              value={productSingle || ''}
              onChange={(e) => {
                setProductSingle(e.target.value || null)
                setRuleError('')
              }}
              error={ruleAttempted && !productSingle ? 'Required' : ''}
            >
              <option value="">Select product…</option>
              {eligibleProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.sku})
                </option>
              ))}
            </SelectField>
          )}
          {ruleType === 'pair_pct' && (
            <>
              <SelectField
                label="Product A"
                value={productA || ''}
                onChange={(e) => { setProductA(e.target.value || null); setRuleError('') }}
                error={ruleAttempted && !productA ? 'Required' : ''}
              >
                <option value="">Select…</option>
                {eligibleProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </SelectField>
              <SelectField
                label="Product B"
                value={productB || ''}
                onChange={(e) => { setProductB(e.target.value || null); setRuleError('') }}
                error={ruleAttempted && !productB ? 'Required' : ''}
              >
                <option value="">Select…</option>
                {eligibleProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </SelectField>
            </>
          )}
          {ruleType === 'bundle_pct' && (
            <>
              <Field
                label="Bundle name"
                value={bundleName}
                onChange={(e) => setBundleName(e.target.value)}
                placeholder="e.g. Meryenda Bundle"
                error={ruleAttempted && !bundleName.trim() ? 'Required' : ''}
              />
              <ProductMultiSelect
                label="Bundle products"
                products={eligibleProducts}
                selected={bundleSelected}
                onChange={(ids) => {
                  setBundleSelected(ids)
                  setRuleError('')
                }}
                hint={bundleSelected.length < 2 ? 'Select at least 2 products for a bundle.' : null}
                invalid={ruleAttempted && bundleSelected.length < 2}
              />
            </>
          )}
        </div>

        {ruleError && (
          <div
            role="alert"
            className="mt-3 rounded-md border border-brand-danger bg-brand-danger-bg px-3 py-2 text-xs text-brand-danger"
          >
            {ruleError}
          </div>
        )}

        <div className="mt-3 flex justify-end">
          <SecondaryButton
            compact
            type="button"
            disabled={busy}
            onClick={() => void handleAddRule()}
          >
            <FiPlus className="mr-1" />
            {busy ? 'Adding…' : 'Add rule'}
          </SecondaryButton>
        </div>
      </div>

      <ModalActions>
        {busy && (
          <div className="mr-auto flex items-center gap-1.5 text-xs font-semibold text-brand-subtle">
            <FiRefreshCw className="animate-spin" size={13} />
            {busyLabel || 'Working…'}
          </div>
        )}
        <SecondaryButton compact type="button" disabled={busy} onClick={() => onClose?.()}>
          Cancel
        </SecondaryButton>
        <PrimaryButton
          compact
          type="button"
          disabled={busy || ruleCount < 1}
          onClick={() => void handleSubmit()}
        >
          {busy ? 'Saving…' : isEdit ? 'Save changes' : managerView ? 'Create promo' : 'Submit for approval'}
        </PrimaryButton>
      </ModalActions>
    </Modal>
  )
}
