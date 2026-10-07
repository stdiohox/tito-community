-- Tito Circle, schema, access rules and payment ledger.
--
-- THE ONE RULE THIS FILE EXISTS TO ENFORCE
-- A member can read paid content only while
--     entitlements.access_ends_at + settings.grace_days > now()
-- and that comparison runs inside Postgres on every read, through RLS. Nothing
-- "removes" an expired member: the next query simply returns no rows. No cron
-- has to run, no flag has to flip, and no JWT claim can keep someone in.
--
-- WHO WRITES WHAT
--   members         read their own rows; accept the disclaimer; manage their
--                   own push subscriptions. Nothing else.
--   staff (aal2)    post picks, updates, announcements and products through
--                   RLS, and manage members through the security definer
--                   functions below. Every staff write requires a session
--                   that has passed TOTP (aal2).
--   service_role    the Paystack webhook (record_payment), member invites,
--                   and notification fan-out. Server-only key.
--
-- FUNCTION GRANTS
-- Supabase's default privileges grant EXECUTE on new functions to anon and
-- authenticated directly, so `revoke ... from public` alone does nothing.
-- Every function here is revoked from public, anon AND authenticated, then
-- granted back to exactly the role that needs it. Section 10 verifies it.

-- ---------------------------------------------------------------------------
-- 0. Defaults
-- ---------------------------------------------------------------------------
-- Removes Supabase's schema-level EXECUTE grants to anon and authenticated
-- for functions created later. It does NOT remove PUBLIC's global default
-- (Postgres does not let IN SCHEMA revoke a global grant), which is why every
-- function below is still revoked explicitly. scripts/test-db.ts proves that
-- dropping one explicit revoke re-opens that function to anon.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Settings (singleton)
-- ---------------------------------------------------------------------------
create table public.settings (
  -- A boolean primary key that must be true admits exactly one row.
  id                 boolean primary key default true check (id),
  grace_days         integer not null default 3 check (grace_days between 0 and 30),
  disclaimer_version integer not null default 1 check (disclaimer_version > 0),
  updated_at         timestamptz not null default now()
);

insert into public.settings default values;

-- ---------------------------------------------------------------------------
-- 2. People
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  email                  text not null unique check (email = lower(email)),
  full_name              text check (char_length(full_name) <= 120),
  -- Set from a verified Paystack transaction. It is how a recurring
  -- subscription charge, which carries no metadata of ours, finds its member.
  paystack_customer_code text unique,
  created_at             timestamptz not null default now()
);

-- Every auth user gets a profile. Nothing is read from user metadata: users
-- can edit their own metadata, so it is never a source of truth for anything.
create function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, lower(new.email))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Notifications go to profiles.email, so it follows a confirmed email change.
create function public.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = lower(new.email) where user_id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (new.email is distinct from old.email and new.email is not null)
  execute function public.sync_profile_email();

