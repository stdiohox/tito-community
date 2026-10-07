"use client";

import { useActionState } from "react";
import { createAnnouncement, createPick, createProduct, inviteMember, postUpdate, type FormState } from "../actions";
import { SubmitButton } from "@/components/submit-button";
import { Field, inputClass, Notice } from "@/components/ui";

function Feedback({ state }: { state: FormState }) {
  if (state.error) return <Notice tone="error">{state.error}</Notice>;
  if (state.message) return <Notice tone="success">{state.message}</Notice>;
  return null;
}

/*
 * React 19 resets each form after its action completes. Every field reads
 * its defaultValue from state.values, which the action fills only on failure,
 * so a rejected submit keeps what was typed and a successful one clears.
 * File inputs cannot be refilled by the browser; the chart must be chosen
 * again after an error, and the form says so.
 */

export function PickComposer() {
  const [state, action] = useActionState(createPick, {});
  const v = state.values ?? {};
  return (
    <form action={action} className="space-y-5" key={JSON.stringify(v)}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Ticker" htmlFor="ticker">
          <input id="ticker" name="ticker" required maxLength={15} autoCapitalize="characters" defaultValue={v.ticker} className={`${inputClass} font-mono uppercase`} placeholder="DANGCEM" />
        </Field>
        <Field label="Market" htmlFor="market">
          <select id="market" name="market" className={inputClass} defaultValue={v.market ?? "NGX"}>
            <option value="NGX">NGX (Nigeria)</option>
            <option value="US">US</option>
            <option value="OTHER">Other</option>
          </select>
        </Field>
        <Field label="Action" htmlFor="action">
          <select id="action" name="action" className={inputClass} defaultValue={v.action ?? "buy"}>
            <option value="buy">Buy</option>
            <option value="sell">Sell</option>
            <option value="hold">Hold</option>
            <option value="trim">Trim</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Entry" htmlFor="entry_price">
          <input id="entry_price" name="entry_price" required inputMode="decimal" defaultValue={v.entry_price} className={`${inputClass} tabular font-mono`} />
        </Field>
        <Field label="Target" htmlFor="target_price">
          <input id="target_price" name="target_price" required inputMode="decimal" defaultValue={v.target_price} className={`${inputClass} tabular font-mono`} />
        </Field>
        <Field label="Stop" htmlFor="stop_price">
          <input id="stop_price" name="stop_price" required inputMode="decimal" defaultValue={v.stop_price} className={`${inputClass} tabular font-mono`} />
        </Field>
      </div>
      <Field label="Rationale" htmlFor="rationale" hint="Why this, why now, and what would change your mind. 20 to 4,000 characters.">
        <textarea id="rationale" name="rationale" required minLength={20} maxLength={4000} rows={7} defaultValue={v.rationale} className={inputClass} />
      </Field>
      <Field
        label="Chart (optional)"
        htmlFor="chart"
        hint={`PNG, JPG or WebP, up to 4 MB. Stored privately; members see it through a link that expires in 5 minutes.${state.error ? " Choose the file again after an error." : ""}`}
      >
        <input id="chart" name="chart" type="file" accept="image/png,image/jpeg,image/webp" className="block w-full text-sm file:mr-4 file:min-h-11 file:rounded-full file:border-0 file:bg-forest file:px-4 file:text-sm file:text-ivory" />
      </Field>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" name="author_holds" defaultChecked={v.author_holds === "on"} className="mt-0.5 size-5 accent-forest" />
        <span>I hold this stock. Members will see this disclosure on the pick.</span>
      </label>
      <Notice tone="warning">
        Published picks cannot be edited. Corrections go in as updates, so the record of every call stays intact. Members with
        access get a push and email teaser straight away.
      </Notice>
      <Feedback state={state} />
      <SubmitButton pending="Publishing…" variant="gold" className="w-full sm:w-auto">
        Publish pick
      </SubmitButton>
    </form>
  );
}

