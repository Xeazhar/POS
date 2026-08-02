/** Restaurant / carinderia ulam helpers */

export const MENU_KINDS = [
  { id: 'meat', label: 'Meat ulam', hasBudget: true },
  { id: 'veggie', label: 'Veggie ulam', hasBudget: true },
  { id: 'pancit', label: 'Pancit', hasBudget: false },
  { id: 'drink', label: 'Drinks', hasBudget: false },
  { id: 'rice', label: 'Rice', hasBudget: false },
  { id: 'extra', label: 'Extra', hasBudget: false },
]

export function normalizeMenuKind(value, categoryName = '') {
  const raw = String(value || '').toLowerCase().trim().replace(/[\s-]+/g, '_')
  if (['meat', 'veggie', 'pancit', 'drink', 'rice', 'extra'].includes(raw)) return raw
  const cat = String(categoryName || '').toLowerCase()
  if (cat.includes('pancit')) return 'pancit'
  if (cat.includes('drink')) return 'drink'
  if (cat.includes('rice')) return 'rice'
  // Legacy plate labels from earlier potahe import
  if (cat.includes('meat on meat') || cat === 'meat') return 'meat'
  if (cat.includes('veggie on veggie') || cat === 'veggie') return 'veggie'
  if (cat.includes('meat on veggie')) return 'meat'
  if (cat.includes('veggie') && cat.includes('meat')) return 'meat'
  if (cat.includes('veggie')) return 'veggie'
  if (cat.includes('meat')) return 'meat'
  if (cat.includes('extra')) return 'extra'
  return 'extra'
}

/** Prefer category name that matches menu kind for restaurant catalog. */
export function categoryForMenuKind(menuKind, fallbackCategory = '') {
  const kind = normalizeMenuKind(menuKind, fallbackCategory)
  const map = {
    meat: 'Meat',
    veggie: 'Veggie',
    pancit: 'Pancit',
    drink: 'Drink',
    rice: 'Rice',
    extra: 'Extra',
  }
  return map[kind] || fallbackCategory || 'Extra'
}

export function hasBudgetTier(menuKind) {
  return menuKind === 'meat' || menuKind === 'veggie'
}

export function effectiveUnitPrice(item) {
  const kind = item.menuKind || 'extra'
  const regular = Number(item.regularPrice ?? item.price ?? 0)
  const budget = item.budgetPrice != null ? Number(item.budgetPrice) : null
  if (hasBudgetTier(kind) && item.priceTier === 'budget' && budget != null && !Number.isNaN(budget)) {
    return budget
  }
  return regular
}

export function lineTotal(item) {
  const unit = effectiveUnitPrice(item)
  const qty = item.pricingMode === 'kg' ? Number(item.weight || 0) : Number(item.quantity || 1)
  return unit * qty
}

/** Expand meat/veggie lines by quantity; return combo label when exactly 2 ulams. */
export function detectUlamCombo(items = []) {
  const kinds = []
  items.forEach((item) => {
    const kind = item.menuKind
    if (kind !== 'meat' && kind !== 'veggie') return
    const count = item.pricingMode === 'kg' ? 1 : Math.max(1, Math.round(Number(item.quantity || 1)))
    for (let i = 0; i < count; i += 1) kinds.push(kind)
  })
  if (kinds.length !== 2) return null
  const meats = kinds.filter((k) => k === 'meat').length
  const veggies = kinds.filter((k) => k === 'veggie').length
  if (meats === 2) return { code: 'meat_meat', label: 'Meat + Meat' }
  if (meats === 1 && veggies === 1) return { code: 'meat_veggie', label: 'Meat + Veggie' }
  if (veggies === 2) return { code: 'veggie_veggie', label: 'Veggie + Veggie' }
  return null
}

export function categoryLabelForKind(menuKind) {
  return MENU_KINDS.find((k) => k.id === menuKind)?.label || 'Extra'
}
