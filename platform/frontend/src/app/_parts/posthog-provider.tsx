"use client";

import { useCallback, useEffect, useRef } from "react";
import { trackEvent } from "@/lib/analytics";
import { useSession } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { usePublicConfig } from "@/lib/config/config.query";
import { errorReporting } from "@/lib/error-reporting";
import { posthogClient } from "@/lib/posthog-client";

export function PostHogProviderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, isPending: isSessionPending } = useSession();
  const { data: publicConfig, isLoading: isPublicConfigLoading } =
    usePublicConfig();
  const hasIdentifiedUserRef = useRef(false);
  const isPostHogInitializedRef = useRef(false);
  const lastRegisteredInstanceIdRef = useRef<string | null>(null);
  const lastIdentifiedUserIdRef = useRef<string | null>(null);
  const userId = session?.user?.id;
  const userEmail = session?.user?.email;
  const userName = session?.user?.name;

  const registerInstance = useCallback((instanceId: string) => {
    posthogClient.run((posthog) => {
      posthog.register({
        instance_id: instanceId,
      });
      posthog.group("instance", instanceId);
    });
    lastRegisteredInstanceIdRef.current = instanceId;
  }, []);

  useEffect(() => {
    const analytics = publicConfig?.analytics;

    // The same switch decides whether errors go to Archestra's Sentry.
    if (!isPublicConfigLoading && publicConfig) {
      errorReporting.setAnalyticsEnabled(Boolean(analytics?.enabled));
    }

    if (
      !isPublicConfigLoading &&
      analytics?.enabled &&
      analytics.posthog.key &&
      !isPostHogInitializedRef.current
    ) {
      // Loads and initializes PostHog once the app is interactive; calls
      // made until then are queued (see posthogClient).
      posthogClient.init(analytics.posthog.key, {
        ...config.posthog.config,
        api_host: analytics.posthog.host,
      });
      isPostHogInitializedRef.current = true;
    } else if (!isPublicConfigLoading && publicConfig && !analytics?.enabled) {
      posthogClient.disable();
    }

    if (
      analytics?.enabled &&
      analytics.instanceId &&
      isPostHogInitializedRef.current &&
      analytics.instanceId !== lastRegisteredInstanceIdRef.current
    ) {
      registerInstance(analytics.instanceId);
    }
  }, [isPublicConfigLoading, publicConfig, registerInstance]);

  useEffect(() => {
    const analyticsEnabled = publicConfig?.analytics?.enabled;
    if (
      !analyticsEnabled ||
      !isPostHogInitializedRef.current ||
      isSessionPending
    ) {
      return;
    }

    if (userId && userId !== lastIdentifiedUserIdRef.current && userEmail) {
      // PostHog persists the distinct id in localStorage, so it only differs
      // from the session's user id right after a sign-in on this browser
      // (sign-out resets it to an anonymous id). Reloads while signed in keep
      // the identified id, so they don't re-fire the event.
      posthogClient.run((posthog) => {
        const isNewSignIn = posthog.get_distinct_id() !== userId;
        posthog.identify(userId, {
          email: userEmail,
          name: userName || userEmail,
        });
        if (isNewSignIn) trackEvent("user_authenticated", {});
      });
      hasIdentifiedUserRef.current = true;
      lastIdentifiedUserIdRef.current = userId;
      return;
    } else if (userId) {
      return;
    }

    if (hasIdentifiedUserRef.current) {
      const instanceId = publicConfig?.analytics?.instanceId;
      posthogClient.run((posthog) => posthog.reset());
      if (instanceId) {
        registerInstance(instanceId);
      }
      hasIdentifiedUserRef.current = false;
      lastIdentifiedUserIdRef.current = null;
    }
  }, [
    isSessionPending,
    publicConfig,
    registerInstance,
    userEmail,
    userId,
    userName,
  ]);

  return <>{children}</>;
}
