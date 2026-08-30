import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";
import { ConsentBanner, ConsentSettingsLink } from "@/components/ConsentBanner";
import { AnalyticsScripts } from "@/components/AnalyticsScripts";
import { PageViewTracker } from "@/components/PageViewTracker";
import { INDEXING_ENABLED, SITE_URL } from "@/lib/site-config";

export const metadata: Metadata = {
  metadataBase: SITE_URL,
  title: {
    default: "Venture Harness — founder-alpha Launch Factory",
    template: "%s — Venture Harness",
  },
  description:
    "Open-source founder-alpha Core for reviewable Launch Contracts, focused app seeds, bounded launch plans, and conservative Launch Receipts.",
  robots: { index: INDEXING_ENABLED, follow: INDEXING_ENABLED },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <nav aria-label="Main">
            <Link href="/" className="wordmark">
              venture-harness
            </Link>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <p>
            Venture Harness founder alpha. Local and fixture evidence is labeled; external provider
            proof requires read-back. Independent ventures keep their own repository, design, and
            accounts.
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
