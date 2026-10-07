import { requireSignedIn } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";

/** Signed-in pages that must work whether or not access is live. */
export default async function AccountLayout({ children }: LayoutProps<"/">) {
  const state = await requireSignedIn();
  return <AppShell isStaff={state.isStaff}>{children}</AppShell>;
}
