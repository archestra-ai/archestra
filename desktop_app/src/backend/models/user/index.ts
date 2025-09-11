import { eq } from 'drizzle-orm';
import { z } from 'zod';

import db from '@backend/database';
import { SelectUserSchema, userTable } from '@backend/database/schema/user';
import log from '@backend/utils/logger';
import posthogBackend from '@backend/utils/posthog';

export const PatchUserSchema = z
  .object({
    hasCompletedOnboarding: z.boolean(),
    collectTelemetryData: z.boolean(),
    collectAnalyticsData: z.boolean(),
  })
  .partial();

export default class UserModel {
  static async ensureUserExists(): Promise<void> {
    try {
      const result = await db.select().from(userTable).limit(1);

      if (result.length === 0) {
        /**
         * No record exists, create the default user
         *
         * For now, we don't need to specify any values here, as the default values are set in the schema
         */
        await db.insert(userTable).values({});
        log.info('Created default user record');
      }
    } catch (error) {
      log.error('Failed to ensure user exists:', error);
      throw error;
    }
  }

  static async getUser() {
    try {
      await this.ensureUserExists();
      const result = await db.select().from(userTable).limit(1);
      if (result.length === 0) {
        throw new Error('No user found');
      }
      return result[0];
    } catch (error) {
      log.error('Failed to get user:', error);
      throw error;
    }
  }

  static async patchUser(updates: z.infer<typeof PatchUserSchema>) {
    try {
      await this.ensureUserExists();
      const existingRecord = await db.select().from(userTable).limit(1);

      const updatedRecord = await db
        .update(userTable)
        .set({
          ...updates,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(userTable.id, existingRecord[0].id))
        .returning();

      /**
       * TODO: if collectTelemetryData in `updates`, update the Sentry SDK accordingly...
       */
      
      // Update PostHog opt-in status if collectAnalyticsData changed
      if ('collectAnalyticsData' in updates) {
        await posthogBackend.updateOptInStatus(updates.collectAnalyticsData as boolean);
      }

      log.info('User updated successfully');
      return updatedRecord[0];
    } catch (error) {
      log.error('Failed to update user:', error);
      throw error;
    }
  }
}

export { SelectUserSchema };