-- Roles live here and only the service role writes this table. A role is
-- never derived from anything the user can set. There is one role, admin:
-- every staff member can manage members, so there is no lesser tier that
-- could quietly do more than intended.
create table public.staff (
  user_id             uuid primary key references auth.users (id) on delete cascade,
  role                text not null default 'admin' check (role = 'admin'),
  -- Staff sign in by email code, so a hijacked mailbox could otherwise enrol
  -- its own authenticator and reach aal2. Enrolment is only possible while
  -- this is true; it is set by the service role (the seed script, or SQL for
  -- a lost phone) and closed by the app the moment a factor is verified.
  mfa_enrollment_open boolean not null default false,
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. Products and access
-- ---------------------------------------------------------------------------
create table public.products (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (char_length(name) between 2 and 80),
  description        text check (char_length(description) <= 500),
  -- Kobo. Paystack's minimum NGN charge is well above 100 kobo; 10,000 kobo
  -- (NGN 100) is a floor against typos, not a business rule.
  price_kobo         bigint not null check (price_kobo >= 10000),
  currency           text not null default 'NGN' check (currency = 'NGN'),
  -- Months, and only lengths Paystack plans can bill on, so every product can
  -- offer auto-renew: 1 monthly, 3 quarterly, 6 biannually, 12 annually.
  access_months      integer not null check (access_months in (1, 3, 6, 12)),
  paystack_plan_code text unique,
  active             boolean not null default true,
  created_by         uuid references auth.users (id) on delete set null default auth.uid(),
  created_at         timestamptz not null default now()
);

create table public.entitlements (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  -- NULL means no access. Open-ended access does not exist; it is granted as
  -- an explicit date so it is always visible.
  access_ends_at timestamptz,
  status         text not null default 'active' check (status in ('active', 'revoked')),
  status_reason  text check (char_length(status_reason) <= 300),
  updated_at     timestamptz not null default now()
);

create index entitlements_active_ends_idx
  on public.entitlements (access_ends_at) where status = 'active';

-- ---------------------------------------------------------------------------
-- 4. Payments
-- ---------------------------------------------------------------------------
-- Written by the server when it initialises a checkout. The webhook trusts
-- this row, never the transaction's metadata: Paystack's public key can start
-- a transaction with any metadata at all.
create table public.checkout_intents (
  reference   text primary key check (char_length(reference) between 8 and 100),
  user_id     uuid not null references auth.users (id) on delete cascade,
  product_id  uuid not null references public.products (id) on delete restrict,
  kind        text not null check (kind in ('one_off', 'subscription')),
  amount_kobo bigint not null check (amount_kobo > 0),
  plan_code   text,
  created_at  timestamptz not null default now(),
  consumed_at timestamptz,
  check (kind = 'one_off' or plan_code is not null)
);

create table public.payments (
  id             uuid primary key default gen_random_uuid(),
  -- Paystack's transaction reference. Unique, and the insert that claims it is
  -- the idempotency lock: a replayed webhook stops here.
  reference      text not null unique,
  user_id        uuid not null references auth.users (id) on delete restrict,
  product_id     uuid not null references public.products (id) on delete restrict,
  kind           text not null check (kind in ('one_off', 'subscription', 'renewal')),
  amount_kobo    bigint not null check (amount_kobo > 0),
  currency       text not null check (currency = 'NGN'),
  paid_at        timestamptz not null,
  -- The term this payment bought, after stacking on any time already held.
  term_starts_at timestamptz not null,
  term_ends_at   timestamptz not null,
  created_at     timestamptz not null default now(),
  check (term_ends_at > term_starts_at)
);

create index payments_user_idx on public.payments (user_id, paid_at desc);

create table public.subscriptions (
  subscription_code text primary key,
  user_id           uuid not null references auth.users (id) on delete cascade,
  product_id        uuid references public.products (id) on delete set null,
  status            text not null,
  next_payment_date timestamptz,
  updated_at        timestamptz not null default now()
);

create index subscriptions_user_idx on public.subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- 5. Disclaimer
-- ---------------------------------------------------------------------------
create table public.disclaimer_acceptances (
  user_id     uuid not null references auth.users (id) on delete cascade,
  version     integer not null,
  accepted_at timestamptz not null default now(),
  user_agent  text check (char_length(user_agent) <= 400),
  primary key (user_id, version)
);

-- ---------------------------------------------------------------------------
-- 6. Content
-- ---------------------------------------------------------------------------
create table public.picks (
  id           uuid primary key default gen_random_uuid(),
  ticker       text not null check (ticker ~ '^[A-Z0-9.\-]{1,15}$'),
  market       text not null check (market in ('NGX', 'US', 'OTHER')),
  action       text not null check (action in ('buy', 'sell', 'hold', 'trim')),
  entry_price  numeric(14, 4) not null check (entry_price > 0),
  target_price numeric(14, 4) not null check (target_price > 0),
  stop_price   numeric(14, 4) not null check (stop_price > 0),
  rationale    text not null check (char_length(rationale) between 20 and 4000),
  -- Conflict disclosure, shown on the pick. The disclaimer promises it.
  author_holds boolean not null default false,
  chart_path   text check (chart_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp)$'),
  author_id    uuid not null references auth.users (id) on delete restrict default auth.uid(),
  published_at timestamptz not null default now(),
  deleted_at   timestamptz,
  notified_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index picks_feed_idx on public.picks (published_at desc) where deleted_at is null;
-- The chart storage policy looks a chart up by its pick.
create index picks_chart_idx on public.picks (chart_path) where chart_path is not null;
create index picks_author_idx on public.picks (author_id);

create table public.pick_updates (
  id           uuid primary key default gen_random_uuid(),
  pick_id      uuid not null references public.picks (id) on delete restrict,
  kind         text not null check (kind in ('note', 'target_hit', 'stop_hit', 'closed', 'revised')),
  body         text not null check (char_length(body) between 2 and 2000),
  author_id    uuid not null references auth.users (id) on delete restrict default auth.uid(),
  published_at timestamptz not null default now(),
  deleted_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index pick_updates_pick_idx on public.pick_updates (pick_id, published_at);

create table public.announcements (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (char_length(title) between 2 and 140),
  body         text not null check (char_length(body) between 2 and 4000),
  pinned       boolean not null default false,
  author_id    uuid not null references auth.users (id) on delete restrict default auth.uid(),
  published_at timestamptz not null default now(),
  deleted_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index announcements_feed_idx on public.announcements (pinned desc, published_at desc)
  where deleted_at is null;

create table public.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade default auth.uid(),
  -- The server POSTs to every stored endpoint, so only real browser push
  -- services are accepted. Anything else would let a member point the server
  -- at an arbitrary (or internal) URL on every new pick.
  endpoint        text not null unique check (endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/'),
  p256dh          text not null,
  auth            text not null,
  created_at      timestamptz not null default now(),
  last_success_at timestamptz
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- Foreign-key indexes for the restrict/cascade checks.
create index checkout_intents_user_idx on public.checkout_intents (user_id);
create index payments_product_idx on public.payments (product_id);
create index subscriptions_product_idx on public.subscriptions (product_id);
create index pick_updates_author_idx on public.pick_updates (author_id);
create index announcements_author_idx on public.announcements (author_id);

-- Insert-only. No update or delete policy for anyone, and the table grants
-- below remove UPDATE and DELETE from every client role.
create table public.audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  action      text not null,
  target_type text not null,
  target_id   text,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index audit_log_created_idx on public.audit_log (created_at desc);

-- ---------------------------------------------------------------------------
-- 7. Functions
-- ---------------------------------------------------------------------------
create function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.staff s where s.user_id = (select auth.uid()));
$$;

-- Staff who have passed TOTP in this session. Every content write and every
-- member-management action requires it: a hijacked staff password alone must
-- not be enough to publish a pick to every paying member.
create function public.is_staff_aal2()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_staff()
     and coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2';
$$;

-- No argument: it answers only for the caller, so it cannot be used to probe
-- another member's subscription status. Access also requires acceptance of
-- the CURRENT disclaimer, so the disclaimer gate is enforced by the database,
-- not only by the app's redirect.
create function public.has_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.entitlements e
     cross join public.settings s
     where e.user_id = (select auth.uid())
       and e.status = 'active'
       and e.access_ends_at is not null
       and e.access_ends_at + make_interval(days => s.grace_days) > now()
       and exists (
         select 1 from public.disclaimer_acceptances a
          where a.user_id = e.user_id and a.version = s.disclaimer_version
       )
  );
$$;

-- Audit trigger for staff content and product writes. security definer so it
-- can write audit_log, which no client role can.
create function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
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

-- Published content is a record. After publication the only permitted change
-- is a soft delete (and, for picks, the notifier's watermark; for
-- announcements, pinning). Corrections to a pick go in pick_updates, so the
-- call as first made can never be rewritten after the fact.
create function public.guard_published_content()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allowed text[];
  changed text;
begin
  if old.published_at > now() then
    return new;
  end if;

  allowed := case TG_TABLE_NAME
    when 'picks'         then array['deleted_at', 'notified_at']
    when 'announcements' then array['deleted_at', 'pinned']
    else                      array['deleted_at']
  end;

  select string_agg(key, ', ') into changed
    from jsonb_each(to_jsonb(new)) n
   where n.value is distinct from (to_jsonb(old) -> n.key)
     and n.key <> all (allowed);

  if changed is not null then
    raise exception 'Published % cannot be edited (%). Post an update instead.', TG_TABLE_NAME, changed
      using errcode = '42501';
  end if;

  -- A soft delete is one-way.
  if old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at then
    raise exception 'A deleted % cannot be restored or re-dated.', TG_TABLE_NAME
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger picks_guard before update on public.picks
  for each row execute function public.guard_published_content();
create trigger pick_updates_guard before update on public.pick_updates
  for each row execute function public.guard_published_content();
create trigger announcements_guard before update on public.announcements
  for each row execute function public.guard_published_content();

create trigger picks_audit after insert or update on public.picks
  for each row execute function public.audit_row();
create trigger pick_updates_audit after insert or update on public.pick_updates
  for each row execute function public.audit_row();
create trigger announcements_audit after insert or update on public.announcements
  for each row execute function public.audit_row();
create trigger products_audit after insert or update on public.products
  for each row execute function public.audit_row();

-- The record is append-only for everyone, the service role included: picks,
-- updates and notices are soft-deleted, and the audit log and payment ledger
-- are never deleted at all.
create function public.forbid_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows are never deleted.', TG_TABLE_NAME using errcode = '42501';
end;
$$;

create trigger picks_no_delete before delete on public.picks
  for each row execute function public.forbid_delete();
create trigger pick_updates_no_delete before delete on public.pick_updates
  for each row execute function public.forbid_delete();
create trigger announcements_no_delete before delete on public.announcements
  for each row execute function public.forbid_delete();
create trigger audit_log_no_delete before delete on public.audit_log
  for each row execute function public.forbid_delete();
create trigger payments_no_delete before delete on public.payments
  for each row execute function public.forbid_delete();

-- Registers this browser for push for the caller. An endpoint identifies a
-- browser, not a person, so if someone else signed in on this device before,
-- their registration is replaced: alerts follow whoever is signed in now.
-- (A plain insert cannot do this: RLS rightly stops a member deleting another
-- member's row.)
create function public.claim_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values ((select auth.uid()), p_endpoint, left(p_p256dh, 200), left(p_auth, 100));
end;
$$;

-- record_payment: the only path by which money becomes access.
--
-- ATOMIC AND IDEMPOTENT. The entitlement row is locked first, so two charges
-- for the same member (a webhook and the return-page check racing, or two
-- payments seconds apart) serialise. The payment insert then claims the
-- reference; a second call with the same reference inserts nothing and
-- returns 'duplicate' without touching access.
--
-- EARLY RENEWAL STACKS. The new term starts at the later of the payment time
-- and the current end date, so days already paid for are never lost.
create function public.record_payment(
  p_reference   text,
  p_user_id     uuid,
  p_product_id  uuid,
  p_kind        text,
  p_amount_kobo bigint,
  p_currency    text,
  p_paid_at     timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  months     integer;
  ent        public.entitlements;
  new_start  timestamptz;
  new_end    timestamptz;
  payment_id uuid;
  existing   public.payments;
begin
  select p.access_months into months from public.products p where p.id = p_product_id;
  if months is null then
    raise exception 'Unknown product %', p_product_id using errcode = 'P0002';
  end if;
  -- A future payment date would mint access out of nothing.
  if p_paid_at is null or p_paid_at > now() + interval '1 day' then
    raise exception 'Implausible payment time %', p_paid_at using errcode = '22023';
  end if;

  insert into public.entitlements (user_id, access_ends_at)
  values (p_user_id, null)
  on conflict (user_id) do nothing;

  select * into ent from public.entitlements where user_id = p_user_id for update;

  new_start := greatest(p_paid_at, coalesce(ent.access_ends_at, p_paid_at));
  new_end   := new_start + make_interval(months => months);

  insert into public.payments
    (reference, user_id, product_id, kind, amount_kobo, currency, paid_at, term_starts_at, term_ends_at)
  values
    (p_reference, p_user_id, p_product_id, p_kind, p_amount_kobo, p_currency, p_paid_at, new_start, new_end)
  on conflict (reference) do nothing
  returning id into payment_id;

  if payment_id is null then
    select * into existing from public.payments where reference = p_reference;
    return jsonb_build_object(
      'status', 'duplicate',
      'term_ends_at', existing.term_ends_at
    );
  end if;

  -- Status is left alone. A revoked member whose card auto-renews keeps the
  -- paid time on record, but revocation is an admin decision that money does
  -- not silently overturn.
  update public.entitlements
     set access_ends_at = new_end,
         updated_at = now()
   where user_id = p_user_id;

  update public.checkout_intents set consumed_at = now()
   where reference = p_reference and consumed_at is null;

  insert into public.audit_log (actor_id, action, target_type, target_id, detail)
  values (null, 'payment_recorded', 'entitlements', p_user_id::text, jsonb_build_object(
    'reference', p_reference, 'product_id', p_product_id, 'kind', p_kind,
    'amount_kobo', p_amount_kobo, 'term_starts_at', new_start, 'term_ends_at', new_end,
    'previous_ends_at', ent.access_ends_at));

  return jsonb_build_object(
    'status', 'recorded',
    'term_starts_at', new_start,
    'term_ends_at', new_end
  );
end;
$$;

-- Staff member management. Called with the staff member's own session, so the
-- audit row names a real person and RLS-equivalent checks happen in the
-- database, not only in app code.
create function public.admin_extend_access(p_user_id uuid, p_days integer, p_reason text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  ent public.entitlements;
  new_end timestamptz;
begin
  if not public.is_staff_aal2() then
    raise exception 'Staff with two-factor authentication only.' using errcode = '42501';
  end if;
  if p_days is null or p_days < 1 or p_days > 730 then
    raise exception 'Extension must be between 1 and 730 days.' using errcode = '22023';
  end if;

  insert into public.entitlements (user_id, access_ends_at)
  values (p_user_id, null)
  on conflict (user_id) do nothing;

  select * into ent from public.entitlements where user_id = p_user_id for update;

  -- Stacks like a payment: an active member gains days on top of what they
  -- hold; a lapsed one starts from now.
  new_end := greatest(now(), coalesce(ent.access_ends_at, now())) + make_interval(days => p_days);

  update public.entitlements
     set access_ends_at = new_end, updated_at = now()
   where user_id = p_user_id;

  insert into public.audit_log (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'access_extended', 'entitlements', p_user_id::text, jsonb_build_object(
    'days', p_days, 'reason', left(coalesce(p_reason, ''), 300),
    'previous_ends_at', ent.access_ends_at, 'new_ends_at', new_end));

  return new_end;
end;
$$;

create function public.admin_set_access_status(p_user_id uuid, p_status text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous text;
begin
  if not public.is_staff_aal2() then
    raise exception 'Staff with two-factor authentication only.' using errcode = '42501';
  end if;
  if p_status not in ('active', 'revoked') then
    raise exception 'Unknown status %', p_status using errcode = '22023';
  end if;
  if p_user_id = (select auth.uid()) then
    raise exception 'You cannot change your own access.' using errcode = '42501';
  end if;

  select status into previous from public.entitlements where user_id = p_user_id for update;
  if not found then
    raise exception 'That member has no access record.' using errcode = 'P0002';
  end if;

  update public.entitlements
     set status = p_status,
         status_reason = case when p_status = 'revoked' then left(p_reason, 300) end,
         updated_at = now()
   where user_id = p_user_id;

  insert into public.audit_log (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'access_' || p_status, 'entitlements', p_user_id::text,
          jsonb_build_object('previous', previous, 'reason', left(coalesce(p_reason, ''), 300)));
end;
$$;

-- Notification fan-out reads recipients with the same predicate as
-- has_access(), evaluated at send time. Service role only.
create function public.active_member_recipients()
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.user_id, p.email
    from public.entitlements e
    join public.profiles p on p.user_id = e.user_id
   cross join public.settings s
   where e.status = 'active'
     and e.access_ends_at is not null
     and e.access_ends_at + make_interval(days => s.grace_days) > now()
     and exists (
       select 1 from public.disclaimer_acceptances a
        where a.user_id = e.user_id and a.version = s.disclaimer_version
     );
$$;

-- ---------------------------------------------------------------------------
-- 8. Grants and RLS
-- ---------------------------------------------------------------------------
-- Functions: closed, then opened to exactly who needs each one.
revoke all on function public.handle_new_auth_user()                                         from public, anon, authenticated;
revoke all on function public.sync_profile_email()                                           from public, anon, authenticated;
revoke all on function public.is_staff()                                                     from public, anon, authenticated;
revoke all on function public.is_staff_aal2()                                                from public, anon, authenticated;
revoke all on function public.has_access()                                                   from public, anon, authenticated;
revoke all on function public.audit_row()                                                    from public, anon, authenticated;
revoke all on function public.guard_published_content()                                      from public, anon, authenticated;
revoke all on function public.forbid_delete()                                                from public, anon, authenticated;
revoke all on function public.claim_push_subscription(text, text, text)                      from public, anon, authenticated;
revoke all on function public.record_payment(text, uuid, uuid, text, bigint, text, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_extend_access(uuid, integer, text)                       from public, anon, authenticated;
revoke all on function public.admin_set_access_status(uuid, text, text)                      from public, anon, authenticated;
revoke all on function public.active_member_recipients()                                     from public, anon, authenticated;

grant execute on function public.is_staff()                                  to authenticated, service_role;
grant execute on function public.is_staff_aal2()                             to authenticated, service_role;
grant execute on function public.has_access()                                to authenticated, service_role;
grant execute on function public.claim_push_subscription(text, text, text)   to authenticated;
grant execute on function public.admin_extend_access(uuid, integer, text)    to authenticated;
grant execute on function public.admin_set_access_status(uuid, text, text)   to authenticated;
grant execute on function public.record_payment(text, uuid, uuid, text, bigint, text, timestamptz) to service_role;
grant execute on function public.active_member_recipients()                  to service_role;

-- Tables: anon gets nothing at all, now or for tables added later.
-- Authenticated keeps only select/insert/update/delete, narrowed by RLS
-- below; TRUNCATE (which ignores RLS), REFERENCES and TRIGGER are removed,
-- as is every write that no policy should ever be able to grant.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;
revoke insert, update, delete on public.audit_log from authenticated;
revoke insert, update, delete on public.payments, public.entitlements, public.checkout_intents,
  public.subscriptions, public.settings, public.staff, public.profiles from authenticated;
revoke insert, update on public.push_subscriptions from authenticated;

alter table public.settings               enable row level security;
alter table public.profiles               enable row level security;
alter table public.staff                  enable row level security;
alter table public.products               enable row level security;
alter table public.entitlements           enable row level security;
alter table public.checkout_intents       enable row level security;
alter table public.payments               enable row level security;
alter table public.subscriptions          enable row level security;
alter table public.disclaimer_acceptances enable row level security;
alter table public.picks                  enable row level security;
alter table public.pick_updates           enable row level security;
alter table public.announcements          enable row level security;
alter table public.push_subscriptions     enable row level security;
alter table public.audit_log              enable row level security;

-- Every staff READ branch requires aal2 as well, not only staff writes: a
-- phished email code alone must not expose member emails, payments, drafts
-- or the audit log.

-- settings: grace period and disclaimer version are not secret.
create policy "signed-in users read settings"
  on public.settings for select to authenticated using (true);

create policy "users read own profile; staff read all"
  on public.profiles for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_staff_aal2()));

-- Own row at any assurance level, so the app can tell a staff member to
-- complete two-factor.
create policy "users read own staff row; staff read all"
  on public.staff for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_staff_aal2()));

create policy "members read active products"
  on public.products for select to authenticated
  using (active or (select public.is_staff_aal2()));
create policy "staff create products"
  on public.products for insert to authenticated
  with check ((select public.is_staff_aal2()));
create policy "staff update products"
  on public.products for update to authenticated
  using ((select public.is_staff_aal2()))
  with check ((select public.is_staff_aal2()));

create policy "users read own entitlement; staff read all"
  on public.entitlements for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_staff_aal2()));

-- checkout_intents: no policy at all. Service role only.

create policy "users read own payments; staff read all"
  on public.payments for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_staff_aal2()));

