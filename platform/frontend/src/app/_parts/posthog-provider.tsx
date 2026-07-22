"use client";

import posthog, { type PostHogConfig } from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useCallback, useEffect, useRef } from "react";
import { trackEvent } from "@/lib/analytics";
import { useSession } from "@/lib/auth/auth.query";
import config, { getTracingHeaderHosts } from "@/lib/config/config";
import { usePublicConfig } from "@/lib/config/config.query";

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
    posthog.register({
      instance_id: instanceId,
    });
    posthog.group("instance", instanceId);
    lastRegisteredInstanceIdRef.current = instanceId;
  }, []);

  useEffect(() => {
    const analytics = publicConfig?.analytics;

    if (
      !isPublicConfigLoading &&
      analytics?.enabled &&
      analytics.posthog.key &&
      !isPostHogInitializedRef.current
    ) {
      // `__add_tracing_headers` is the config key posthog-js reads to decorate
      // requests to our own hosts with `X-POSTHOG-SESSION-ID` /
      // `X-POSTHOG-DISTINCT-ID` headers, so backend-captured errors and logs
      // cross-reference this session replay. It isn't in posthog-js's exported
      // config type, hence the local intersection type.
      const initConfig: Partial<PostHogConfig> & {
        __add_tracing_headers?: string[];
      } = {
        ...config.posthog.config,
        api_host: analytics.posthog.host,
        __add_tracing_headers: getTracingHeaderHosts(),
      };
      posthog.init(analytics.posthog.key, initConfig);
      isPostHogInitializedRef.current = true;
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
      const isNewSignIn = posthog.get_distinct_id() !== userId;
      posthog.identify(userId, {
        email: userEmail,
        name: userName || userEmail,
      });
      if (isNewSignIn) {
        trackEvent("user_authenticated", {});
      }
      hasIdentifiedUserRef.current = true;
      lastIdentifiedUserIdRef.current = userId;
      return;
    } else if (userId) {
      return;
    }

    if (hasIdentifiedUserRef.current) {
      const instanceId = publicConfig?.analytics?.instanceId;
      posthog.reset();
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

  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
