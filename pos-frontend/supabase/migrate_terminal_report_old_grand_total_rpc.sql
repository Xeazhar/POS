-- fetchTerminalReportSource() (api.js) computed the Terminal/X/Z report's "Old Grand
-- Total" — lifetime completed sales before the report's start date — by pulling
-- total_amount/refunded_amount for EVERY completed transaction a branch has ever rung, on
-- every single report generation. That grows unbounded with branch age (tens of thousands
-- of rows on an old, busy branch) and is a real timeout/slow-connection risk for a number
-- that's just a SUM. Replaced with a server-side aggregate RPC — same access rule as
-- shift_cash_summary (schema.sql): manager sees any branch, supervisor/cashier only their
-- own, fails closed (returns 0 rows, not an error) otherwise.
--
-- api.js's fetchTerminalReportSource() calls this first and falls back to the old
-- row-pulling query only if the function is missing (isMissingFunctionError), so this is
-- safe to apply after the fact with no app-side coordination required.

create or replace function public.sum_completed_sales_before(p_branch_id uuid, p_before timestamptz)
returns numeric
language sql
stable security definer
set search_path to 'public'
as $function$
  select coalesce(sum(total_amount - coalesce(refunded_amount, 0)), 0)
  from public.transactions
  where status = 'completed'
    and created_at < p_before
    and (p_branch_id is null or branch_id = p_branch_id)
    and (
      public.is_manager()
      or (p_branch_id is not null and p_branch_id = public.current_staff_branch())
    )
$function$;

grant execute on function public.sum_completed_sales_before(uuid, timestamptz) to authenticated;

notify pgrst, 'reload schema';
