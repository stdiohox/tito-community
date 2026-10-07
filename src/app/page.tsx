import { redirect } from "next/navigation";

// The gates on /picks decide where a visitor really belongs (sign-in,
// disclaimer, renew), so the root only needs to point there.
export default function Home() {
  redirect("/picks");
}
