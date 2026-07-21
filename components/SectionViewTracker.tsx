"use client";

/**
 * Fires section_view once when a section is half-visible for a moment.
 * A section impression beats scroll telemetry: meaningful events over
 * noisy ones (docs/engineering/ANALYTICS.md).
 */
import { useEffect, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { track } from "@/lib/analytics/track";

export function SectionViewTracker({
  sectionId,
  children,
}: {
  sectionId: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const fired = useRef(false);
  const pathname = usePathname();

  useEffect(() => {
    const element = ref.current;
    if (!element || fired.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.intersectionRatio >= 0.5 && !fired.current) {
            fired.current = true;
            track("section_view", { section_id: sectionId, route: pathname });
            observer.disconnect();
          }
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [sectionId, pathname]);

  return <section ref={ref}>{children}</section>;
}
