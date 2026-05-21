-- Atomic subscription extension — eliminates the read-then-write race condition
-- in extendSubscription() where two concurrent payments can overwrite each other.
--
-- Run once in the Supabase SQL editor, then update extendSubscription() in bot.ts
-- to call: supabase.rpc('extend_subscription', { p_telegram_id: ..., p_days: ... })
--
-- The function uses GREATEST(now(), coalesce(subscription_end, now())) so the
-- extension always stacks correctly regardless of the current subscription state.

create or replace function extend_subscription(p_telegram_id bigint, p_days int)
returns timestamptz
language plpgsql
as $$
declare
  v_new_end timestamptz;
begin
  update users
  set
    subscription_status = 'active',
    subscription_end = greatest(now(), coalesce(subscription_end, now()))
                       + (p_days || ' days')::interval
  where telegram_id = p_telegram_id
  returning subscription_end into v_new_end;

  if not found then
    raise exception 'user_not_found: %', p_telegram_id;
  end if;

  return v_new_end;
end;
$$;
