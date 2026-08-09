# CalePOS (frontend)

React + Vite application for **CalePOS**.

**Author:** Jazper Bustria  
**License:** Proprietary — see [`../LICENSE`](../LICENSE). All rights reserved.

For setup, deploy, and security guidance, use the root [`README.md`](../README.md).  
For “where is the code for X?”, see [`docs/CODEMAP.md`](./docs/CODEMAP.md).

```bash
npm install
cp .env.example .env.local   # then point it at the DEV Supabase project — see below
npm run dev
```

---

## Environments: never develop against production

**Local development and the deployed app must point at different Supabase projects.**

The production database holds real fiscal records. Sales rows are immutable and OR numbers
are allocated sequentially for BIR reasons, so a test sale rung up from a laptop against
production **consumes a real OR number and cannot be deleted afterwards**. It is not a mess
you can clean up later; it is a gap in a numbered sequence an auditor can see.

### The three tiers

| Tier | Supabase project | Configured in | Rules |
|---|---|---|---|
| **development** | `calepos-dev` | `.env.local` on each machine | Freely resettable. Wipe and reseed whenever. |
| **staging** | `calepos-staging` | hosting dashboard (preview/branch env vars) | Mirrors the production schema. Rehearse releases and **test migrations here first**. |
| **production** | `calepos` (live) | hosting dashboard (production env vars) | Append-only, BIR-critical. Never wiped, never recreated, never pointed at from a laptop. |

Dev and production are the minimum split. Staging is worth adding as soon as migrations
start touching cash or fiscal tables — this app has several that rewrite SQL functions, and
you do not want production to be where you find out one was wrong.

### Setting it up

1. In Supabase, create a second project, e.g. `calepos-dev`.
2. Apply `supabase/schema.sql`, then the `migrate_*.sql` files in the order their comments
   describe, to the new project.
3. Copy `.env.example` to `.env.local` and fill in the **dev** project's URL and
   publishable key. Leave `VITE_APP_ENV=development`.
4. In the hosting dashboard (Cloudflare Pages → Settings → Environment variables), confirm
   the deployed app's variables still point at the **production** project and set
   `VITE_APP_ENV=production` there.
5. Turnstile is per-project: each Supabase project needs its own secret under
   Authentication → Bot and Abuse Protection, and each deploy needs the matching
   `VITE_TURNSTILE_SITEKEY`.

### How you can tell which one you are on

Any build where `VITE_APP_ENV` is not `production` shows a permanent badge on the login
screen and in the top bar, reading e.g. `DEVELOPMENT · calepos-dev`. The second half is the
Supabase project ref parsed from `VITE_SUPABASE_URL` — the tier label can be wrong if a
`.env` was copied between machines, but the ref is the database actually being written to.

An **unset** `VITE_APP_ENV` is treated as `development`, not production. The dangerous case
must never be the quiet default.

> Only ever the publishable / anon key in these files. The Supabase **service role** key
> must never appear in frontend code or in any hosting env var for this app — access control
> is RLS, not key secrecy.
