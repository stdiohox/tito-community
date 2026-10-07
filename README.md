# Tito Circle

Tito Finance's private, members-only community at **community.titofinance.com**. Members who pay
sign in, read Tito's stock picks, updates and notices, and lose access automatically when their
membership ends, until they renew.

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · Supabase (Postgres, Auth, Storage) ·
Paystack · Resend · Web Push · Vercel · installable PWA. Package manager: **npm**.

---

## How access works

Access is a date comparison inside Postgres, checked on every read:

```
entitlements.access_ends_at + settings.grace_days > now()
```

- **RLS enforces it.** Every member-readable table (picks, pick updates, notices) and the private
  `charts` storage bucket has a policy that calls `has_access()`. When the date passes, the next
  query returns nothing. No cron "removes" anyone, and no JWT claim can keep an expired member in.
- **The UI follows the database.** Page guards call the same `has_access()` to send expired
  members to the Renew screen. If a guard were bypassed, the pages would simply render empty.
- **Renewal is instant.** A verified payment moves `access_ends_at`, and the next request succeeds.
- **Early renewal stacks.** New time starts at the later of the payment time and the current end
  date, so days already paid for are never lost.
- **Staff need two-factor, for reads too.** Posting, managing members, creating products, *and*
  reading member data, payments or the audit log all require an `aal2` session (TOTP). The database
  checks this on every query, so a phished email code alone exposes nothing. There is one staff role,
  admin.
- **The disclaimer is enforced by the database.** `has_access()` also requires acceptance of the
  current disclaimer version.
- **Published picks are permanent.** They can't be edited after posting; corrections go in as updates.
  Removal is a one-way soft delete, and every staff action is in an insert-only audit log.
- **Alerts are teasers.** Push notifications and emails say only that a new pick exists, never the
  ticker or prices, and go only to members with access at the moment of sending.

## Routes

| Path | Who | What |
|---|---|---|
| `/sign-in` | anyone | Email one-time code. Invite-only; never reveals whether an email is a member |
| `/welcome` | signed in | Versioned disclaimer, accepted once per version |
| `/picks`, `/picks/[id]`, `/announcements` | members with access, staff | Feed, pick detail with update thread, notices |
| `/membership` | signed in | Days left, auto-renew status, renew or extend, alerts, payment history |
| `/renew` | expired members | Renew screen |
| `/membership/confirm` | signed in | Paystack return page; verifies the payment |
| `/admin/*` | staff with two-factor | Overview, picks, notices, members, products |
| `/api/paystack/webhook` | Paystack | Signed webhook |

---

## Setup

### 1. Create the Supabase project

New project, region **London (eu-west-2)**, the closest to Lagos and the UK diaspora.

### 2. Apply the migration

Open **SQL Editor**, paste all of `supabase/migrations/0001_tito_circle.sql` and run it. (Or use
`supabase db push` with the Supabase CLI.) Then run the two verification queries at the bottom of the
file. The first must return **zero rows**.

### 3. Configure Auth (Authentication → Sign In / Providers, and Emails)

These settings are part of the security model, not optional polish:

1. **Turn off "Allow new users to sign up".** Accounts are created only by admins (invites) and the
   seed script. The app's `shouldCreateUser: false` is a client flag, not a control.
2. **Turn off anonymous sign-ins.**
3. **Email provider on**, email OTP length **6**.
4. **Emails → Magic Link template:** the body must include `{{ .Token }}` so members receive a
   *code*. For example: `Your Tito Circle sign-in code is {{ .Token }}. It expires in a few minutes.`
5. **Custom SMTP → Resend.** Supabase's built-in mailer only delivers to your own team's addresses
   and is heavily rate-limited, so members won't receive codes without this. Resend SMTP: host
   `smtp.resend.com`, port `465`, user `resend`, password = your Resend API key, sender on your
   verified domain.
6. **URL Configuration → Site URL:** `https://community.titofinance.com` (or your preview URL).
7. **Multi-factor → TOTP enabled** (it is by default).

### 4. Environment variables

Copy `.env.example` to `.env.local` and fill it in. Set the same variables in Vercel.

| Variable | Required | Where it comes from |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Same page, `anon` public key |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Same page, `service_role` key. **Server only. Never expose it** |
| `NEXT_PUBLIC_SITE_URL` | yes | `https://community.titofinance.com`, no trailing slash. `http://localhost:3000` locally |
| `PAYSTACK_SECRET_KEY` | for payments | Paystack → Settings → API Keys & Webhooks. Use `sk_test_…` for the demo |
| `RESEND_API_KEY` | for email | Resend → API Keys |
| `EMAIL_FROM` | for email | e.g. `Tito Circle <circle@titofinance.com>`, on a Resend-verified domain |
| `ADMIN_ALERT_EMAILS` | recommended | Comma-separated; every publish is announced here immediately |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | for push | `npm run vapid:keys` |
| `VAPID_PRIVATE_KEY` | for push | Same command. Server only |
| `VAPID_SUBJECT` | for push | `mailto:you@titofinance.com` |
| `SEED_EMAIL` | seed only | Your own inbox (see step 5) |

