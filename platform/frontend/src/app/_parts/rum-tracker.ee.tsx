"use client";

import { usePathname } from "next/navigation";
import { useReportWebVitals } from "next/web-vitals";
import { useEffect } from "react";
import { useSession } from "@/lib/auth/auth.query";
import { usePublicConfig } from "@/lib/config/config.query";
import { rumClient } from "@/lib/rum.ee";

// Next also reports its own Next.js-* timings through the same hook; only the
// standard Core Web Vitals are part of the RUM taxonomy.
const WEB_VITAL_NAMES = new Set(["LCP", "CLS", "INP", "FCP", "TTFB"]);

/**
 * Starts the RUM client when the deployment has a RUM export endpoint
 * configured and a user is signed in, and reports a page view per App Router
 * navigation (route changes never remount the layout, so the pathname effect
 * is the navigation hook). Renders nothing.
 */
export function RumTracker() {
  const { data: publicConfig } = usePublicConfig();
  const { data: session } = useSession();
  const pathname = usePathname();

  const enabled = Boolean(publicConfig?.rum.enabled);
  const userId = session?.user?.id;
  const isSignedIn = Boolean(userId);

  // Registered unconditionally (hooks can't be conditional); the client
  // buffers a few pre-start metrics and drops everything while stopped.
  useReportWebVitals((metric) => {
    if (WEB_VITAL_NAMES.has(metric.name)) {
      rumClient.trackWebVital({
        name: metric.name,
        value: metric.value,
        rating: metric.rating,
      });
    }
  });

  useEffect(() => {
    if (!enabled || !isSignedIn) {
      rumClient.stop();
      return;
    }
    rumClient.start({ sampleRate: publicConfig?.rum.sampleRate });
    return () => rumClient.stop();
  }, [enabled, isSignedIn, publicConfig?.rum.sampleRate]);

  // Sign-in detection lives on the RUM client (not the analytics taxonomy)
  // because the analytics call site requires PostHog to be initialized —
  // see rumClient.setUser.
  useEffect(() => {
    if (enabled && isSignedIn && userId) {
      rumClient.setUser(userId);
    }
  }, [enabled, isSignedIn, userId]);

  useEffect(() => {
    // /auth/* is transient sign-in/sign-out plumbing, not product usage —
    // and a sign-out page view could never be delivered anyway (the session
    // is being torn down under it).
    if (enabled && isSignedIn && pathname && !pathname.startsWith("/auth")) {
      rumClient.trackPageView(pathname);
    }
  }, [enabled, isSignedIn, pathname]);

  return null;
}
