"use client";

import { env } from "next-runtime-env";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useEffect } from "react";

export function PostHogProviderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    // Analytics is enabled by default, disabled only when explicitly set to "disabled"
    const analyticsSetting = env("NEXT_PUBLIC_ARCHESTRA_ANALYTICS");
    const analyticsEnabled = analyticsSetting !== "disabled";

    // biome-ignore lint/suspicious/noConsole: Logging analytics status is intentional for debugging
    console.log(
      `[Archestra] PostHog analytics is ${analyticsEnabled ? "ENABLED" : "DISABLED"}`,
      analyticsSetting
        ? `(ARCHESTRA_ANALYTICS="${analyticsSetting}")`
        : "(ARCHESTRA_ANALYTICS not set, defaulting to enabled)",
    );

    if (analyticsEnabled && typeof window !== "undefined") {
      posthog.init("phc_FFZO7LacnsvX2exKFWehLDAVaXLBfoBaJypdOuYoTk7", {
        api_host: "https://eu.i.posthog.com",
        person_profiles: "identified_only",
      });
      // biome-ignore lint/suspicious/noConsole: Logging initialization success is intentional
      console.log("[Archestra] PostHog initialized successfully");
    }
  }, []);

  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
