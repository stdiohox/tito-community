import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ownerQuery } from "@/lib/demo/db";
import { isDemo } from "@/lib/demo/mode";
import { shortDateTime } from "@/lib/format";
import { EmptyState, PageTitle } from "@/components/ui";

export const metadata: Metadata = { title: "Demo outbox" };

/**
 * Client preview mode only: every email the app would have sent during this
 * demo session (invites, sign-in alerts, pick teasers, publish alerts). None
 * of them left the server.
 */
export default async function DemoOutbox() {
  if (!isDemo()) notFound();
  const mails = await ownerQuery<{ id: number; to_email: string; subject: string; body: string; sent_at: string }>(
    `select id, to_email, subject, body, sent_at from public.demo_outbox order by id desc limit 100`,
  );

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <Link href="/" className="text-sm text-muted hover:text-ink">
        ← Back to the app
      </Link>
      <div className="mt-4">
        <PageTitle eyebrow="Demo" title="Emails sent">
          What Tito Circle would have emailed during this session. In the demo nothing is delivered: it all lands here. Note that
          pick alerts are teasers: no ticker or price ever leaves the app by email.
        </PageTitle>
      </div>
      {mails.length === 0 ? (
        <EmptyState title="Nothing sent yet">Publish a pick as Tito, or invite a member, then come back.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {mails.map((m) => (
            <li key={m.id} className="rounded-2xl border border-line bg-paper p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                To {m.to_email} · {shortDateTime(new Date(m.sent_at).toISOString())}
              </p>
              <p className="mt-1 font-medium">{m.subject}</p>
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted">{m.body}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
