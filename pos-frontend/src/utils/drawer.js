/**
 * Which physical cash drawer / terminal this browser is.
 *
 * Every branch is treated as one shared drawer — cash moves with the cashier between
 * terminals, not the other way around, so there is nothing to distinguish per-device.
 * Fixed constants, not a per-device setting: this used to be a localStorage id a till could
 * be pointed at (Settings → Devices), which gated a "your shift is open on another till"
 * block. That gate assumed the drawer stays put and the cashier moves between drawers —
 * backwards for a shop where the cash tray itself travels with the cashier, so it just
 * blocked ordinary till switches. Removed; every terminal now reports the same identity.
 */

export const FALLBACK_DRAWER_ID = 'main'

export function getDrawerId() {
  return FALLBACK_DRAWER_ID
}

export function getDrawerLabel() {
  return 'Main drawer'
}

export function drawerIdentity() {
  return { drawerId: getDrawerId(), drawerLabel: getDrawerLabel() }
}
