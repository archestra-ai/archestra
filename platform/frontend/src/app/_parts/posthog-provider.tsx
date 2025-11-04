"use client";

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useEffect } from "react";
import config from "@/lib/config";

export function PostHogProviderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    const {
      enabled: analyticsEnabled,
      token,
      config: posthogConfig,
    } = config.posthog;

    // biome-ignore lint/suspicious/noConsole: Logging analytics status is intentional for debugging
    console.log(
      `[Archestra] PostHog analytics is ${analyticsEnabled ? "ENABLED" : "DISABLED"}`,
    );

    if (analyticsEnabled && typeof window !== "undefined") {
      posthog.init(token, posthogConfig);
      // biome-ignore lint/suspicious/noConsole: Logging initialization success is intentional
      console.log("[Archestra] PostHog initialized successfully");
    }
  }, []);

  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
