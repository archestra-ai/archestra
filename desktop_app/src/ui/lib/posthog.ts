import posthog from 'posthog-js';

import { type User } from '@ui/lib/clients/archestra/api/gen';

import config from '../config';

class PostHogClient {
  private initialized = false;

  /**
   * Initialize PostHog for analytics tracking
   */
  async initialize() {
    if (this.initialized) {
      console.log('PostHog already initialized');
      return;
    }

    const appInfo = await window.electronAPI.getAppInfo();

    // Only initialize in packaged builds (production) unless explicitly enabled for dev
    const forceEnableInDev = import.meta.env.VITE_POSTHOG_DEV_ENABLED === 'true';
    if (!appInfo.isPackaged && !forceEnableInDev) {
      console.log('PostHog disabled in development build (set VITE_POSTHOG_DEV_ENABLED=true to enable)');
      return;
    }

    console.log(
      forceEnableInDev ? 'Initializing PostHog for analytics (DEV MODE TESTING)' : 'Initializing PostHog for analytics'
    );

    posthog.init(config.posthog.apiKey, {
      api_host: config.posthog.host,
      person_profiles: 'identified_only',
      persistence: 'localStorage+cookie',
      autocapture: true,
      capture_pageview: true,
      capture_pageleave: true,
      session_recording: {
        recordCrossOriginIframes: false,
      },
    });

    this.initialized = true;
    console.log('PostHog initialized for analytics tracking');
  }

  /**
   * Set user context for PostHog
   */
  setUserContext(user: User) {
    if (!this.initialized) {
      console.warn('PostHog not initialized, cannot set user context');
      return;
    }

    if (user.collectAnalyticsData && user.uniqueId) {
      // Use anonymous identifier
      const userId = `user_${user.uniqueId}`;
      posthog.identify(userId);
      console.log('PostHog user context set');
    } else {
      this.clearUserContext();
    }
  }

  /**
   * Clear user context from PostHog
   */
  clearUserContext() {
    if (!this.initialized) {
      return;
    }

    posthog.reset();
    console.log('PostHog user context cleared');
  }

  /**
   * Update analytics collection status
   */
  updateAnalyticsStatus(collectAnalyticsData: boolean, user: User | null = null) {
    if (!this.initialized && collectAnalyticsData) {
      // If not initialized and user wants analytics, initialize now
      this.initialize().then(() => {
        if (user) {
          this.setUserContext(user);
        }
      });
      return;
    }

    if (!this.initialized) {
      console.warn('PostHog not initialized');
      return;
    }

    if (collectAnalyticsData) {
      // Re-enable PostHog and set user context
      posthog.opt_in_capturing();
      if (user) {
        this.setUserContext(user);
      }
      console.log('PostHog analytics enabled');
    } else {
      // Clear user context and disable PostHog
      this.clearUserContext();
      posthog.opt_out_capturing();
      console.log('PostHog analytics disabled');
    }
  }

  /**
   * Capture a custom event
   */
  capture(event: string, properties?: Record<string, any>) {
    if (!this.initialized) {
      return;
    }

    posthog.capture(event, properties);
  }

  /**
   * Get the PostHog instance for advanced usage
   */
  getInstance() {
    return this.initialized ? posthog : null;
  }
}

export default new PostHogClient();
