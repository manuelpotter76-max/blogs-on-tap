-- Immediate cancellation: unused credits in open cycles expire and the cycles
-- close, so nothing shows as owed and no rollover happens. Reserved credits for
-- jobs already in progress are left alone (those jobs settle normally).
create or replace function app.expire_open_cycles(p_subscription_id uuid, p_reason text)
returns integer language plpgsql set search_path = '' as $$
declare
  c record;
  v_expired integer := 0;
begin
  for c in
    select b.cycle_id, b.org_id, b.available
      from app.cycle_balances b
     where b.subscription_id = p_subscription_id and b.status = 'open'
  loop
    perform 1 from app.entitlement_cycles where id = c.cycle_id for update;
    if c.available > 0 then
      insert into app.entitlement_ledger (org_id, cycle_id, kind, delta, reason)
      values (c.org_id, c.cycle_id, 'expire', -c.available, p_reason)
      on conflict do nothing;
      v_expired := v_expired + c.available;
    end if;
    update app.entitlement_cycles set status = 'closed' where id = c.cycle_id;
  end loop;
  return v_expired;
end $$;

revoke execute on function app.expire_open_cycles(uuid, text) from public;
