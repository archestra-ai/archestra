import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import db from '@backend/database';
import { SelectMemorySchema, memoryTable } from '@backend/database/schema/memory';
import UserModel from '@backend/models/user';
import log from '@backend/utils/logger';

export const CreateMemorySchema = z.object({
  name: z.string().min(1).describe('Name/key for the memory entry'),
  value: z.string().describe('Value/content of the memory entry'),
});

export const UpdateMemorySchema = CreateMemorySchema;

export interface MemoryEntry {
  id: number;
  name: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export default class MemoryModel {
  /**
   * Get all memory entries for the current user
   */
  static async getAllMemories(): Promise<MemoryEntry[]> {
    try {
      const user = await UserModel.getUser();

      const result = await db
        .select({
          id: memoryTable.id,
          name: memoryTable.name,
          value: memoryTable.value,
          createdAt: memoryTable.createdAt,
          updatedAt: memoryTable.updatedAt,
        })
        .from(memoryTable)
        .where(eq(memoryTable.userId, user.id))
        .orderBy(memoryTable.name);

      return result as MemoryEntry[];
    } catch (error) {
      log.error('Failed to get all memories:', error);
      throw error;
    }
  }

  /**
   * Get a specific memory entry by name
   */
  static async getMemory(name: string): Promise<MemoryEntry | null> {
    try {
      const user = await UserModel.getUser();

      const result = await db
        .select({
          id: memoryTable.id,
          name: memoryTable.name,
          value: memoryTable.value,
          createdAt: memoryTable.createdAt,
          updatedAt: memoryTable.updatedAt,
        })
        .from(memoryTable)
        .where(and(eq(memoryTable.userId, user.id), eq(memoryTable.name, name)))
        .limit(1);

      if (result.length === 0) {
        return null;
      }

      return result[0] as MemoryEntry;
    } catch (error) {
      log.error(`Failed to get memory "${name}":`, error);
      throw error;
    }
  }

  /**
   * Create or update a memory entry
   */
  static async setMemory(name: string, value: string): Promise<MemoryEntry> {
    try {
      const user = await UserModel.getUser();

      // Check if memory exists
      const existing = await db
        .select()
        .from(memoryTable)
        .where(and(eq(memoryTable.userId, user.id), eq(memoryTable.name, name)))
        .limit(1);

      if (existing.length === 0) {
        // Create new memory
        const result = await db
          .insert(memoryTable)
          .values({
            userId: user.id,
            name,
            value,
          })
          .returning({
            id: memoryTable.id,
            name: memoryTable.name,
            value: memoryTable.value,
            createdAt: memoryTable.createdAt,
            updatedAt: memoryTable.updatedAt,
          });

        log.info(`Created new memory "${name}" for user`);
        return result[0] as MemoryEntry;
      } else {
        // Update existing memory
        const result = await db
          .update(memoryTable)
          .set({
            value,
            updatedAt: new Date().toISOString(),
          })
          .where(and(eq(memoryTable.userId, user.id), eq(memoryTable.name, name)))
          .returning({
            id: memoryTable.id,
            name: memoryTable.name,
            value: memoryTable.value,
            createdAt: memoryTable.createdAt,
            updatedAt: memoryTable.updatedAt,
          });

        log.info(`Updated memory "${name}" for user`);
        return result[0] as MemoryEntry;
      }
    } catch (error) {
      log.error(`Failed to set memory "${name}":`, error);
      throw error;
    }
  }

  /**
   * Delete a specific memory entry by name
   */
  static async deleteMemory(name: string): Promise<boolean> {
    try {
      const user = await UserModel.getUser();

      const result = await db
        .delete(memoryTable)
        .where(and(eq(memoryTable.userId, user.id), eq(memoryTable.name, name)))
        .returning();

      if (result.length === 0) {
        log.info(`Memory "${name}" not found for deletion`);
        return false;
      }

      log.info(`Deleted memory "${name}" for user`);
      return true;
    } catch (error) {
      log.error(`Failed to delete memory "${name}":`, error);
      throw error;
    }
  }

  /**
   * Delete all memory entries for the current user
   */
  static async deleteAllMemories(): Promise<number> {
    try {
      const user = await UserModel.getUser();

      const result = await db.delete(memoryTable).where(eq(memoryTable.userId, user.id)).returning();

      log.info(`Deleted ${result.length} memories for user`);
      return result.length;
    } catch (error) {
      log.error('Failed to delete all memories:', error);
      throw error;
    }
  }
}

export { SelectMemorySchema };
