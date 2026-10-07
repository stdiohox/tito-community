import { isDemo } from "@/lib/demo/mode";

/**
 * Runs once when a server instance starts. Refuses to boot at all if
 * DEMO_MODE=true is set alongside real service keys (isDemo() throws), so a
 * misconfigured deployment fails loudly instead of serving anything.
 */
export function register() {
  isDemo();
}
