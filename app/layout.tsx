import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";
import { ConsentBanner, ConsentSettingsLink } from "@/components/ConsentBanner";
import { AnalyticsScripts } from "@/components/AnalyticsScripts";
import { PageViewTracker } from "@/components/PageViewTracker";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Venture Harness — launch OS prototype",
    template: "%s — Venture Harness",
  },
  description:
    "Locally tested launch-planning and workflow prototype. Child ventures replace this neutral template with their own verified identity and claims.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="wordmark">
            venture-harness
          </Link>
          <nav aria-label="Main">
            <Link href="/pricing">Pricing</Link>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <p>
            Venture Harness v0.2 prototype. This neutral, accessible shell is replaced by each
            venture&apos;s reviewed design and evidence-backed claims.
          </p>
          <ConsentSettingsLink />
        </footer>
        <ConsentBanner />
        <AnalyticsScripts />
        <PageViewTracker />
      </body>
    </html>
  );
}