export function UpdateForm({ pickId }: { pickId: string }) {
  const [state, action] = useActionState(postUpdate, {});
  const v = state.values ?? {};
  return (
    <form action={action} className="space-y-4" key={JSON.stringify(v)}>
      <input type="hidden" name="pick_id" value={pickId} />
      <Field label="Type" htmlFor="kind">
        <select id="kind" name="kind" className={inputClass} defaultValue={v.kind ?? "note"}>
          <option value="note">Note</option>
          <option value="revised">Revised levels</option>
          <option value="target_hit">Target hit</option>
          <option value="stop_hit">Stop hit</option>
          <option value="closed">Closed</option>
        </select>
      </Field>
      <Field label="Update" htmlFor="body">
        <textarea id="body" name="body" required minLength={2} maxLength={2000} rows={4} defaultValue={v.body} className={inputClass} />
      </Field>
      <Feedback state={state} />
      <SubmitButton pending="Posting…">Post update</SubmitButton>
    </form>
  );
}

export function AnnouncementForm() {
  const [state, action] = useActionState(createAnnouncement, {});
  const v = state.values ?? {};
  return (
    <form action={action} className="space-y-4" key={JSON.stringify(v)}>
      <Field label="Title" htmlFor="title">
        <input id="title" name="title" required maxLength={140} defaultValue={v.title} className={inputClass} />
      </Field>
      <Field label="Message" htmlFor="body">
        <textarea id="body" name="body" required maxLength={4000} rows={5} defaultValue={v.body} className={inputClass} />
      </Field>
      <label className="flex items-center gap-3 text-sm">
        <input type="checkbox" name="pinned" defaultChecked={v.pinned === "on"} className="size-5 accent-forest" />
        Pin to the top
      </label>
      <Feedback state={state} />
      <SubmitButton pending="Posting…">Post notice</SubmitButton>
    </form>
  );
}

export function InviteForm() {
  const [state, action] = useActionState(inviteMember, {});
  const v = state.values ?? {};
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-[1fr_1fr_8rem_auto] sm:items-end" key={JSON.stringify(v)}>
      <Field label="Email" htmlFor="invite-email">
        <input id="invite-email" name="email" type="email" required autoComplete="off" defaultValue={v.email} className={inputClass} />
      </Field>
      <Field label="Name (optional)" htmlFor="invite-name">
        <input id="invite-name" name="full_name" maxLength={120} autoComplete="off" defaultValue={v.full_name} className={inputClass} />
      </Field>
      <Field label="Days of access" htmlFor="invite-days">
        <input id="invite-days" name="days" type="number" min={0} max={730} defaultValue={v.days ?? 30} className={`${inputClass} tabular`} />
      </Field>
      <SubmitButton pending="Inviting…" className="sm:mb-0.5">
        Invite
      </SubmitButton>
      <div className="sm:col-span-4">
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function ProductForm() {
  const [state, action] = useActionState(createProduct, {});
  const v = state.values ?? {};
  return (
    <form action={action} className="space-y-4" key={JSON.stringify(v)}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Name" htmlFor="name">
          <input id="name" name="name" required maxLength={80} defaultValue={v.name} className={inputClass} placeholder="Circle · 6 months" />
        </Field>
        <Field label="Price (₦)" htmlFor="price_naira">
          <input id="price_naira" name="price_naira" required inputMode="numeric" defaultValue={v.price_naira} className={`${inputClass} tabular font-mono`} placeholder="300000" />
        </Field>
        <Field label="Access length" htmlFor="access_months" hint="Paystack auto-renew bills on these periods.">
          <select id="access_months" name="access_months" className={inputClass} defaultValue={v.access_months ?? "6"}>
            <option value="1">1 month</option>
            <option value="3">3 months</option>
            <option value="6">6 months</option>
            <option value="12">12 months</option>
          </select>
        </Field>
      </div>
      <Field label="Description (optional)" htmlFor="description">
        <textarea id="description" name="description" maxLength={500} rows={2} defaultValue={v.description} className={inputClass} />
      </Field>
      <Feedback state={state} />
      <SubmitButton pending="Creating…">Create product</SubmitButton>
    </form>
  );
}
