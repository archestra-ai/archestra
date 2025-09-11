import posthog from 'posthog-js';

import config from '@backend/config';
import UserModel from '@backend/models/user';
import log from '@backend/utils/logger';

class PostHogBackend {
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const user = await UserModel.getUser();

      if (!user.collectAnalyticsData) {
        log.info('PostHog analytics disabled by user preference');
        return;
      }

      posthog.init(config.posthog.apiKey, {
        api_host: config.posthog.apiHost,
        capture_pageview: false,
        persistence: 'memory',
        defaults: '2025-05-24',
        person_profiles: 'always',
      });

      if (user.uniqueId) {
        posthog.identify(user.uniqueId);
      }
      this.initialized = true;

      log.info('PostHog backend initialized successfully');
    } catch (error) {
      log.error('Failed to initialize PostHog backend:', error);
    }
  }

  capture(event: string, properties?: Record<string, any>): void {
    if (!this.initialized) return;

    try {
      posthog.capture(event, properties);
    } catch (error) {
      log.error('Failed to capture PostHog event:', error);
    }
  }

  shutdown(): void {
    if (this.initialized) {
      posthog.opt_out_capturing();
      this.initialized = false;
    }
  }

  async updateOptInStatus(collectAnalyticsData: boolean): Promise<void> {
    if (collectAnalyticsData && !this.initialized) {
      await this.initialize();
    } else if (!collectAnalyticsData && this.initialized) {
      this.shutdown();
    }
  }
}

export default new PostHogBackend();