create policy "users read own subscriptions; staff read all"
  on public.subscriptions for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_staff_aal2()));

create policy "users read own acceptances"
  on public.disclaimer_acceptances for select to authenticated
  using (user_id = (select auth.uid()));
-- Only the current version, only for yourself.
create policy "users accept the current disclaimer"
  on public.disclaimer_acceptances for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and version = (select s.disclaimer_version from public.settings s)
  );

create policy "members with access read published picks"
  on public.picks for select to authenticated
  using (deleted_at is null and published_at <= now() and (select public.has_access()));
create policy "staff read all picks"
  on public.picks for select to authenticated
  using ((select public.is_staff_aal2()));
create policy "staff post picks"
  on public.picks for insert to authenticated
  with check ((select public.is_staff_aal2()) and author_id = (select auth.uid()));
create policy "staff soft-delete picks"
  on public.picks for update to authenticated
  using ((select public.is_staff_aal2()))
  with check ((select public.is_staff_aal2()));

-- An update is visible only while its pick is: the subquery runs under the
-- picks policies, so a removed pick takes its whole thread with it.
create policy "members with access read pick updates"
  on public.pick_updates for select to authenticated
  using (
    deleted_at is null
    and published_at <= now()
    and (select public.has_access())
    and exists (select 1 from public.picks p where p.id = pick_updates.pick_id)
  );
