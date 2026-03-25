"use client";

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useEffect, useRef } from "react";
import { authClient } from "@/lib/clients/auth/auth-client";
import config from "@/lib/config/config";

export function PostHogProviderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, isPending: isSessionPending } =
    authClient.useSession();
  const hasIdentifiedUserRef = useRef(false);

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

  useEffect(() => {
    const analyticsEnabled = config.posthog.enabled;
    if (
      !analyticsEnabled ||
      typeof window === "undefined" ||
      isSessionPending
    ) {
      return;
    }

    const user = session?.user;
    if (user) {
      posthog.identify(user.id, {
        email: user.email,
        name: user.name || user.email,
      });
      hasIdentifiedUserRef.current = true;
      return;
    }

    if (hasIdentifiedUserRef.current) {
      posthog.reset();
      hasIdentifiedUserRef.current = false;
    }
  }, [isSessionPending, session?.user]);

  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
