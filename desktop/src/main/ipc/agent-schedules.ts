/**
 * IPC handlers for Agent Schedule Triggers.
 *
 * Exposes schedule CRUD and run-history queries to the renderer process.
 * Register via `registerAgentScheduleHandlers(ipcMain, store)` in main.ts.
 */

import { ipcMain, IpcMain } from "electron";
import type { AgentScheduleStore } from "../../lib/agent-schedules/store";
import type {
  CreateAgentSchedulePayload,
  UpdateAgentSchedulePayload,
} from "../../lib/agent-schedules/types";

export function registerAgentScheduleHandlers(
  ipc: IpcMain,
  store: AgentScheduleStore
): void {
  // ---------------------------------------------------------------------------
  // Schedule CRUD
  // ---------------------------------------------------------------------------

  ipc.handle(
    "agent-schedules:create",
    (_event, payload: CreateAgentSchedulePayload) => {
      return store.createSchedule(payload);
    }
  );

  ipc.handle(
    "agent-schedules:list",
    (_event, agentId: string) => {
      return store.listSchedulesForAgent(agentId);
    }
  );

  ipc.handle(
    "agent-schedules:get",
    (_event, id: string) => {
      return store.getScheduleById(id) ?? null;
    }
  );

  ipc.handle(
    "agent-schedules:update",
    (_event, id: string, payload: UpdateAgentSchedulePayload) => {
      return store.updateSchedule(id, payload) ?? null;
    }
  );

  ipc.handle(
    "agent-schedules:delete",
    (_event, id: string) => {
      return store.deleteSchedule(id);
    }
  );

  // ---------------------------------------------------------------------------
  // Run history
  // ---------------------------------------------------------------------------

  ipc.handle(
    "agent-schedules:list-runs",
    (_event, scheduleId: string, limit?: number) => {
      return store.listRunsForSchedule(scheduleId, limit);
    }
  );
}

// ---------------------------------------------------------------------------
// Renderer-side typed bridge (preload / contextBridge)
// ---------------------------------------------------------------------------

export const AGENT_SCHEDULE_IPC_CHANNELS = [
  "agent-schedules:create",
  "agent-schedules:list",
  "agent-schedules:get",
  "agent-schedules:update",
  "agent-schedules:delete",
  "agent-schedules:list-runs",
] as const;

export type AgentScheduleChannel = (typeof AGENT_SCHEDULE_IPC_CHANNELS)[number];
