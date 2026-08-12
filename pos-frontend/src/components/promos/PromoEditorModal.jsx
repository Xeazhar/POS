import { useEffect, useMemo, useRef, useState } from 'react'
import { FiPlus } from 'react-icons/fi'
import {
  bootstrapBranchData,
  createPromoRule,
  createPromoWithRules,
  deletePromoRule,
  fetchPromoRulesForEvent,
  updatePromoEventDetails,
} from '../../lib/api'
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

function ProductMultiSelect({ products, selected, onChange, label, hint }) {
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
              title="Remove from selection"
              onClick={() => toggle(p.id, false)}
            >
              {p.name} ×
            </button>
          ))}
        </div>
      )}
      <input
        className="mb-2 w-full rounded border border-brand-line bg-white p-2 text-xs text-brand-ink outline-none"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search name or SKU…"
      />
      <div className="max-h-[200px] overflow-auto rounded border border-brand-softline bg-white p-2.5">
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
      {hint && <div className="mt-2 text-[11px] text-brand-subtle">{hint}</div>}
    </div>
  )
}

function localDateTimeValue(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function validatePromoDates(startsAt, endsAt, { allowPastStart = false } = {}) {
  if (!startsAt || !endsAt) return 'Enter a promo duration (Starts at + Ends at).'
  const startDate = new Date(startsAt)
  const endDate = new Date(endsAt)
  if (endDate <= startDate) return 'End date must be after start date.'
  if (!allowPastStart) {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    if (startDate < today) return 'Start date cannot be in the past.'
  }
  return null
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
  const [localError, setLocalError] = useState('')
  const [ruleError, setRuleError] = useState('')

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
        if (!cancelled) setLocalError(e?.message || 'Failed to load promo rules.')
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
    bootstrapBranchData(effectiveBranchId)
      .then((data) => {
        if (!cancelled) setCatalogProducts(data.products || [])
      })
      .catch((e) => {
        if (!cancelled) {
          setCatalogProducts([])
          setLocalError(e?.message || 'Failed to load branch products.')
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

  const selectedProductsForRule = useMemo(() => {
    if (ruleType === 'item_pct') return itemSelected
    if (ruleType === 'bogo_pct') return [productSingle].filter(Boolean)
    if (ruleType === 'pair_pct') return [productA, productB].filter(Boolean)
    if (ruleType === 'bundle_pct') return bundleSelected
    return []
  }, [ruleType, itemSelected, productSingle, productA, productB, bundleSelected])

  const allRules = isEdit ? serverRules : stagedRules
  const ruleCount = allRules.length

  const usedProductIds = useMemo(() => {
    const ids = new Set()
    for (const r of allRules) {
      for (const p of r.products || []) {
        if (p.productId) ids.add(p.productId)
        else if (typeof p === 'string') ids.add(p)
      }
      for (const pid of r.productIds || []) ids.add(pid)
    }
    return ids
  }, [allRules])

  const resetRuleForm = () => {
    setProductSingle(null)
    setProductA(null)
    setProductB(null)
    setBundleSelected([])
    setBundleName('')
    setItemSelected([])
    setRuleError('')
  }

  const formatProductNames = (ids) =>
    ids.map((id) => productList.find((p) => p.id === id)?.name || id).join(', ')

  const handleAddRule = async () => {
    if (!selectedProductsForRule.length) {
      setRuleError('Select at least one product for this rule.')
      return
    }
    if (discountPct < 0 || discountPct > 100) {
      setRuleError('Discount must be between 0 and 100.')
      return
    }
    if (ruleType === 'pair_pct' && productA && productB && productA === productB) {
      setRuleError('Pair rule needs two different products.')
      return
    }
    if (ruleType === 'bundle_pct') {
      if (!bundleName.trim()) {
        setRuleError('Enter a bundle name before adding this rule.')
        return
      }
      if (bundleSelected.length < 2) {
        setRuleError('Select at least 2 products for a bundle.')
        return
      }
    }

    const duplicates = selectedProductsForRule.filter((id) => usedProductIds.has(id))
    if (duplicates.length) {
      setRuleError(
        `${formatProductNames(duplicates)} already ${duplicates.length > 1 ? 'have' : 'has'} a rule on this promo — remove the existing rule or pick other products.`,
      )
      return
    }

    setRuleError('')
    setBusy(true)
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
      setRuleError(e?.message || 'Failed to add promo rule.')
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteRule = async (rule) => {
    setBusy(true)
    setLocalError('')
    try {
      if (isEdit) {
        await deletePromoRule(rule.id)
        setServerRules((prev) => prev.filter((r) => r.id !== rule.id))
      } else {
        setStagedRules((prev) => prev.filter((r) => r.localId !== rule.localId))
      }
    } catch (e) {
      setLocalError(e?.message || 'Failed to delete promo rule.')
    } finally {
      setBusy(false)
    }
  }

  const handleSubmit = async () => {
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

    setBusy(true)
    setLocalError('')
    try {
      if (isEdit) {
        await updatePromoEventDetails({
          promoEventId: event.id,
          name: eventName.trim(),
          description: eventDescription.trim() || null,
          startsAt,
          endsAt,
        })
      } else {
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
      }
      onSaved?.()
      onClose?.()
    } catch (e) {
      const msg = e?.message || 'Failed to save promo.'
      setLocalError(msg)
      onError?.(msg)
    } finally {
      setBusy(false)
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
        <div className="mt-3 rounded-md border border-brand-danger bg-white px-3 py-2 text-xs text-brand-danger">
          {localError}
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {showBranchPicker && (
          <SelectField label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">Select a branch…</option>
            {branches.map((b) => (
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
        />
        <label className="block text-xs sm:col-span-2">
          <div className="mb-1 font-bold text-brand-muted">Description (optional)</div>
          <textarea
            rows={2}
            value={eventDescription}
            onChange={(e) => setEventDescription(e.target.value)}
            placeholder="What is this promo about?"
            className="w-full rounded border border-brand-line bg-white p-2.5 text-brand-ink outline-none"
          />
        </label>
        <label className="block text-xs">
          <div className="mb-1 font-bold text-brand-muted">Starts at</div>
          <input
            type="datetime-local"
            value={startsAt}
            min={isEdit ? undefined : localDateTimeValue(new Date())}
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
                {allRules.map((r) => (
                  <tr key={r.id || r.localId} className="border-t border-brand-softline">
                    <td className="px-3 py-2 font-bold text-brand-ink">
                      {r.ruleType}
                      {r.bundleName && <span className="block font-normal text-brand-subtle">{r.bundleName}</span>}
                    </td>
                    <td className="px-3 py-2">{r.discountPct}% off</td>
                    <td className="px-3 py-2">
                      {(r.products || [])
                        .map((p) => `${p.productName || p.productId}${p.sku ? ` (${p.sku})` : ''}`)
                        .join(', ')}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                        disabled={busy}
                        onClick={() => void handleDeleteRule(r)}
                      >
                        Delete
                      </button>
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
              hint="Every ticked product gets this % off. Each product can only appear in one rule."
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
              <SelectField label="Product A" value={productA || ''} onChange={(e) => { setProductA(e.target.value || null); setRuleError('') }}>
                <option value="">Select…</option>
                {eligibleProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </SelectField>
              <SelectField label="Product B" value={productB || ''} onChange={(e) => { setProductB(e.target.value || null); setRuleError('') }}>
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
            disabled={
              busy ||
              !selectedProductsForRule.length ||
              (ruleType === 'bundle_pct' && (!bundleName.trim() || bundleSelected.length < 2)) ||
              (ruleType === 'pair_pct' && selectedProductsForRule.length < 2)
            }
            onClick={() => void handleAddRule()}
          >
            <FiPlus className="mr-1" />
            {busy ? 'Adding…' : 'Add rule'}
          </SecondaryButton>
        </div>
      </div>

      <ModalActions>
        <SecondaryButton compact type="button" disabled={busy} onClick={() => onClose?.()}>
          Cancel
        </SecondaryButton>
        <PrimaryButton
          compact
          type="button"
          disabled={busy || !eventName.trim() || !startsAt || !endsAt || ruleCount < 1 || (!isEdit && !effectiveBranchId)}
          onClick={() => void handleSubmit()}
        >
          {busy ? 'Saving…' : isEdit ? 'Save changes' : managerView ? 'Create promo' : 'Submit for approval'}
        </PrimaryButton>
      </ModalActions>
    </Modal>
  )
}
