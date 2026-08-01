import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

/** Open demo (no Supabase) is allowed only in local dev, or when explicitly opted in. */
export const allowDemoMode =
  Boolean(import.meta.env.DEV) || import.meta.env.VITE_ALLOW_DEMO === 'true'

export const isConfigured = Boolean(supabaseUrl && supabaseKey)

export const supabase = isConfigured ? createClient(supabaseUrl, supabaseKey) : null