Anything optional that is missing turns its feature off, with a clear message in the UI and the
server log. Nothing pretends to work.

### 5. Install, seed and run

```bash
npm install
npm run seed     # reads .env.local
npm run dev
```

The seed is safe to re-run. With `SEED_EMAIL=you@gmail.com` it creates:

| Who | Email | Access |
|---|---|---|
| Admin (Tito) | `you@gmail.com` | Staff |
| Active member | `you+active@gmail.com` | 120 days left |
| Expiring member | `you+expiring@gmail.com` | Ends in 2 days (shows the renewal banner) |
| Expired member | `you+expired@gmail.com` | Ended 10 days ago, past the 3-day grace (sees Renew) |

It also creates two products, *Circle · 1 month* (₦60,000, a placeholder price) and *Circle · 6 months*
(₦300,000, matching Close Community), plus two clearly labelled **sample** picks, an update and a
notice. If `PAYSTACK_SECRET_KEY` is set, it creates Paystack plans for the products so auto-renew is
available.

Every sign-in code for every demo account lands in your inbox. Each member accepts the disclaimer on
first sign-in; until they do, the database itself gives them no access.

The admin sets up an authenticator app on the first visit to `/admin`. The seed opens a one-time
**enrolment window** for that. The window closes the moment an authenticator is verified, and an alert
goes to the admin and to `ADMIN_ALERT_EMAILS`. It exists because staff sign in by email code: without
it, anyone who got into a staff mailbox could enrol their own authenticator.

#### Lost authenticator

1. In Supabase, go to Authentication → Users, open the admin, and delete their MFA factor.
2. In the SQL Editor, reopen the window:

```sql
update public.staff set mfa_enrollment_open = true
 where user_id = (select user_id from public.profiles where email = 'tito@example.com');
```

### 6. Paystack test mode

1. Use the **test** secret key (`sk_test_…`).
2. **Webhook URL** (Settings → API Keys & Webhooks, test mode): `https://<your-domain>/api/paystack/webhook`.
3. Pay with Paystack's test cards, listed in Paystack's "Test Payments" docs.
4. Locally, Paystack can't reach `localhost`. The return page (`/membership/confirm`) verifies the
   payment with Paystack itself, so one-off payments still grant access. To exercise the webhook and
   auto-renewal events locally, expose the dev server through a tunnel and use that URL.

What happens on a payment:

1. Checkout writes a `checkout_intents` row: who, which product, how much, which plan.
2. The webhook (and the return page) re-fetch the transaction from Paystack with the secret key and
   check it against that intent. Webhook metadata is never trusted.
3. `record_payment()` claims the reference and extends access **in one transaction**. A replayed
   webhook does nothing.
4. Auto-renewal charges carry no intent. They are matched by plan code to a product and by Paystack
   customer code to a member, and the amount must equal the product price.

### 7. Deploy

1. Import the repo into Vercel and set the environment variables.
2. Add the domain `community.titofinance.com`, with a CNAME at the DNS provider pointing to Vercel.
3. Set Supabase's Site URL and Paystack's live webhook to that domain when you switch to live keys.

---

## Tests

```bash
npm test            # both suites
npm run test:db     # migration + RLS, replayed in PGlite as anon / member / staff / service role
npm run test:payments  # real processReference() and webhook handler against the real migration
npm run typecheck && npm run lint && npm run build
```

`test:db` reproduces Supabase's default privileges, including the direct `EXECUTE` grants to
`anon`. A function that loses its explicit revoke therefore fails the suite.

`test:payments` fakes only the network boundary: Paystack's verify API and Supabase's REST layer.

## Deliberately not in this build

- **Excluded by the brief:** CRM connection, WhatsApp, comments, performance record.
- **Not built yet:**
  - realtime feed updates (push covers new picks);
  - scheduled publishing;
  - device or session limits;
  - re-authentication on every publish (two-factor is required per session instead);
  - attachment watermarking.
- **Known, accepted for the demo** (from the security review; fix before launch):
  - The CSP allows `'unsafe-inline'` scripts. A nonce-based CSP set in `src/proxy.ts` would remove that.
  - Sign-in relies on Supabase's own OTP rate limits. A non-member's request may return slightly faster
    than a member's, so timing could hint at membership. Add a per-IP throttle with equalised timing.
  - Retrying a failed Paystack plan creation twice quickly can create two plans on Paystack. Only one
    is saved.
  - A pick notification is claimed before sending. If the process dies mid-send, that pick's alerts are
    not retried. It is logged.
- **Disclaimer wording** in `src/lib/disclaimer.ts` is a draft for Tito's lawyer. To change it, add a
  new version there, deploy, then bump `settings.disclaimer_version`. Members re-accept on their next
  visit.
- **The grace period** is `settings.grace_days` (default 3).
