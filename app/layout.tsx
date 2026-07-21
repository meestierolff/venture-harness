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
    default: "Venture Harness — validation site foundation",
    template: "%s — Venture Harness",
  },
  description:
    "Template validation-site foundation. Replace this metadata at venture bootstrap; the operational plumbing (consent, analytics, experiments, evidence) stays.",
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
            Built from the Venture Harness template. This template page is visually neutral by
            design — each venture replaces the design, keeps the plumbing.
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
