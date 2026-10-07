-- Tito Circle, 0002: pre-launch hardening.
--
-- Three pieces of server-side state that must survive across serverless
-- instances and crashes, so they live in Postgres rather than in memory:
--
--   1. rate_limits             fixed-window counters for sign-in, OTP and
--                              TOTP attempts, shared by every instance
--   2. products.plan_claimed_at a claim token so only one request at a time
--                              can create a product's Paystack plan
--   3. notification_deliveries one row per (pick, member, channel, device):
--                              the pick-alert queue, retried until sent
--
-- Everything here is service_role only, apart from a staff (aal2) read of
-- the queue for the admin overview. Same grant discipline as 0001: revoked
-- from public, anon and authenticated explicitly, then granted back.

-- ---------------------------------------------------------------------------
-- 1. Rate limiting
-- ---------------------------------------------------------------------------
-- Keys never hold raw personal data: the app hashes emails and IPs before
-- using them in a key (see src/lib/rate-limit.ts).
create table public.rate_limits (
  key          text primary key check (char_length(key) <= 200),
  window_start timestamptz not null,
  hits         integer not null
);

create index rate_limits_window_idx on public.rate_limits (window_start);

-- Counts one attempt against `p_key` and says whether it is allowed: at most
-- p_limit attempts per p_window_seconds (fixed window). Atomic under
-- concurrency: the upsert takes the row lock, so two simultaneous attempts
-- cannot both read the same count.
create function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_hits integer;
begin
  -- Windows are capped at a day because housekeeping clears day-old rows.
  if p_limit < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'Invalid rate limit' using errcode = '22023';
  end if;

  insert into public.rate_limits as r (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update
    set hits = case
                 when r.window_start <= now() - make_interval(secs => p_window_seconds) then 1
                 else r.hits + 1
               end,
        window_start = case
                 when r.window_start <= now() - make_interval(secs => p_window_seconds) then now()
                 else r.window_start
               end
  returning hits into current_hits;

  -- Housekeeping: roughly one call in a hundred clears windows older than a
  -- day, so the table stays small without a scheduled job.
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;

  return current_hits <= p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Paystack plan creation claim
-- ---------------------------------------------------------------------------
alter table public.products add column plan_claimed_at timestamptz;

-- Claims the right to create this product's Paystack plan and returns the
-- claim token (the claim time), or null if the product already has a plan
-- or another request holds a live claim. Claims last ten minutes; the app
-- times out every Paystack call well inside that, so a live request never
-- outlasts its claim. A claim older than that was abandoned by a crash.
create function public.claim_plan_creation(p_product_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  token timestamptz := clock_timestamp();
begin
  update public.products
     set plan_claimed_at = token
   where id = p_product_id
     and paystack_plan_code is null
     and (plan_claimed_at is null or plan_claimed_at < now() - interval '10 minutes');
  return case when found then token else null end;
end;
$$;

-- Records the plan and returns the product's plan code afterwards.
--   - A plan code is only ever filled in, never replaced: if another request
--     got there first, its code wins and is returned.
--   - Filling it does not need a live claim: the plan was created for this
--     product (it is tagged with its id), so saving it can only help.
--   - The claim is cleared only if it is still this caller's.
create function public.finish_plan_creation(p_product_id uuid, p_plan_code text, p_claim timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  winner text;
begin
  update public.products
     set paystack_plan_code = coalesce(paystack_plan_code, p_plan_code),
         plan_claimed_at = case when plan_claimed_at = p_claim then null else plan_claimed_at end
   where id = p_product_id
  returning paystack_plan_code into winner;
  return winner;
end;
$$;

-- Releases a claim, but only the caller's own: a late release must never
-- clear a newer claim taken after this one expired.
create function public.release_plan_claim(p_product_id uuid, p_claim timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.products set plan_claimed_at = null
   where id = p_product_id and plan_claimed_at = p_claim;
$$;

-- ---------------------------------------------------------------------------
-- 3. Pick-alert delivery queue
-- ---------------------------------------------------------------------------
-- One row per message to send. A send is "done" only when its row says
-- sent, so a crash at any point leaves the unsent rows to be picked up again.
-- Delivery is at-least-once: a crash between a send and its record re-sends
-- that one message. Email is protected from that by Resend idempotency keys
-- (the row id); a repeated push replaces the previous one on the device.
--
--   pending  -> waiting (next_attempt_at says when)
--   sending  -> claimed by a worker until locked_until; if the worker dies,
--               the lock lapses and the row is claimed again
--   sent     -> delivered
--   failed   -> gave up after max attempts, or a permanent error
--   skipped  -> the member lost access, or the pick was removed, before sending
create table public.notification_deliveries (
  id                   uuid primary key default gen_random_uuid(),
  pick_id              uuid not null references public.picks (id) on delete restrict,
  user_id              uuid not null references auth.users (id) on delete cascade,
  channel              text not null check (channel in ('push', 'email')),
  -- Push rows target one device. If the device's subscription is removed
  -- (the browser dropped it, or another member signed in on that device),
  -- its pending row goes with it.
  push_subscription_id uuid references public.push_subscriptions (id) on delete cascade,
  status               text not null default 'pending'
                         check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts             integer not null default 0,
  next_attempt_at      timestamptz not null default now(),
  locked_until         timestamptz,
  last_error           text check (char_length(last_error) <= 500),
  sent_at              timestamptz,
  created_at           timestamptz not null default now(),
  check ((channel = 'push') = (push_subscription_id is not null)),
  -- Enqueueing the same pick twice is a no-op. (Its leading column also
  -- serves lookups by pick.)
  unique nulls not distinct (pick_id, user_id, channel, push_subscription_id)
);

-- The claim query: open rows in creation order.
create index notification_deliveries_open_idx
  on public.notification_deliveries (created_at)
  where status in ('pending', 'sending');
create index notification_deliveries_user_idx on public.notification_deliveries (user_id);
create index notification_deliveries_push_idx on public.notification_deliveries (push_subscription_id)
  where push_subscription_id is not null;

-- Queues a pick's alerts: one email per member with access now, and one push
-- per device those members registered. Idempotent. Returns rows added.
create function public.enqueue_pick_notifications(p_pick_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  added integer := 0;
  n integer;
begin
  if not exists (
    select 1 from public.picks p
     where p.id = p_pick_id and p.deleted_at is null and p.published_at <= now()
  ) then
    return 0;
  end if;

  insert into public.notification_deliveries (pick_id, user_id, channel)
  select p_pick_id, r.user_id, 'email' from public.active_member_recipients() r
  on conflict do nothing;
  get diagnostics n = row_count;
  added := added + n;

  insert into public.notification_deliveries (pick_id, user_id, channel, push_subscription_id)
  select p_pick_id, r.user_id, 'push', s.id
    from public.active_member_recipients() r
    join public.push_subscriptions s on s.user_id = r.user_id
  on conflict do nothing;
  get diagnostics n = row_count;
  added := added + n;

  -- notified_at now means "alerts queued". Set once.
  update public.picks set notified_at = now() where id = p_pick_id and notified_at is null;
  return added;
end;
$$;

-- Hands a worker up to p_limit due deliveries, locked for p_lock_seconds.
-- Every step selects its rows with FOR UPDATE SKIP LOCKED from a
-- MATERIALIZED CTE, so concurrent workers (the post-publish drain, the cron,
-- a manual retry) never wait on each other, never deadlock, and never take
-- more than they asked for.
--
-- Before claiming, due rows whose member no longer has access, or whose pick
-- was removed, are marked skipped: eligibility is re-checked at send time.
-- Abandoned rows that are out of attempts are marked failed.
create function public.claim_notification_batch(p_limit integer, p_lock_seconds integer, p_max_attempts integer)
returns table (
  id uuid,
  pick_id uuid,
  user_id uuid,
  channel text,
  push_subscription_id uuid,
  attempts integer,
  email text,
  endpoint text,
  p256dh text,
  auth text
)
language plpgsql
security definer
set search_path = ''
as $$
-- The output columns share names with table columns; always mean the table's.
#variable_conflict use_column
begin
  with eligible as materialized (
    select r.user_id from public.active_member_recipients() r
  ), stale as materialized (
    select d.id
      from public.notification_deliveries d
     where ((d.status = 'pending' and d.next_attempt_at <= now())
            or (d.status = 'sending' and d.locked_until < now()))
       and (
         not exists (select 1 from eligible e where e.user_id = d.user_id)
         or not exists (select 1 from public.picks p where p.id = d.pick_id and p.deleted_at is null)
       )
     order by d.created_at
     limit p_limit * 4
     for update skip locked
  )
  update public.notification_deliveries d
     set status = 'skipped', locked_until = null, last_error = 'No longer eligible when sent'
    from stale where d.id = stale.id;

  with spent as materialized (
    select d.id
      from public.notification_deliveries d
     where d.status = 'sending' and d.locked_until < now() and d.attempts >= p_max_attempts
     order by d.created_at
     limit p_limit * 4
     for update skip locked
  )
  update public.notification_deliveries d
     set status = 'failed', locked_until = null,
         last_error = coalesce(d.last_error, 'Gave up') || ' (after ' || d.attempts || ' attempts)'
    from spent where d.id = spent.id;

  return query
  with due as materialized (
    select d.id
      from public.notification_deliveries d
     where (d.status = 'pending' and d.next_attempt_at <= now())
        or (d.status = 'sending' and d.locked_until < now())
     order by d.created_at
     limit p_limit
     for update skip locked
  ), claimed as (
    update public.notification_deliveries d
       set status = 'sending',
           attempts = d.attempts + 1,
           locked_until = now() + make_interval(secs => p_lock_seconds)
      from due
     where d.id = due.id
    returning d.id, d.pick_id, d.user_id, d.channel, d.push_subscription_id, d.attempts
  )
  -- Left join: a row is always handed back, even if its profile is missing,
  -- so the worker can record that instead of the row going quiet.
  select c.id, c.pick_id, c.user_id, c.channel, c.push_subscription_id, c.attempts,
         pr.email, s.endpoint, s.p256dh, s.auth
    from claimed c
    left join public.profiles pr on pr.user_id = c.user_id
    left join public.push_subscriptions s on s.id = c.push_subscription_id;
end;
$$;

-- Records the outcome of one send. p_attempts is the attempt number the
-- worker was handed: it is the claim token. A worker whose lock lapsed, and
-- whose row was reclaimed since, changes nothing.
--
-- A transient failure goes back to pending with exponential backoff (1, 2,
-- 4 … minutes, capped at an hour), or after p_retry_after_seconds when the
-- provider says when (a daily email quota, for instance). A permanent one,
-- or one out of attempts, becomes failed.
create function public.complete_notification(
  p_id uuid,
  p_attempts integer,
  p_ok boolean,
  p_error text,
  p_permanent boolean,
  p_max_attempts integer,
  p_retry_after_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_ok then
    update public.notification_deliveries
       set status = 'sent', sent_at = now(), locked_until = null, last_error = null
     where id = p_id and status = 'sending' and attempts = p_attempts;
    return found;
  end if;

  update public.notification_deliveries d
     set status = case when p_permanent or d.attempts >= p_max_attempts then 'failed' else 'pending' end,
         locked_until = null,
         last_error = left(p_error, 500),
         next_attempt_at = now() + coalesce(
           make_interval(secs => p_retry_after_seconds),
           least(interval '1 hour', make_interval(mins => power(2, least(greatest(d.attempts - 1, 0), 6))::integer))
         )
   where d.id = p_id and d.status = 'sending' and d.attempts = p_attempts;
  return found;
end;
$$;

-- Deletes push registrations of members who have had no access for 30 days.
-- In SQL so it scales: no member list ever leaves the database.
create function public.purge_lapsed_push_subscriptions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  delete from public.push_subscriptions s
   where s.created_at < now() - interval '30 days'
     and not exists (select 1 from public.active_member_recipients() r where r.user_id = s.user_id);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Bookkeeping columns (claim tokens, the alerts-queued stamp) change often
-- and mean nothing to a human reader of the audit log. Updates that touch
-- only those are no longer audited; every other change still is.
create or replace function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'UPDATE'
     and (to_jsonb(new) - 'plan_claimed_at' - 'notified_at') = (to_jsonb(old) - 'plan_claimed_at' - 'notified_at') then
    return new;
  end if;

  insert into public.audit_log (actor_id, action, target_type, target_id, detail)
  values (
    (select auth.uid()),
    lower(TG_OP),
    TG_TABLE_NAME,
    (to_jsonb(new) ->> 'id'),
    case when TG_OP = 'UPDATE'
         then jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new))
         else to_jsonb(new) end
  );
  return new;
end;
$$;

-- Picks published before this migration are not re-announced: only picks
-- with no "queued" stamp are ever enqueued by the safety net, so stamp them.
update public.picks set notified_at = coalesce(notified_at, published_at) where notified_at is null;

-- ---------------------------------------------------------------------------
-- 4. Grants and RLS
-- ---------------------------------------------------------------------------
revoke all on function public.rate_limit_hit(text, integer, integer)                                       from public, anon, authenticated;
revoke all on function public.claim_plan_creation(uuid)                                                    from public, anon, authenticated;
revoke all on function public.finish_plan_creation(uuid, text, timestamptz)                                from public, anon, authenticated;
revoke all on function public.release_plan_claim(uuid, timestamptz)                                        from public, anon, authenticated;
revoke all on function public.enqueue_pick_notifications(uuid)                                             from public, anon, authenticated;
revoke all on function public.claim_notification_batch(integer, integer, integer)                          from public, anon, authenticated;
revoke all on function public.complete_notification(uuid, integer, boolean, text, boolean, integer, integer) from public, anon, authenticated;
revoke all on function public.purge_lapsed_push_subscriptions()                                            from public, anon, authenticated;
revoke all on function public.audit_row()                                                                  from public, anon, authenticated;

grant execute on function public.rate_limit_hit(text, integer, integer)                                       to service_role;
grant execute on function public.claim_plan_creation(uuid)                                                    to service_role;
grant execute on function public.finish_plan_creation(uuid, text, timestamptz)                                to service_role;
grant execute on function public.release_plan_claim(uuid, timestamptz)                                        to service_role;
grant execute on function public.enqueue_pick_notifications(uuid)                                             to service_role;
grant execute on function public.claim_notification_batch(integer, integer, integer)                          to service_role;
grant execute on function public.complete_notification(uuid, integer, boolean, text, boolean, integer, integer) to service_role;
grant execute on function public.purge_lapsed_push_subscriptions()                                            to service_role;

revoke all on public.rate_limits, public.notification_deliveries from anon;
revoke all on public.rate_limits from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.notification_deliveries from authenticated;

alter table public.rate_limits             enable row level security;
alter table public.notification_deliveries enable row level security;

-- rate_limits: no policy at all. Service role only.

create policy "staff read the alert queue"
  on public.notification_deliveries for select to authenticated
  using ((select public.is_staff_aal2()));

-- ---------------------------------------------------------------------------
-- 5. Verification (scripts/test-db.ts runs these against a local replay)
-- ---------------------------------------------------------------------------
-- -- Nothing new is executable by anon. Expect zero rows.
-- select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
