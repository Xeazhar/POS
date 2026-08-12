-- Offline supervisor PIN verification + idempotent audit sync.
-- Apply after migrate_pin_security_hardening.sql and migrate_manager_can_approve_any_branch.sql.
--
-- Client stores PBKDF2 verifiers (see src/utils/unlockVerifier.js) — never plaintext PINs.
-- Verifiers are uploaded when staff PINs are created/updated and fetched on branch sync.

alter table public.staff
  add column if not exists pin_verifier jsonb;

comment on column public.staff.pin_verifier is
  'PBKDF2 verifier bundle for offline supervisor PIN checks (v2 unlockVerifier shape). Never plaintext.';

-- Upload/replace verifier after PIN change (manager/admin only).
create or replace function public.save_staff_pin_verifier(
  p_staff_id uuid,
  p_verifier jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_staff_id is null or p_verifier is null then
    raise exception 'Staff id and verifier required';
  end if;
  if not public.is_manager() then
    raise exception 'Not authorized';
  end if;
  update public.staff
  set pin_verifier = p_verifier
  where id = p_staff_id;
  if not found then
    raise exception 'Staff not found';
  end if;
end;
$$;

grant execute on function public.save_staff_pin_verifier(uuid, jsonb) to authenticated;

-- Branch supervisors + network managers/admins for offline till approvals.
create or replace function public.fetch_branch_supervisor_verifiers(p_branch_id uuid)
returns table (
  staff_id uuid,
  login_code text,
  full_name text,
  role text,
  branch_id uuid,
  pin_verifier jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_branch_id is null then
    raise exception 'Branch required';
  end if;

  return query
  select s.id, s.login_code, s.full_name, s.role, s.branch_id, s.pin_verifier
  from public.staff s
  where s.is_active
    and s.login_code is not null
    and s.pin_verifier is not null
    and (
      (s.branch_id = p_branch_id and s.role = 'supervisor')
      or s.role in ('manager', 'admin', 'master')
    )
  order by s.role, s.full_name;
end;
$$;

grant execute on function public.fetch_branch_supervisor_verifiers(uuid) to authenticated;

-- Idempotent audit insert for offline-synced approval records.
create or replace function public.log_audit_event_idempotent(
  p_branch_id uuid,
  p_staff_id uuid,
  p_event_type text,
  p_detail text default null,
  p_meta jsonb default '{}'::jsonb,
  p_client_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_meta jsonb;
begin
  if p_client_id is not null and length(trim(p_client_id)) > 0 then
    select ae.id into v_id
    from public.audit_events ae
    where ae.meta->>'offline_client_id' = trim(p_client_id)
    limit 1;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  v_meta := coalesce(p_meta, '{}'::jsonb);
  if p_client_id is not null and length(trim(p_client_id)) > 0 then
    v_meta := v_meta || jsonb_build_object('offline_client_id', trim(p_client_id));
  end if;

  insert into public.audit_events (branch_id, staff_id, event_type, detail, meta)
  values (p_branch_id, p_staff_id, p_event_type, p_detail, v_meta)
  returning id into v_id;
  return v_id;
end;
$$;

grant execute on function public.log_audit_event_idempotent(uuid, uuid, text, text, jsonb, text) to authenticated;

create index if not exists idx_audit_events_offline_client_id
  on public.audit_events ((meta->>'offline_client_id'))
  where (meta->>'offline_client_id') is not null;

notify pgrst, 'reload schema';