create policy "staff read all pick updates"
  on public.pick_updates for select to authenticated
  using ((select public.is_staff_aal2()));
create policy "staff post pick updates"
  on public.pick_updates for insert to authenticated
  with check ((select public.is_staff_aal2()) and author_id = (select auth.uid()));
create policy "staff soft-delete pick updates"
  on public.pick_updates for update to authenticated
  using ((select public.is_staff_aal2()))
  with check ((select public.is_staff_aal2()));

create policy "members with access read announcements"
  on public.announcements for select to authenticated
  using (deleted_at is null and published_at <= now() and (select public.has_access()));
create policy "staff read all announcements"
  on public.announcements for select to authenticated
  using ((select public.is_staff_aal2()));
create policy "staff post announcements"
  on public.announcements for insert to authenticated
  with check ((select public.is_staff_aal2()) and author_id = (select auth.uid()));
-- Pin and soft-delete only: the guard trigger locks title and body once
-- published.
create policy "staff pin or remove announcements"
  on public.announcements for update to authenticated
  using ((select public.is_staff_aal2()))
  with check ((select public.is_staff_aal2()));

-- Registration goes through claim_push_subscription(); members may read and
-- remove their own devices directly.
create policy "users read own push subscriptions"
  on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));
create policy "users remove own push subscriptions"
  on public.push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "staff read audit log"
  on public.audit_log for select to authenticated
  using ((select public.is_staff_aal2()));

