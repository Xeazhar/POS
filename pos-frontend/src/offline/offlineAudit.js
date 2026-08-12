import db from './db'
import { newClientId, QUEUE_TYPES } from './queueTypes'
import { enqueue } from './syncQueue'

/** Durable local audit row — survives refresh; synced via outbox queue. */
export async function recordOfflineApprovalAudit({
  branchId,
  requestedBy,
  approvedBy = null,
  approverName = null,
  approverRole = null,
  action,
  detail = null,
  meta = {},
  deviceId = null,
  clientId = null,
}) {
  const auditClientId = clientId || newClientId('audit')
  const createdAt = new Date().toISOString()
  const row = {
    clientId: auditClientId,
    branchId: branchId || null,
    eventType: action.startsWith('approval:') ? action : `approval:${action}`,
    action: meta.action || action,
    detail,
    requestedBy: requestedBy || null,
    approvedBy: approvedBy || null,
    approverName: approverName || null,
    approverRole: approverRole || null,
    deviceId: deviceId || null,
    offline: true,
    syncStatus: 'PENDING_SYNC',
    meta: {
      ...meta,
      action: meta.action || action,
      requested_by: requestedBy || null,
      approved_by: approvedBy || null,
      approver_name: approverName,
      approver_role: approverRole,
      offline: true,
      device_id: deviceId || null,
      offline_client_id: auditClientId,
    },
    createdAt,
    updatedAt: createdAt,
  }

  await db.offlineAuditEvents.put(row)
  await enqueue(
    QUEUE_TYPES.LOG_APPROVAL_EVENT,
    {
      branchId,
      requestedBy,
      approvedBy,
      approverName,
      approverRole,
      action: action.replace(/^approval:/, ''),
      detail,
      meta: row.meta,
      clientId: auditClientId,
      deviceId: deviceId || null,
      createdAt,
    },
    { branchId, clientId: auditClientId },
  )
  return row
}

export async function markOfflineAuditSynced(clientId) {
  const row = await db.offlineAuditEvents.get(clientId)
  if (!row) return
  await db.offlineAuditEvents.put({
    ...row,
    syncStatus: 'synced',
    updatedAt: new Date().toISOString(),
  })
}

export async function listPendingOfflineAudits(branchId = null) {
  let rows = await db.offlineAuditEvents
    .where('syncStatus')
    .equals('PENDING_SYNC')
    .sortBy('createdAt')
  if (branchId) rows = rows.filter((r) => r.branchId === branchId)
  return rows
}
