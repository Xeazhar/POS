/** Shared between ManagerAnnouncements.jsx (composer) and CashierDashboard.jsx (feed) so
 *  the category list and its emoji never drift between the two screens. */
export const ANNOUNCEMENT_KINDS = [
  { value: 'general', label: 'General', emoji: '📌' },
  { value: 'promo', label: 'Promo', emoji: '📢' },
  { value: 'price', label: 'Price update', emoji: '📢' },
  { value: 'reminder', label: 'Reminder', emoji: '⚠️' },
  { value: 'maintenance', label: 'Maintenance', emoji: '🔧' },
]

export const ANNOUNCEMENT_EMOJI = Object.fromEntries(ANNOUNCEMENT_KINDS.map((k) => [k.value, k.emoji]))
