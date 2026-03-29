/**
 * Preload-side API for agent schedule triggers.
 * Exposed on window.scheduleTriggers via contextBridge.
 */

import { ipcRenderer } from "electron";
import { SCHEDULE_TRIGGER_CHANNELS } from "../main/ipc/schedule-triggers";
import type {
  AgentScheduleTrigger,
  CreateAgentScheduleTriggerInput,
  UpdateAgentScheduleTriggerInput,
  ScheduleTriggerRunLog,
} from "../lib/agent-scheduler/types";

export const scheduleTriggersBridge = {
  create: (
    input: CreateAgentScheduleTriggerInput
  ): Promise<AgentScheduleTrigger> =>
    ipcRenderer.invoke(SCHEDULE_TRIGGER_CHANNELS.CREATE, input),

  getById: (id: string): Promise<AgentScheduleTrigger | null> =>
    ipcRenderer.invoke(SCHEDULE_TRIGGER_CHANNELS.GET_BY_ID, id),

  getByAgentId: (agentId: string): Promise<AgentScheduleTrigger[]> =>
    ipcRenderer.invoke(SCHEDULE_TRIGGER_CHANNELS.GET_BY_AGENT, agentId),

  getAllActive: (): Promise<AgentScheduleTrigger[]> =>
    ipcRenderer.invoke(SCHEDULE_TRIGGER_CHANNELS.GET_ALL_ACTIVE),

  update: (
    id: string,
    input: UpdateAgentScheduleTriggerInput
  ): Promise<AgentScheduleTrigger | null> =>
    ipcRenderer.invoke(SCHEDULE_TRIGGER_CHANNELS.UPDATE, id, input),

  delete: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(SCHEDULE_TRIGGER_CHANNELS.DELETE, id),

  pause: (id: string): Promise<AgentScheduleTrigger | null> =>
    ipcRenderer.invoke(SCHEDULE_TRIGGER_CHANNELS.PAUSE, id),

  resume: (id: string): Promise<AgentScheduleTrigger | null> =>
    ipcRenderer.invoke(SCHEDULE_TRIGGER_CHANNELS.RESUME, id),

  getRunLogs: (
    triggerId: string,
    limit?: number
  ): Promise<ScheduleTriggerRunLog[]> =>
    ipcRenderer.invoke(SCHEDULE_TRIGGER_CHANNELS.GET_RUN_LOGS, triggerId, limit),

  fireNow: (triggerId: string): Promise<AgentScheduleTrigger | null> =>
    ipcRenderer.invoke(SCHEDULE_TRIGGER_CHANNELS.FIRE_NOW, triggerId),
};

export type ScheduleTriggersBridge = typeof scheduleTriggersBridge;
