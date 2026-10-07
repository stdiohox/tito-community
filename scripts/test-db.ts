/**
 * Replays supabase/migrations into PGlite (in-process Postgres) on top of
 * stubs that mimic the parts of Supabase the schema depends on, then checks
 * every access rule as the real roles: anon, authenticated (member / staff at
 * aal1 / staff at aal2) and service_role.
 *
 * The stubs deliberately reproduce Supabase's default privileges, which grant
 * EXECUTE on new functions to anon and authenticated directly. That is the
 * trap the migration's revokes exist for, so the test would be meaningless
 * without it.
 *
 *   npm run test:db
 */
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const STUBS = readFileSync(join(process.cwd(), "scripts", "supabase-stubs.sql"), "utf8")

type Who =
  | { role: 'anon' }
  | { role: 'service_role' }
  | { role: 'authenticated'; sub: string; aal?: 'aal1' | 'aal2' }

let failures = 0
let passes = 0

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passes++
    console.log(`  ok    ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

async function as<T>(db: PGlite, who: Who, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  let result!: T
  await db.transaction(async (tx) => {
    const claims =
      who.role === 'authenticated'
        ? { sub: who.sub, role: 'authenticated', aal: who.aal ?? 'aal1' }
        : { role: who.role }
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      who.role === 'authenticated' ? who.sub : '',
    ])
    await tx.exec(`set local role ${who.role}`)
    result = await fn(tx)
    // Every check runs inside a transaction that is rolled back unless the
    // caller asks to keep it, so one check's writes never leak into the next.
    await tx.rollback()
  })
  return result
}

async function asKeep<T>(db: PGlite, who: Who, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  let result!: T
  await db.transaction(async (tx) => {
    const claims =
      who.role === 'authenticated'
        ? { sub: who.sub, role: 'authenticated', aal: who.aal ?? 'aal1' }
        : { role: who.role }
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      who.role === 'authenticated' ? who.sub : '',
    ])
    await tx.exec(`set local role ${who.role}`)
    result = await fn(tx)
  })
  return result
}

async function fails(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const id = {
  admin: '00000000-0000-4000-8000-000000000001',
  active: '00000000-0000-4000-8000-000000000002',
  expiring: '00000000-0000-4000-8000-000000000003',
  expired: '00000000-0000-4000-8000-000000000004',
  graced: '00000000-0000-4000-8000-000000000005',
  revoked: '00000000-0000-4000-8000-000000000006',
  nobody: '00000000-0000-4000-8000-000000000007',
}
const UNACCEPTED = '00000000-0000-4000-8000-000000000008'
const CHART = `${'00000000-0000-4000-8000-000000000001'}/${'11111111-1111-4111-8111-111111111111'}.png`
const REMOVED_CHART = `${'00000000-0000-4000-8000-000000000001'}/${'22222222-2222-4222-8222-222222222222'}.png`

async function main() {
  const db = new PGlite()
  await db.exec(STUBS)

  const dir = join(process.cwd(), 'supabase', 'migrations')
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dir, file), 'utf8'))
    console.log(`applied ${file}`)
  }

  // Seed as superuser: the auth trigger creates profiles.
  for (const [name, uid] of Object.entries(id)) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [uid, `${name}@example.test`])
  }
  await db.query(`insert into public.staff (user_id, role) values ($1, 'admin')`, [id.admin])
  const ends: Record<string, string> = {
    active: `now() + interval '120 days'`,
    expiring: `now() + interval '2 days'`,
    expired: `now() - interval '10 days'`,
    graced: `now() - interval '1 day'`, // inside the 3-day grace
    revoked: `now() + interval '60 days'`,
  }
  for (const [name, expr] of Object.entries(ends)) {
    await db.query(
      `insert into public.entitlements (user_id, access_ends_at, status) values ($1, ${expr}, $2)`,
      [id[name as keyof typeof id], name === 'revoked' ? 'revoked' : 'active'],
    )
  }
  // Everyone but `unaccepted` has accepted the current disclaimer.
  await db.query(`insert into auth.users (id, email) values ($1, 'unaccepted@example.test')`, [UNACCEPTED])
  await db.query(`insert into public.entitlements (user_id, access_ends_at) values ($1, now() + interval '90 days')`, [UNACCEPTED])
  for (const uid of Object.values(id)) {
    await db.query(`insert into public.disclaimer_acceptances (user_id, version) values ($1, 1)`, [uid])
  }
  const product = await db.query<{ id: string }>(
    `insert into public.products (name, price_kobo, access_months) values ('Circle 6 months', 30000000, 6) returning id`,
  )
  const productId = product.rows[0].id

  console.log('\nprofiles and grants')
  {
    const r = await db.query<{ n: number }>(`select count(*)::int n from public.profiles`)
    check('auth trigger created a profile per user', r.rows[0].n === Object.keys(id).length + 1, r.rows[0])

    await db.query(`update auth.users set email = 'Ada.New@Example.test' where id = $1`, [id.nobody])
    const synced = await db.query<{ email: string }>(`select email from public.profiles where user_id = $1`, [id.nobody])
    check('a confirmed email change reaches the profile (lower-cased)', synced.rows[0].email === 'ada.new@example.test', synced.rows[0])

    const trunc = await db.query<{ t: boolean }>(`select has_table_privilege('authenticated', 'public.audit_log', 'truncate') t`)
    check('authenticated cannot TRUNCATE (which would bypass RLS)', !trunc.rows[0].t)

    const anonExec = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`)
    check('anon can execute no public function', anonExec.rows.length === 0, anonExec.rows)

    const sig = `public.record_payment(text,uuid,uuid,text,bigint,text,timestamptz)`
    const rp = await db.query<{ a: boolean; u: boolean; s: boolean }>(`
      select has_function_privilege('anon', '${sig}', 'execute') a,
             has_function_privilege('authenticated', '${sig}', 'execute') u,
             has_function_privilege('service_role', '${sig}', 'execute') s`)
    check('record_payment is service_role only', !rp.rows[0].a && !rp.rows[0].u && rp.rows[0].s, rp.rows[0])

    const amr = await db.query<{ u: boolean }>(
      `select has_function_privilege('authenticated', 'public.active_member_recipients()', 'execute') u`,
    )
    check('active_member_recipients is not callable by members', !amr.rows[0].u)
  }

  // Content to read.
  await asKeep(db, { role: 'authenticated', sub: id.admin, aal: 'aal2' }, async (tx) => {
    const p = await tx.query<{ id: string }>(
      `insert into public.picks (ticker, market, action, entry_price, target_price, stop_price, rationale, chart_path)
       values ('DANGCEM', 'NGX', 'buy', 480, 560, 440, 'Sample rationale long enough to pass the check.', $1) returning id`,
      [CHART],
    )
    await tx.query(`insert into public.pick_updates (pick_id, kind, body) values ($1, 'note', 'Holding steady.')`, [
      p.rows[0].id,
    ])
    await tx.query(`insert into public.announcements (title, body) values ('Welcome', 'Hello members.')`)
    await tx.query(`insert into storage.objects (bucket_id, name) values ('charts', $1), ('charts', $2), ('charts', 'orphan/x.png')`, [
      CHART,
      REMOVED_CHART,
    ])
    // A second pick, removed, with its own update and chart: none of it may
    // reach members.
    const gone = await tx.query<{ id: string }>(
      `insert into public.picks (ticker, market, action, entry_price, target_price, stop_price, rationale, chart_path)
       values ('OLDCO', 'NGX', 'sell', 10, 8, 11, 'A pick that is later removed from the feed.', $1) returning id`,
      [REMOVED_CHART],
    )
    await tx.query(`insert into public.pick_updates (pick_id, kind, body) values ($1, 'note', 'Update on a removed pick.')`, [
      gone.rows[0].id,
    ])
    await tx.query(`update public.picks set deleted_at = now() where id = $1`, [gone.rows[0].id])
  })
  const pickId = (await db.query<{ id: string }>(`select id from public.picks where ticker = 'DANGCEM'`)).rows[0].id

  console.log('\nanonymous')
  {
    const e = await fails(() => as(db, { role: 'anon' }, (tx) => tx.query(`select * from public.picks`)))
    check('anon cannot read picks', e !== null && /permission denied/.test(e), e)
    const e2 = await fails(() => as(db, { role: 'anon' }, (tx) => tx.query(`select public.has_access()`)))
    check('anon cannot call has_access()', e2 !== null && /permission denied/.test(e2), e2)
  }

  console.log('\nmember reads (end date + grace > now, current disclaimer accepted)')
  console.log('  (one live pick, its update, one notice and its chart; the removed pick, its update and chart, and an orphan chart are never visible)')
  const expectations: [string, string, boolean][] = [
    ['active', id.active, true],
    ['expiring', id.expiring, true],
    ['graced', id.graced, true],
    ['expired', id.expired, false],
    ['revoked', id.revoked, false],
    ['nobody', id.nobody, false],
    ['unaccepted (paid, disclaimer not accepted)', UNACCEPTED, false],
  ]
  for (const [who, uid, allowed] of expectations) {
    const r = await as(db, { role: 'authenticated', sub: uid }, async (tx) => ({
      access: (await tx.query<{ v: boolean }>(`select public.has_access() v`)).rows[0].v,
      picks: (await tx.query(`select id from public.picks`)).rows.length,
      updates: (await tx.query(`select id from public.pick_updates`)).rows.length,
      ann: (await tx.query(`select id from public.announcements`)).rows.length,
      charts: (await tx.query(`select id from storage.objects`)).rows.length,
    }))
    const n = allowed ? 1 : 0
    check(
      `${who}: access=${allowed}, sees ${n} pick/update/announcement/chart`,
      r.access === allowed && r.picks === n && r.updates === n && r.ann === n && r.charts === n,
      r,
    )
  }

  console.log('\nmember isolation')
  {
    const r = await as(db, { role: 'authenticated', sub: id.active }, async (tx) => ({
      ents: (await tx.query(`select user_id from public.entitlements`)).rows.length,
      profiles: (await tx.query(`select user_id from public.profiles`)).rows.length,
      audit: (await tx.query(`select id from public.audit_log`)).rows.length,
      staff: (await tx.query(`select user_id from public.staff`)).rows.length,
    }))
    check('member sees only own entitlement and profile, no audit or staff rows', r.ents === 1 && r.profiles === 1 && r.audit === 0 && r.staff === 0, r)

    const e1 = await fails(() =>
      as(db, { role: 'authenticated', sub: id.active }, (tx) =>
        tx.query(`update public.entitlements set access_ends_at = now() + interval '10 years'`),
      ),
    )
    check('member cannot extend own entitlement', e1 !== null, e1)

    const e2 = await fails(() =>
      as(db, { role: 'authenticated', sub: id.active }, (tx) =>
        tx.query(
          `insert into public.picks (ticker, market, action, entry_price, target_price, stop_price, rationale, author_id)
           values ('X', 'US', 'buy', 1, 2, 1, 'member trying to post a pick here', $1)`,
          [id.active],
        ),
      ),
    )
    check('member cannot post a pick', e2 !== null, e2)

    const e3 = await fails(() =>
      as(db, { role: 'authenticated', sub: id.active }, (tx) =>
        tx.query(
          `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://fcm.googleapis.com/fcm/send/x', 'k', 'a')`,
          [id.expired],
        ),
      ),
    )
    check('members cannot write push_subscriptions directly (RPC only)', e3 !== null, e3)

    const ssrf = await fails(() =>
      as(db, { role: 'authenticated', sub: id.active }, (tx) =>
        tx.query(`select public.claim_push_subscription('https://169.254.169.254/latest', 'k', 'a')`),
      ),
    )
    check('a non-push-service endpoint is refused (no SSRF)', ssrf !== null && /check constraint/.test(ssrf), ssrf)

    const shared = await as(db, { role: 'service_role' }, async () => null).then(async () => {
      const ep = 'https://fcm.googleapis.com/fcm/send/shared-device'
      await asKeep(db, { role: 'authenticated', sub: id.expiring }, (tx) =>
        tx.query(`select public.claim_push_subscription($1, 'k', 'a')`, [ep]),
      )
      await asKeep(db, { role: 'authenticated', sub: id.active }, (tx) =>
        tx.query(`select public.claim_push_subscription($1, 'k', 'a')`, [ep]),
      )
      return (await db.query<{ user_id: string }>(`select user_id from public.push_subscriptions where endpoint = $1`, [ep])).rows
    })
    check('a shared device moves to whoever signed in last', shared.length === 1 && shared[0].user_id === id.active, shared)

    const e4 = await fails(() =>
      as(db, { role: 'authenticated', sub: id.active }, (tx) =>
        tx.query(`insert into public.disclaimer_acceptances (user_id, version) values ($1, 99)`, [id.active]),
      ),
    )
    check('member cannot accept a disclaimer version that is not current', e4 !== null, e4)

    const accepted = await as(db, { role: 'authenticated', sub: UNACCEPTED }, async (tx) => {
      const before = (await tx.query<{ v: boolean }>(`select public.has_access() v`)).rows[0].v
      await tx.query(`insert into public.disclaimer_acceptances (user_id, version) values ($1, 1)`, [UNACCEPTED])
      const after = (await tx.query<{ v: boolean }>(`select public.has_access() v`)).rows[0].v
      return { before, after }
    })
    check('accepting the current disclaimer is what unlocks a paid member', !accepted.before && accepted.after, accepted)

    const e5 = await fails(() =>
      as(db, { role: 'authenticated', sub: id.active }, (tx) =>
        tx.query(`select public.admin_extend_access($1, 30, 'self')`, [id.active]),
      ),
    )
    check('member cannot call admin_extend_access', e5 !== null, e5)
  }

  console.log('\nstaff and two-factor')
  {
    const e1 = await fails(() =>
      as(db, { role: 'authenticated', sub: id.admin, aal: 'aal1' }, (tx) =>
        tx.query(
          `insert into public.picks (ticker, market, action, entry_price, target_price, stop_price, rationale)
           values ('MTNN', 'NGX', 'buy', 1, 2, 1, 'Admin without two-factor tries to post')`,
        ),
      ),
    )
    check('staff at aal1 cannot post a pick', e1 !== null, e1)

    const e2 = await fails(() =>
      as(db, { role: 'authenticated', sub: id.admin, aal: 'aal1' }, (tx) =>
        tx.query(`select public.admin_extend_access($1, 30, 'x')`, [id.expired]),
      ),
    )
    check('staff at aal1 cannot extend access', e2 !== null, e2)

    const aal1 = await as(db, { role: 'authenticated', sub: id.admin, aal: 'aal1' }, async (tx) => ({
      picks: (await tx.query(`select id from public.picks`)).rows.length,
      ents: (await tx.query(`select user_id from public.entitlements`)).rows.length,
      profiles: (await tx.query(`select user_id from public.profiles`)).rows.length,
      audit: (await tx.query(`select id from public.audit_log`)).rows.length,
      ownStaffRow: (await tx.query(`select user_id from public.staff`)).rows.length,
    }))
    check(
      'staff at aal1 read nothing beyond their own rows (a phished email code exposes no member data)',
      aal1.picks === 0 && aal1.ents === 0 && aal1.profiles === 1 && aal1.audit === 0 && aal1.ownStaffRow === 1,
      aal1,
    )

    const r = await as(db, { role: 'authenticated', sub: id.admin, aal: 'aal2' }, async (tx) => ({
      picks: (await tx.query(`select id from public.picks`)).rows.length,
      ents: (await tx.query(`select user_id from public.entitlements`)).rows.length,
      charts: (await tx.query(`select id from storage.objects`)).rows.length,
    }))
    check('staff at aal2 read all picks (removed ones too), entitlements and pick charts', r.picks === 2 && r.ents === 6 && r.charts === 2, r)

    const e3 = await fails(() =>
      as(db, { role: 'authenticated', sub: id.admin, aal: 'aal2' }, (tx) =>
        tx.query(`update public.picks set target_price = 999 where id = $1`, [pickId]),
      ),
    )
    check('published pick cannot be edited, even by staff', e3 !== null && /cannot be edited/.test(e3), e3)

    const e4 = await fails(() =>
      as(db, { role: 'authenticated', sub: id.admin, aal: 'aal2' }, async (tx) => {
        await tx.query(`update public.picks set deleted_at = now() where id = $1`, [pickId])
        await tx.query(`update public.picks set deleted_at = null where id = $1`, [pickId])
      }),
    )
    check('soft delete is allowed and one-way', e4 !== null && /cannot be restored/.test(e4), e4)

    const e5 = await fails(() =>
      as(db, { role: 'authenticated', sub: id.admin, aal: 'aal2' }, (tx) =>
        tx.query(`update public.audit_log set action = 'x'`),
      ),
    )
    check('audit log is insert-only, even for staff', e5 !== null, e5)

    const e7 = await fails(() =>
      as(db, { role: 'service_role' }, (tx) => tx.query(`delete from public.picks where id = $1`, [pickId])),
    )
    check('picks are never hard-deleted, not even by the service role', e7 !== null && /never deleted/.test(e7), e7)

    const ext = await as(db, { role: 'authenticated', sub: id.admin, aal: 'aal2' }, async (tx) => {
      await tx.query(`select public.admin_extend_access($1, 30, 'goodwill')`, [id.expired])
      const lapsed = await tx.query<{ ok: boolean }>(
        `select access_ends_at between now() + interval '29 days 23 hours' and now() + interval '30 days 1 hour' ok
           from public.entitlements where user_id = $1`,
        [id.expired],
      )
      await tx.query(`select public.admin_extend_access($1, 30, 'stack')`, [id.active])
      const active = await tx.query<{ ok: boolean }>(
        `select access_ends_at > now() + interval '149 days' ok from public.entitlements where user_id = $1`,
        [id.active],
      )
      await tx.query(`select public.admin_set_access_status($1, 'revoked', 'test')`, [id.active])
      const audit = await tx.query<{ n: number }>(
        `select count(*)::int n from public.audit_log where action in ('access_extended', 'access_revoked') and actor_id = $1`,
        [id.admin],
      )
      return { lapsed: lapsed.rows[0].ok, active: active.rows[0].ok, audit: audit.rows[0].n }
    })
    check('extend: lapsed member starts from now, active member stacks, both audited', ext.lapsed && ext.active && ext.audit === 3, ext)

    const e6 = await fails(() =>
      as(db, { role: 'authenticated', sub: id.admin, aal: 'aal2' }, (tx) =>
        tx.query(`select public.admin_set_access_status($1, 'revoked', 'self')`, [id.admin]),
      ),
    )
    check('staff cannot revoke their own access', e6 !== null, e6)
  }

  console.log('\nrecord_payment (service role)')
  {
    const call = (tx: Transaction, ref: string, who: string, paidAt = 'now()') =>
      tx.query<{ r: { status: string; term_starts_at: string; term_ends_at: string } }>(
        `select public.record_payment($1, $2, $3, 'one_off', 30000000, 'NGN', ${paidAt}) r`,
        [ref, who, productId],
      )

    const r = await as(db, { role: 'service_role' }, async (tx) => {
      const before = (
        await tx.query<{ e: string }>(`select access_ends_at::text e from public.entitlements where user_id = $1`, [id.active])
      ).rows[0].e
      const first = (await call(tx, 'ref_early_renewal_1', id.active)).rows[0].r
      const second = (await call(tx, 'ref_early_renewal_1', id.active)).rows[0].r
      const after = (
        await tx.query<{ stacked: boolean; e: string }>(
          `select access_ends_at = ($2::timestamptz + interval '6 months') stacked, access_ends_at::text e
             from public.entitlements where user_id = $1`,
          [id.active, before],
        )
      ).rows[0]
      const payments = (
        await tx.query<{ n: number }>(`select count(*)::int n from public.payments where reference = 'ref_early_renewal_1'`)
      ).rows[0].n

      const lapsed = (await call(tx, 'ref_lapsed_1', id.expired)).rows[0].r
      const lapsedOk = (
        await tx.query<{ ok: boolean }>(
          `select access_ends_at > now() + interval '5 months 27 days' and access_ends_at < now() + interval '6 months 1 day' ok
             from public.entitlements where user_id = $1`,
          [id.expired],
        )
      ).rows[0].ok

      const fresh = (await call(tx, 'ref_new_member_1', id.nobody)).rows[0].r
      return { first, second, stacked: after.stacked, payments, lapsed, lapsedOk, fresh }
    })
    check('early renewal stacks on the current end date', r.first.status === 'recorded' && r.stacked, r)
    check('replayed reference is a no-op', r.second.status === 'duplicate' && r.payments === 1, r.second)
    check('lapsed member: new term starts at payment time', r.lapsed.status === 'recorded' && r.lapsedOk, r.lapsed)
    check('member with no entitlement row gets one', r.fresh.status === 'recorded', r.fresh)

    const future = await fails(() =>
      as(db, { role: 'service_role' }, (tx) => call(tx, 'ref_future_1', id.nobody, `now() + interval '5 years'`)),
    )
    check('a far-future payment date is refused (cannot mint access)', future !== null && /Implausible/.test(future), future)

    const recipients = await as(db, { role: 'service_role' }, async (tx) =>
      (await tx.query<{ user_id: string }>(`select user_id from public.active_member_recipients()`)).rows.map((x) => x.user_id),
    )
    const want = [id.active, id.expiring, id.graced].sort()
    check('notification recipients = members with access only', JSON.stringify(recipients.sort()) === JSON.stringify(want), recipients)
  }

  console.log('\nrate limiting (0002)')
  {
    const e = await fails(() =>
      as(db, { role: 'authenticated', sub: id.active }, (tx) => tx.query(`select public.rate_limit_hit('x', 3, 60)`)),
    )
    check('members cannot call rate_limit_hit', e !== null && /permission denied/.test(e), e)

    const r = await as(db, { role: 'service_role' }, async (tx) => {
      const hit = async (key: string) =>
        (await tx.query<{ ok: boolean }>(`select public.rate_limit_hit($1, 3, 900) ok`, [key])).rows[0].ok
      const seq = [await hit('otp:a'), await hit('otp:a'), await hit('otp:a'), await hit('otp:a')]
      const other = await hit('otp:b')
      await tx.query(`update public.rate_limits set window_start = now() - interval '16 minutes' where key = 'otp:a'`)
      const afterWindow = await hit('otp:a')
      return { seq, other, afterWindow }
    })
    check(
      'limit 3: three allowed, the fourth refused; keys independent; a new window resets',
      JSON.stringify(r.seq) === '[true,true,true,false]' && r.other && r.afterWindow,
      r,
    )
  }

  console.log('\npaystack plan claim (0002)')
  {
    const r = await as(db, { role: 'service_role' }, async (tx) => {
      const claim = async () =>
        (await tx.query<{ t: string | null }>(`select public.claim_plan_creation($1)::text t`, [productId])).rows[0].t
      const claimedAt = async () =>
        (await tx.query<{ t: string | null }>(`select plan_claimed_at::text t from public.products where id = $1`, [productId])).rows[0].t
      const first = await claim()
      const second = await claim()
      // Ten minutes is the expiry: still held at nine.
      await tx.query(`update public.products set plan_claimed_at = now() - interval '9 minutes' where id = $1`, [productId])
      const atNine = await claim()
      await tx.query(`update public.products set plan_claimed_at = now() - interval '11 minutes' where id = $1`, [productId])
      const oldToken = (await claimedAt())!
      const afterStale = await claim()
      // The abandoned request wakes up and releases: it must not clear the new claim.
      await tx.query(`select public.release_plan_claim($1, $2::timestamptz)`, [productId, oldToken])
      const stillHeld = (await claimedAt()) === afterStale
      // The abandoned request also finishes first: its plan is saved (it is
      // tagged for this product) but the newer claim is left alone...
      const firstWinner = (await tx.query<{ w: string }>(`select public.finish_plan_creation($1, 'PLN_first', $2::timestamptz) w`, [productId, oldToken])).rows[0].w
      const claimKept = (await claimedAt()) === afterStale
      // ...and the current claimant's own plan does not replace it.
      const secondWinner = (await tx.query<{ w: string }>(`select public.finish_plan_creation($1, 'PLN_second', $2::timestamptz) w`, [productId, afterStale])).rows[0].w
      const cleared = (await claimedAt()) === null
      const afterPlan = await claim()
      return { first: Boolean(first), second, atNine, afterStale: Boolean(afterStale), stillHeld, firstWinner, claimKept, secondWinner, cleared, afterPlan }
    })
    check('one claim at a time; a claim is held for ten minutes, then expires', r.first && r.second === null && r.atNine === null && r.afterStale, r)
    check('a late release from an expired claimant does not clear the newer claim', r.stillHeld, r)
    check(
      'a saved plan is never replaced: the first code wins and is returned to both callers',
      r.firstWinner === 'PLN_first' && r.claimKept && r.secondWinner === 'PLN_first' && r.cleared && r.afterPlan === null,
      r,
    )
  }

  console.log('\npick alert queue (0002)')
  {
    // Fresh state for the queue: the earlier record_payment checks ran in
    // rolled-back transactions, so recipients are active, expiring, graced.
    const r = await as(db, { role: 'service_role' }, async (tx) => {
      const claim = async () =>
        (await tx.query<{ id: string; channel: string; attempts: number; email: string; endpoint: string | null }>(
          `select * from public.claim_notification_batch(50, 300, 5)`,
        )).rows
      const enq = async (pid: string) =>
        (await tx.query<{ n: number }>(`select public.enqueue_pick_notifications($1) n`, [pid])).rows[0].n

      const queued = await enq(pickId)
      const again = await enq(pickId)
      const removed = (await tx.query<{ id: string }>(`select id from public.picks where ticker = 'OLDCO'`)).rows[0].id
      const removedQueued = await enq(removed)

      const batch1 = await claim()
      const whileLocked = await claim()

      // Crash: the worker died holding the lock. Once it lapses, the same
      // rows are handed out again, with the attempt counted.
      await tx.query(`update public.notification_deliveries set locked_until = now() - interval '1 second'`)
      const afterCrash = await claim()

      const [ok, transient, permanent, quota] = afterCrash
      // The crashed worker (attempt 1) wakes up late and reports "failed":
      // the row now belongs to attempt 2, so its report changes nothing.
      const staleReport = (
        await tx.query<{ r: boolean }>(`select public.complete_notification($1, 1, false, 'late', false, 5, null) r`, [ok.id])
      ).rows[0].r
      const staleLeftAlone = (
        await tx.query<{ s: string }>(`select status s from public.notification_deliveries where id = $1`, [ok.id])
      ).rows[0].s === 'sending'
      await tx.query(`select public.complete_notification($1, 2, true, null, false, 5, null)`, [ok.id])
      await tx.query(`select public.complete_notification($1, 2, false, 'timeout', false, 5, null)`, [transient.id])
      await tx.query(`select public.complete_notification($1, 2, false, 'gone', true, 5, null)`, [permanent.id])
      // A provider that says "try again in six hours" (a daily email quota).
      await tx.query(`select public.complete_notification($1, 2, false, 'daily_quota_exceeded', false, 5, 21600)`, [quota.id])
      const quotaDelay = (
        await tx.query<{ ok: boolean }>(
          `select next_attempt_at between now() + interval '5 hours 59 minutes' and now() + interval '6 hours 1 minute' ok
             from public.notification_deliveries where id = $1`,
          [quota.id],
        )
      ).rows[0].ok
      // A finished row cannot be reopened by a stray report.
      const reopen = (
        await tx.query<{ r: boolean }>(`select public.complete_notification($1, 2, false, 'stray', false, 5, null) r`, [ok.id])
      ).rows[0].r

      const statuses = (
        await tx.query<{ status: string; n: number }>(
          `select status, count(*)::int n from public.notification_deliveries group by status order by status`,
        )
      ).rows
      const backoffFuture = (
        await tx.query<{ ok: boolean }>(`select next_attempt_at > now() ok from public.notification_deliveries where id = $1`, [transient.id])
      ).rows[0].ok

      // A member who lapses before their alert is sent is skipped, not sent:
      // lapse the owner of the transiently-failed row, make it due, claim.
      const owner = (
        await tx.query<{ user_id: string }>(`select user_id from public.notification_deliveries where id = $1`, [transient.id])
      ).rows[0].user_id
      await tx.query(`update public.entitlements set access_ends_at = now() - interval '30 days' where user_id = $1`, [owner])
      await tx.query(`update public.notification_deliveries set next_attempt_at = now() where id = $1`, [transient.id])
      const afterLapse = await claim()
      const lapsedRow = (
        await tx.query<{ status: string }>(`select status from public.notification_deliveries where id = $1`, [transient.id])
      ).rows[0].status

      // Backoff never overflows, however many attempts a row has had.
      await tx.query(`update public.notification_deliveries set status = 'sending', attempts = 40 where id = $1`, [quota.id])
      const noOverflow = await fails(() =>
        tx.query(`select public.complete_notification($1, 40, false, 'again', false, 50, null)`, [quota.id]),
      )

      return {
        queued, again, removedQueued,
        batch1: batch1.length, channels: batch1.map((b) => b.channel).sort(), whileLocked: whileLocked.length,
        afterCrash: afterCrash.length, attempts: afterCrash.map((b) => b.attempts),
        staleReport, staleLeftAlone, statuses, backoffFuture, quotaDelay, reopen,
        afterLapse: afterLapse.length, lapsedRow, noOverflow,
      }
    })
    check('enqueue: one email per member with access plus one push per device (3 + 1)', r.queued === 4 && r.batch1 === 4, r)
    check('enqueueing twice adds nothing; a removed pick queues nothing', r.again === 0 && r.removedQueued === 0, r)
    check('claimed rows are not handed out twice while locked', r.whileLocked === 0, r)
    check('after a crash, the unsent rows are claimed again (attempt 2)', r.afterCrash === 4 && r.attempts.every((a) => a === 2), r)
    check('a late report from a worker whose row was reclaimed changes nothing', r.staleReport === false && r.staleLeftAlone, r)
    check(
      'outcomes: sent, a transient failure backs off, a permanent one fails, a quota waits as long as told',
      JSON.stringify(r.statuses) === JSON.stringify([{ status: 'failed', n: 1 }, { status: 'pending', n: 2 }, { status: 'sent', n: 1 }]) &&
        r.backoffFuture && r.quotaDelay,
      r.statuses,
    )
    check('a sent row cannot be reopened by a stray report', r.reopen === false, r)
    check('a member who lapsed before their alert went out is skipped, not sent', r.lapsedRow === 'skipped' && r.afterLapse === 0, r)
    check('backoff never overflows, however many attempts', r.noOverflow === null, r.noOverflow)

    const staffRead = await as(db, { role: 'authenticated', sub: id.admin, aal: 'aal2' }, async (tx) => {
      await tx.exec(`set local role postgres`)
      await tx.query(`select public.enqueue_pick_notifications($1)`, [pickId])
      await tx.exec(`set local role authenticated`)
      return (await tx.query(`select id from public.notification_deliveries`)).rows.length
    })
    const memberRead = await as(db, { role: 'authenticated', sub: id.active }, async (tx) => {
      await tx.exec(`set local role postgres`)
      await tx.query(`select public.enqueue_pick_notifications($1)`, [pickId])
      await tx.exec(`set local role authenticated`)
      return (await tx.query(`select id from public.notification_deliveries`)).rows.length
    })
    check('staff (aal2) can read the queue; members cannot', staffRead === 4 && memberRead === 0, { staffRead, memberRead })
  }

  console.log(`\n${passes} passed, ${failures} failed`)
  await db.close()
  if (failures > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
