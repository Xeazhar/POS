import db from './db'
import { createVerifier, verifyAgainst } from '../utils/unlockVerifier'
import { isSupervisorOrAbove, isManagerRole } from '../utils/roles'

const GENERIC_PIN_ERROR = 'Invalid supervisor code or PIN'

function normalizeLoginCode(loginCode) {
  return String(loginCode || '').replace(/\D/g, '')
}

function canApproveAtBranch(row, branchId) {
  if (!row?.role) return false
  if (row.role === 'supervisor') return row.branchId === branchId
  return isManagerRole(row.role)
}

/**
 * Replace branch-scoped verifier cache from server pull.
 * Managers/admins may belong to other branches but can approve via PIN offline.
 */
export async function putSupervisorVerifiers(branchId, rows = []) {
  if (!branchId) return
  await db.transaction('rw', db.supervisorVerifiers, async () => {
    const incomingIds = new Set((rows || []).map((r) => r.staffId || r.staff_id).filter(Boolean))
    const existing = await db.supervisorVerifiers.toArray()
    for (const row of existing) {
      const isBranchSupervisor = row.branchId === branchId && row.role === 'supervisor'
      const isNetworkManager = isManagerRole(row.role)
      if (isBranchSupervisor || (isNetworkManager && incomingIds.has(row.staffId))) {
        await db.supervisorVerifiers.delete(row.staffId)
      }
    }
    const toPut = (rows || [])
      .filter((r) => r.pinVerifier || r.pin_verifier)
      .map((r) => ({
        staffId: r.staffId || r.staff_id,
        branchId: r.branchId || r.branch_id || branchId,
        loginCode: normalizeLoginCode(r.loginCode || r.login_code),
        fullName: r.fullName || r.full_name || r.name || 'Supervisor',
        role: r.role || 'supervisor',
        pinVerifier: r.pinVerifier || r.pin_verifier,
        updatedAt: new Date().toISOString(),
      }))
    if (toPut.length) await db.supervisorVerifiers.bulkPut(toPut)
  })
}

/** Learn/update a verifier after a successful online PIN check. */
export async function cacheSupervisorVerifierFromPin({ staffId, staff_id, fullName, full_name, role, branchId, branch_id }, loginCode, pin) {
  const id = staffId || staff_id
  if (!id || !pin) return
  const verifier = await createVerifier(id, String(pin).trim())
  const row = {
    staffId: id,
    branchId: branchId || branch_id || null,
    loginCode: normalizeLoginCode(loginCode),
    fullName: fullName || full_name || 'Supervisor',
    role: role || 'supervisor',
    pinVerifier: verifier,
    updatedAt: new Date().toISOString(),
  }
  await db.supervisorVerifiers.put(row)
  return verifier
}

export async function upsertLocalSupervisorVerifier({ staffId, loginCode, fullName, role, branchId, pinVerifier }) {
  if (!staffId || !pinVerifier) return
  await db.supervisorVerifiers.put({
    staffId,
    branchId: branchId || null,
    loginCode: normalizeLoginCode(loginCode),
    fullName: fullName || 'Supervisor',
    role: role || 'supervisor',
    pinVerifier,
    updatedAt: new Date().toISOString(),
  })
}

async function findVerifierCandidates(branchId, loginCode) {
  const code = normalizeLoginCode(loginCode)
  if (code.length < 4) return []
  const all = await db.supervisorVerifiers.toArray()
  return all.filter(
    (row) =>
      row.loginCode === code &&
      row.pinVerifier &&
      canApproveAtBranch(row, branchId),
  )
}

/**
 * Verify supervisor/manager PIN locally. Throws generic error on any failure.
 */
export async function verifySupervisorPinOffline(branchId, loginCode, pin) {
  const pinVal = String(pin || '').trim()
  if (pinVal.length < 4 || normalizeLoginCode(loginCode).length < 4) {
    throw new Error(GENERIC_PIN_ERROR)
  }

  const candidates = await findVerifierCandidates(branchId, loginCode)
  if (!candidates.length) {
    throw new Error(GENERIC_PIN_ERROR)
  }

  for (const row of candidates) {
    const { ok } = await verifyAgainst(row.pinVerifier, row.staffId, pinVal)
    if (ok) {
      if (!isSupervisorOrAbove(row.role) && !isManagerRole(row.role)) {
        throw new Error(GENERIC_PIN_ERROR)
      }
      return {
        staffId: row.staffId,
        staff_id: row.staffId,
        fullName: row.fullName,
        full_name: row.fullName,
        name: row.fullName,
        role: row.role,
      }
    }
  }

  throw new Error(GENERIC_PIN_ERROR)
}

export async function countSupervisorVerifiers(branchId) {
  if (!branchId) return 0
  const rows = await db.supervisorVerifiers.toArray()
  return rows.filter((r) => canApproveAtBranch(r, branchId)).length
}