-- ---------------------------------------------------------------------------
-- 9. Storage: pick charts, private bucket
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('charts', 'charts', false, 4194304, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

-- A chart is readable exactly when its pick is: the subquery runs under the
-- picks policies, so members see charts of live, published picks while they
-- have access, and staff (aal2) see all. Orphans and removed picks: nobody.
create policy "chart readable when its pick is"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'charts'
    and exists (select 1 from public.picks p where p.chart_path = storage.objects.name)
  );
create policy "staff upload charts"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'charts' and (select public.is_staff_aal2()));
-- Lets a failed publish clean up the chart it just uploaded.
create policy "staff delete charts"
  on storage.objects for delete to authenticated
  using (bucket_id = 'charts' and (select public.is_staff_aal2()));

-- ---------------------------------------------------------------------------
-- 10. Verification (run by hand after applying; scripts/test-db.ts runs the
--     same checks against a local replay)
-- ---------------------------------------------------------------------------
-- -- Every function: anon can execute none of them. Expect zero rows.
-- select p.proname
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and has_function_privilege('anon', p.oid, 'execute');
--
-- -- record_payment is service_role only. Expect false, false, true.
-- select has_function_privilege('anon', 'public.record_payment(text,uuid,uuid,text,bigint,text,timestamptz)', 'execute'),
--        has_function_privilege('authenticated', 'public.record_payment(text,uuid,uuid,text,bigint,text,timestamptz)', 'execute'),
--        has_function_privilege('service_role', 'public.record_payment(text,uuid,uuid,text,bigint,text,timestamptz)', 'execute');
