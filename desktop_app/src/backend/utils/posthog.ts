import { PostHog } from 'posthog-js';

import UserModel from '@backend/models/user';
import log from '@backend/utils/logger';

import config from '../../config';

class PostHogBackend {
  private posthog: PostHog | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const user = await UserModel.getUser();

      if (!user.collectAnalyticsData) {
        log.info('PostHog analytics disabled by user preference');
        return;
      }

      const { PostHog } = await import('posthog-js');
      this.posthog = new PostHog(config.posthog.apiKey, {
        host: config.posthog.apiHost,
        capture_pageview: false,
        persistence: 'memory',
      });

      this.posthog.identify(`user_${user.id}`);
      this.initialized = true;

      log.info('PostHog backend initialized successfully');
    } catch (error) {
      log.error('Failed to initialize PostHog backend:', error);
    }
  }

  capture(event: string, properties?: Record<string, any>): void {
    if (!this.posthog || !this.initialized) return;

    try {
      this.posthog.capture(event, properties);
    } catch (error) {
      log.error('Failed to capture PostHog event:', error);
    }
  }

  shutdown(): void {
    if (this.posthog && this.initialized) {
      this.posthog.shutdown();
      this.initialized = false;
      this.posthog = null;
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
