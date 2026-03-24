"use client";

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useEffect } from "react";
import config from "@/lib/config/config";

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

    if (analyticsEnabled && typeof window !== "undefined") {
      posthog.init(token, posthogConfig);
    }
  }, []);

  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
