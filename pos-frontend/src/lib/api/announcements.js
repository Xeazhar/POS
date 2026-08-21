import { supabase } from '../supabase'

function mapAnnouncement(row) {
  return {
    id: row.id,
    branchId: row.branch_id,
    branchName: row.branches?.name || null,
    authorId: row.author_id,
    authorName: row.staff?.full_name || null,
    kind: row.kind || 'general',
    title: row.title,
    body: row.body,
    isActive: row.is_active !== false,
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
  }
}

/**
 * Visible announcements — RLS does the real filtering: a manager sees every row (their own
 * management list needs inactive/expired ones too); everyone else only sees active,
 * unexpired, branch-matching-or-network-wide rows. Same call site for both CashierDashboard
 * and ManagerAnnouncements.
 */
export async function fetchAnnouncements({ limit = 30 } = {}) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('announcements')
    .select('id, branch_id, author_id, kind, title, body, is_active, expires_at, created_at, staff:author_id(full_name), branches(name)')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data || []).map(mapAnnouncement)
}

export async function createAnnouncement({ branchId = null, authorId, kind = 'general', title, body, expiresAt = null }) {
  const { data, error } = await supabase
    .from('announcements')
    .insert({
      branch_id: branchId,
      author_id: authorId,
      kind,
      title: String(title || '').trim(),
      body: String(body || '').trim(),
      expires_at: expiresAt,
    })
    .select('id, branch_id, author_id, kind, title, body, is_active, expires_at, created_at, staff:author_id(full_name), branches(name)')
    .single()
  if (error) throw error
  return mapAnnouncement(data)
}

/** Toggle active or edit an existing announcement — manager-only per RLS. */
export async function updateAnnouncement(id, { isActive, title, body, kind, expiresAt } = {}) {
  const patch = {}
  if (isActive !== undefined) patch.is_active = isActive
  if (title !== undefined) patch.title = String(title || '').trim()
  if (body !== undefined) patch.body = String(body || '').trim()
  if (kind !== undefined) patch.kind = kind
  if (expiresAt !== undefined) patch.expires_at = expiresAt
  const { data, error } = await supabase
    .from('announcements')
    .update(patch)
    .eq('id', id)
    .select('id, branch_id, author_id, kind, title, body, is_active, expires_at, created_at, staff:author_id(full_name), branches(name)')
    .single()
  if (error) throw error
  return mapAnnouncement(data)
}

/**
 * Bumps the signed-in staff's "seen" watermark and returns what it was BEFORE this call —
 * callers compare each announcement's createdAt against that previous value to flag "posted
 * since your last visit" for this load, before the watermark moves for next time.
 */
export async function markAnnouncementsSeen() {
  if (!supabase) return null
  const { data, error } = await supabase.rpc('mark_announcements_seen')
  if (error) throw error
  return data || null
}
