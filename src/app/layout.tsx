import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, DM_Mono, DM_Sans } from "next/font/google";
import { connection } from "next/server";
import { DemoBanner, PersonaSwitcher, personaOf } from "@/components/demo-chrome";
import { getViewer } from "@/lib/auth";
import { isDemo } from "@/lib/demo/mode";
import { demoStorageFull } from "@/lib/demo/db";
import "./globals.css";

const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin"],
  weight: ["500", "600"],
  style: ["normal", "italic"],
});

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
});

const dmMono = DM_Mono({
  variable: "--font-dm-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: { default: "Tito Circle", template: "%s · Tito Circle" },
  description: "Tito Finance's private members' circle.",
  applicationName: "Tito Circle",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "Tito Circle", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#1A3A16",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request: Next.js stamps each request's CSP nonce
  // on its scripts while rendering, which a prerendered page cannot get.
  await connection();
  const demo = isDemo();
  const persona = demo ? personaOf((await getViewer())?.userId ?? null) : null;
  const storageFull = demo ? await demoStorageFull() : false;
  return (
    <html lang="en-NG" className={`${cormorant.variable} ${dmSans.variable} ${dmMono.variable} antialiased`}>
      <body className="min-h-dvh">
        {demo ? <DemoBanner /> : null}
        {children}
        {persona ? <PersonaSwitcher current={persona} storageFull={storageFull} /> : null}
      </body>
    </html>
  );
}
