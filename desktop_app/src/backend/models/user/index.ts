import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import db from '@backend/database';
import { SelectUserSchema, userTable } from '@backend/database/schema/user';
import log from '@backend/utils/logger';
import sentryClient from '@backend/utils/sentry';

export const PatchUserSchema = z
  .object({
    hasCompletedOnboarding: z.boolean(),
    collectTelemetryData: z.boolean(),
    collectAnalyticsData: z.boolean(),
  })
  .partial();

export default class UserModel {
  static async ensureUserExists(): Promise<z.infer<typeof SelectUserSchema>> {
    try {
      let result = await db.select().from(userTable).limit(1);

      if (result.length === 0) {
        /**
         * No record exists, create the default user with a unique ID
         */
        const newUser = await db
          .insert(userTable)
          .values({
            uniqueId: uuidv4(),
          })
          .returning();
        log.info('Created default user record with unique ID');
        return newUser[0];
      } else if (!result[0].uniqueId) {
        /**
         * User exists but doesn't have a uniqueId, generate one
         *
         * Unforunately, drizzle-kit does not currently support js/ts migration files, see:
         * - https://orm.drizzle.team/docs/kit-custom-migrations
         * - https://github.com/drizzle-team/drizzle-orm/discussions/2832
         *
         * Additionally, sqlite does not have a native way to generate a UUID, so for now, we do the "migration" here..
         */
        const updatedUser = await db
          .update(userTable)
          .set({ uniqueId: uuidv4() })
          .where(eq(userTable.id, result[0].id))
          .returning();
        log.info('Added unique ID to existing user record');
        return updatedUser[0];
      }

      return result[0];
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

      // Update Sentry telemetry status if collectTelemetryData was changed
      if ('collectTelemetryData' in updates) {
        sentryClient.updateTelemetryStatus(updates.collectTelemetryData!, updatedRecord[0]);
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
