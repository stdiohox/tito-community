import "server-only";
import { after } from "next/server";
import { isDemo } from "@/lib/demo/mode";

/**
 * after(), except in client preview mode, where the task runs before the
 * response. A demo visitor's state lives in their cookie, and a cookie can
 * only be written while the response is still open, so demo side effects
 * (alert emails, the outbox) must happen first to survive.
 */
export async function afterResponse(task: () => Promise<unknown>): Promise<void> {
  if (!isDemo()) {
    after(task);
    return;
  }
  try {
    await task();
  } catch (e) {
    console.error(`[demo] background task failed: ${e instanceof Error ? e.message : e}`);
  }
}
