import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

const API = "https://api.paystack.co";

export class PaystackNotConfigured extends Error {
  constructor() {
    super("PAYSTACK_SECRET_KEY is not set. Payments are disabled until it is.");
  }
}

function secret(): string {
  const key = env.paystackSecretKey();
  if (!key) throw new PaystackNotConfigured();
  return key;
}

export function paystackConfigured(): boolean {
  return Boolean(env.paystackSecretKey());
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secret()}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: T } | null;
  if (!res.ok || !body?.status) {
    throw new Error(`Paystack ${path} failed (${res.status}): ${body?.message ?? "no message"}`);
  }
  return body.data as T;
}

/**
 * x-paystack-signature is HMAC-SHA512 of the raw request body, keyed with the
 * secret key. Compared in constant time; refuses when the key is unset.
 */
export function verifySignature(rawBody: string, signature: string | null): boolean {
  const key = env.paystackSecretKey();
  if (!key || !signature) return false;
  const expected = createHmac("sha512", key).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const PLAN_INTERVAL: Record<number, string> = {
  1: "monthly",
  3: "quarterly",
  6: "biannually",
  12: "annually",
};

export async function createPlan(input: { name: string; amountKobo: number; accessMonths: number }) {
  const interval = PLAN_INTERVAL[input.accessMonths];
  if (!interval) throw new Error(`No Paystack interval for ${input.accessMonths} months`);
  return call<{ plan_code: string }>("/plan", {
    method: "POST",
    body: JSON.stringify({
      name: `Tito Circle: ${input.name}`,
      amount: input.amountKobo,
      interval,
      currency: "NGN",
    }),
  });
}

export async function initializeTransaction(input: {
  email: string;
  amountKobo: number;
  reference: string;
  callbackUrl: string;
  planCode?: string;
  metadata: Record<string, string>;
}) {
  return call<{ authorization_url: string; reference: string }>("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      amount: input.amountKobo,
      currency: "NGN",
      reference: input.reference,
      callback_url: input.callbackUrl,
      // With a plan, Paystack charges the plan amount and creates the
      // subscription after the first successful charge. Card only, because
      // transfers and USSD cannot be charged again automatically.
      ...(input.planCode ? { plan: input.planCode, channels: ["card"] } : {}),
      metadata: input.metadata,
    }),
  });
}

export type VerifiedTransaction = {
  status: string;
  reference: string;
  amount: number;
  currency: string;
  paid_at: string | null;
  paidAt?: string | null;
  customer: { email: string; customer_code: string };
  plan?: string | { plan_code?: string } | null;
  plan_object?: { plan_code?: string } | null;
};

export async function verifyTransaction(reference: string) {
  return call<VerifiedTransaction>(`/transaction/verify/${encodeURIComponent(reference)}`);
}

export function planCodeOf(tx: VerifiedTransaction): string | null {
  if (typeof tx.plan === "string" && tx.plan) return tx.plan;
  if (tx.plan && typeof tx.plan === "object" && tx.plan.plan_code) return tx.plan.plan_code;
  return tx.plan_object?.plan_code ?? null;
}

export async function subscriptionManageLink(subscriptionCode: string) {
  return call<{ link: string }>(`/subscription/${encodeURIComponent(subscriptionCode)}/manage/link`);
}
