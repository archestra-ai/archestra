import { create } from 'zustand';

import { type User, getUser, updateUser } from '@ui/lib/clients/archestra/api/gen';
import posthogClient from '@ui/lib/posthog';
import sentryClient from '@ui/lib/sentry';
import webSocketService from '@ui/lib/websocket';

interface UserStore {
  user: User | null;
  loading: boolean;
  isAuthenticated: boolean;

  fetchUser: () => Promise<void>;
  markOnboardingCompleted: () => Promise<void>;
  toggleTelemetryCollectionStatus: (collectTelemetryData: boolean) => Promise<void>;
  toggleAnalyticsCollectionStatus: (collectAnalyticsData: boolean) => Promise<void>;
  toggleUserAuthenticated: (isAuthenticated: boolean) => void;
  subscribeToUserAuthenticatedEvent: (method: 'onboarding', successCallback: () => void) => void;
}

export const useUserStore = create<UserStore>((set, get) => ({
  user: null,
  loading: false,
  isAuthenticated: false,

  fetchUser: async () => {
    set({ loading: true });
    try {
      const { data } = await getUser();
      set({ user: data });
    } finally {
      set({ loading: false });
    }
  },

  markOnboardingCompleted: async () => {
    const { data } = await updateUser({ body: { hasCompletedOnboarding: true } });
    set({ user: data });

    // Track onboarding completion in PostHog
    posthogClient.capture('onboarding_completed');
  },

  toggleTelemetryCollectionStatus: async (collectTelemetryData: boolean) => {
    const { user } = get();
    if (!user) return;

    const { data } = await updateUser({ body: { collectTelemetryData } });
    set({ user: data });

    // Update Sentry client telemetry status
    sentryClient.updateTelemetryStatus(collectTelemetryData, data);
  },

  toggleAnalyticsCollectionStatus: async (collectAnalyticsData: boolean) => {
    const { user } = get();
    if (!user) return;

    const { data } = await updateUser({ body: { collectAnalyticsData } });
    set({ user: data });

    // Update PostHog analytics status
    posthogClient.updateAnalyticsStatus(collectAnalyticsData, data);
  },

  toggleUserAuthenticated: (isAuthenticated: boolean) => {
    set({ isAuthenticated });
  },

  subscribeToUserAuthenticatedEvent: (method: 'onboarding', successCallback: () => void) => {
    console.log('Subscribing to user authenticated event');

    webSocketService.subscribe('user-authenticated', ({ payload }) => {
      const { toggleUserAuthenticated, user } = useUserStore.getState();
      console.log('🔐 User authenticated via WebSocket:', payload);

      // Update authentication state
      toggleUserAuthenticated(true);

      // Log the authentication event
      console.log('✅ User authentication successful!');

      // Track authentication in PostHog
      posthogClient.capture('user_authenticated', {
        userId: user?.uniqueId,
        method,
      });

      successCallback();
    });
  },
}));
