// Supabase Edge Function: verify hCaptcha before login.
//
// Deploy (JWT must be OFF — login happens before auth):
//   npx supabase functions deploy verify-hcaptcha --no-verify-jwt --project-ref YOUR_REF
// Or in Dashboard → Edge Functions → verify-hcaptcha → Disable "Verify JWT"
//
// Secret:
//   supabase secrets set HCAPTCHA_SECRET=your_secret_key

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const secret = Deno.env.get('HCAPTCHA_SECRET')
    if (!secret) {
      return new Response(JSON.stringify({ ok: false, error: 'HCAPTCHA_SECRET not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const payload = await req.json().catch(() => ({}))
    const token = typeof payload?.token === 'string' ? payload.token : typeof payload?.response === 'string' ? payload.response : ''
    if (!token) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing captcha token' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body = new URLSearchParams()
    body.set('secret', secret)
    body.set('response', token)

    const verifyRes = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const result = await verifyRes.json()

    if (!result?.success) {
      const codes = result?.['error-codes'] || []
      return new Response(
        JSON.stringify({
          ok: false,
          error: codes.length ? codes.join(', ') : 'Captcha verification failed',
          codes,
        }),
        {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      )
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'Verify failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
