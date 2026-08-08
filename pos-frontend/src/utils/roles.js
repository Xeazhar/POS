/** Role helpers + default module permissions */

export const ROLES = {
  cashier: 'cashier',
  supervisor: 'supervisor',
  manager: 'manager',
  admin: 'admin',
  master: 'master',
}

export const MODULES = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'pos', label: 'POS' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'inventory', label: 'Inventory / Menu' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'day_end', label: 'Day end' },
  { id: 'devices', label: 'Devices' },
  { id: 'shifts', label: 'Shifts' },
  { id: 'manager_overview', label: 'Manager overview' },
  { id: 'manager_branches', label: 'Branches' },
  { id: 'manager_staff', label: 'Staff' },
  { id: 'manager_data', label: 'Data' },
  { id: 'manager_promos', label: 'Promos' },
  { id: 'manager_reports', label: 'Reports' },
]

const DEFAULTS = {
  // A cashier's job is: ring sales, look up a past sale, close the drawer. Nothing else.
  // Dashboard/Inventory/Devices used to be included, which meant every cashier could see
  // branch revenue and edit stock as a matter of course — access nobody had decided to
  // grant, it was just the default. Anyone who genuinely needs more gets it per-person,
  // and the Staff page now flags that as "Elevated" so the exception stays visible.
  cashier: ['pos', 'transactions', 'day_end'],
  supervisor: [
    'dashboard',
    'pos',
    'transactions',
    'inventory',
    'catalog',
    'day_end',
    'devices',
    'shifts',
    'manager_promos',
  ],
  manager: [
    'manager_overview',
    'manager_branches',
    'manager_staff',
    'manager_data',
    'manager_promos',
    'manager_reports',
    'shifts',
  ],
  admin: [
    'manager_overview',
    'manager_branches',
    'manager_staff',
    'manager_data',
    'manager_promos',
    'manager_reports',
    'shifts',
  ],
  master: [
    'dashboard',
    'pos',
    'transactions',
    'inventory',
    'catalog',
    'day_end',
    'devices',
    'shifts',
    'manager_overview',
    'manager_branches',
    'manager_staff',
    'manager_data',
    'manager_promos',
    'manager_reports',
  ],
}

/**
 * Rank of each role. Higher outranks lower.
 *
 * This exists to stop privilege escalation through the Staff page. Without a ranking,
 * "can open the Staff module" silently means "can mint a master account" — so anyone who
 * gets a manager login once can promote themselves permanently, and every audit trail
 * afterwards attributes their actions to a legitimately-created account. The ceiling below
 * is the difference between a compromised manager login and a compromised system.
 *
 * Mirrored server-side by migrate_role_assignment_ceiling.sql. The UI check is for a good
 * error message; the database trigger is the control.
 */
export const ROLE_RANK = {
  cashier: 10,
  supervisor: 20,
  manager: 30,
  admin: 40,
  master: 50,
}

export function roleRank(role) {
  return ROLE_RANK[role] ?? 0
}

/**
 * Can `actor` create or edit an account holding `targetRole`?
 *
 * Strictly less-than, not less-than-or-equal: a manager may not create another manager.
 * Peer creation is how one compromised account becomes several, and it removes the
 * property that every account has someone above it who is accountable for its existence.
 * `master` is the one exception — it is the top of the tree, so it must be able to
 * create its own peers or the tree has no root that can be replaced.
 */
export function canAssignRole(actor, targetRole) {
  const actorRank = roleRank(actor?.role)
  const targetRank = roleRank(targetRole)
  if (!actorRank || !targetRank) return false
  if (actor?.role === 'master') return true
  return targetRank < actorRank
}

/** Roles this actor is allowed to hand out — for populating the role picker. */
export function assignableRoles(actor) {
  return Object.keys(ROLE_RANK).filter((role) => canAssignRole(actor, role))
}

/**
 * Can `actor` modify this specific account at all?
 *
 * Two separate rules, both load-bearing:
 *  - Nobody edits their own account. Self-edit is the shortest escalation path there is
 *    (tick every module, save, reload) and it also lets someone deactivate their own
 *    supervisor to escape an approval requirement. Changing your own role should require
 *    someone else, always.
 *  - Nobody edits an account at or above their own rank. Otherwise a manager can demote
 *    the admin who supervises them.
 */
export function canEditStaff(actor, target) {
  if (!actor || !target) return false
  if (actor.id && target.id && actor.id === target.id) return false
  if (actor.role === 'master') return true
  return roleRank(target.role) < roleRank(actor.role)
}

export function isManagerRole(role) {
  return role === 'manager' || role === 'admin' || role === 'master'
}

export function isSupervisorOrAbove(role) {
  return role === 'supervisor' || isManagerRole(role)
}

export function usesPinLogin(role) {
  return role === 'cashier' || role === 'supervisor'
}

export function defaultPermissionsFor(role) {
  return [...(DEFAULTS[role] || DEFAULTS.cashier)]
}

export function effectivePermissions(user) {
  if (!user) return []
  if (Array.isArray(user.permissions)) return user.permissions
  return defaultPermissionsFor(user.role)
}

/** Deduped, trimmed, sorted — so two equal sets always compare equal. */
function normalizePermissions(list) {
  return [...new Set((list || []).map((id) => String(id).trim()).filter(Boolean))].sort()
}

/**
 * How one account's access differs from its role's defaults.
 *
 * Replaces a bare "Custom access" tag, which was accurate but useless: it fired for
 * *any* difference and never said which, so narrowing a cashier to the three modules
 * they actually use looked identical to granting one extra module they shouldn't have.
 *
 * Only `extra` is a security signal — that is access beyond what the role implies, and
 * it is what a review should stop on. `missing` is ordinary scoping and is reported as
 * plain information, not a warning, so the warning tone keeps meaning something.
 */
export function permissionDiff(person) {
  const defaults = normalizePermissions(defaultPermissionsFor(person?.role))
  if (!Array.isArray(person?.permissions)) {
    return { mode: 'default', extra: [], missing: [], elevated: false }
  }
  const actual = normalizePermissions(person.permissions)
  const extra = actual.filter((id) => !defaults.includes(id))
  const missing = defaults.filter((id) => !actual.includes(id))
  if (!extra.length && !missing.length) return { mode: 'default', extra: [], missing: [], elevated: false }
  return { mode: extra.length ? 'elevated' : 'restricted', extra, missing, elevated: extra.length > 0 }
}

export function moduleLabel(moduleId) {
  return MODULES.find((m) => m.id === moduleId)?.label || moduleId
}

export function canAccessModule(user, moduleId) {
  if (!user) return false
  if (user.role === 'master' || user.role === 'admin') return true
  return effectivePermissions(user).includes(moduleId)
}

export function pinAuthEmail(loginCode, branchId) {
  const code = String(loginCode || '').replace(/\D/g, '')
  const branch = String(branchId || 'x').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8)
  return `pin.${code}.${branch}@calepos.local`
}
