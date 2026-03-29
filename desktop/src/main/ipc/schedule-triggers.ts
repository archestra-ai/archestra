/**
 * IPC handlers for agent schedule triggers.
 * Registered in the Electron main process.
 */

import { ipcMain } from "electron";
import Database from "better-sqlite3";
import {
  createScheduleTrigger,
  getScheduleTriggerById,
  getScheduleTriggersByAgentId,
  getAllActiveScheduleTriggers,
  updateScheduleTrigger,
  deleteScheduleTrigger,
  getRunLogsByTriggerId,
} from "../../lib/agent-scheduler/db";
import {
  CreateAgentScheduleTriggerInput,
  UpdateAgentScheduleTriggerInput,
} from "../../lib/agent-scheduler/types";
import { getScheduler } from "../../lib/agent-scheduler/scheduler";

export const SCHEDULE_TRIGGER_CHANNELS = {
  CREATE: "schedule-triggers:create",
  GET_BY_ID: "schedule-triggers:get-by-id",
  GET_BY_AGENT: "schedule-triggers:get-by-agent",
  GET_ALL_ACTIVE: "schedule-triggers:get-all-active",
  UPDATE: "schedule-triggers:update",
  DELETE: "schedule-triggers:delete",
  PAUSE: "schedule-triggers:pause",
  RESUME: "schedule-triggers:resume",
  GET_RUN_LOGS: "schedule-triggers:get-run-logs",
  FIRE_NOW: "schedule-triggers:fire-now",
} as const;

export function registerScheduleTriggerIpcHandlers(
  db: Database.Database
): void {
  ipcMain.handle(
    SCHEDULE_TRIGGER_CHANNELS.CREATE,
    async (_event, input: CreateAgentScheduleTriggerInput) => {
      return createScheduleTrigger(db, input);
    }
  );

  ipcMain.handle(
    SCHEDULE_TRIGGER_CHANNELS.GET_BY_ID,
    async (_event, id: string) => {
      return getScheduleTriggerById(db, id);
    }
  );

  ipcMain.handle(
    SCHEDULE_TRIGGER_CHANNELS.GET_BY_AGENT,
    async (_event, agentId: string) => {
      return getScheduleTriggersByAgentId(db, agentId);
    }
  );

  ipcMain.handle(SCHEDULE_TRIGGER_CHANNELS.GET_ALL_ACTIVE, async () => {
    return getAllActiveScheduleTriggers(db);
  });

  ipcMain.handle(
    SCHEDULE_TRIGGER_CHANNELS.UPDATE,
    async (
      _event,
      id: string,
      input: UpdateAgentScheduleTriggerInput
    ) => {
      return updateScheduleTrigger(db, id, input);
    }
  );

  ipcMain.handle(
    SCHEDULE_TRIGGER_CHANNELS.DELETE,
    async (_event, id: string) => {
      return deleteScheduleTrigger(db, id);
    }
  );

  ipcMain.handle(
    SCHEDULE_TRIGGER_CHANNELS.PAUSE,
    async (_event, id: string) => {
      return updateScheduleTrigger(db, id, { status: "paused" });
    }
  );

  ipcMain.handle(
    SCHEDULE_TRIGGER_CHANNELS.RESUME,
    async (_event, id: string) => {
      return updateScheduleTrigger(db, id, { status: "active" });
    }
  );

  ipcMain.handle(
    SCHEDULE_TRIGGER_CHANNELS.GET_RUN_LOGS,
    async (_event, triggerId: string, limit?: number) => {
      return getRunLogsByTriggerId(db, triggerId, limit);
    }
  );

  /**
   * Manually fire a trigger immediately (for testing / "run now" UI).
   */
  ipcMain.handle(
    SCHEDULE_TRIGGER_CHANNELS.FIRE_NOW,
    async (_event, triggerId: string) => {
      const scheduler = getScheduler();
      if (!scheduler) {
        throw new Error("Scheduler is not running");
      }
      const trigger = getScheduleTriggerById(db, triggerId);
      if (!trigger) {
        throw new Error(`Trigger ${triggerId} not found`);
      }
      // Force a tick limited to this trigger
      await (scheduler as any).fireTrigger(trigger);
      return getScheduleTriggerById(db, triggerId);
    }
  );
}
