/**
 * Feature switches for temporarily archived product surfaces.
 *
 * Restaurant / carinderia (ulam, dine-in/takeout, potahe menu, budget tiers) is
 * archived while we focus on meat + retail POS. Code and SQL stay in the repo;
 * flip RESTAURANT_FEATURES_ENABLED to true to restore UI + branch typing.
 *
 * See docs/archive/restaurant-features.md
 */

/** When false, every branch is treated as retail/meat — restaurant UI is unreachable. */
export const RESTAURANT_FEATURES_ENABLED = false

/** Normalize DB/UI branch_type through the feature gate. */
export function normalizeBranchType(raw) {
  if (RESTAURANT_FEATURES_ENABLED && raw === 'restaurant') return 'restaurant'
  return 'retail'
}

/** True only when restaurant features are enabled AND type is restaurant. */
export function isRestaurantBranchType(raw) {
  return normalizeBranchType(raw) === 'restaurant'
}
