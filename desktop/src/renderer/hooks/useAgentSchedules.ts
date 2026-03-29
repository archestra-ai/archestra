/**
 * React hook for managing agent schedule triggers from the renderer process.
 */

import { useState, useEffect, useCallback } from "react";
import type {
  AgentSchedule,
  AgentScheduleRun,
  CreateAgentSchedulePayload,
  UpdateAgentSchedulePayload,
} from "../../lib/agent-schedules/types";

// window.electronAPI is exposed via the preload contextBridge
declare global {
  interface Window {
    electronAPI: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    };
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return window.electronAPI.invoke(channel, ...args) as Promise<T>;
}

// ---------------------------------------------------------------------------
// useAgentSchedules
// ---------------------------------------------------------------------------

export interface UseAgentSchedulesReturn {
  schedules: AgentSchedule[];
  loading: boolean;
  error: string | null;
  createSchedule: (payload: CreateAgentSchedulePayload) => Promise<AgentSchedule>;
  updateSchedule: (id: string, payload: UpdateAgentSchedulePayload) => Promise<AgentSchedule | null>;
  deleteSchedule: (id: string) => Promise<boolean>;
  pauseSchedule: (id: string) => Promise<AgentSchedule | null>;
  resumeSchedule: (id: string) => Promise<AgentSchedule | null>;
  refresh: () => Promise<void>;
}

export function useAgentSchedules(agentId: string): UseAgentSchedulesReturn {
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await invoke<AgentSchedule[]>("agent-schedules:list", agentId);
      setSchedules(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createSchedule = useCallback(
    async (payload: CreateAgentSchedulePayload): Promise<AgentSchedule> => {
      const schedule = await invoke<AgentSchedule>("agent-schedules:create", payload);
      setSchedules((prev) => [schedule, ...prev]);
      return schedule;
    },
    []
  );

  const updateSchedule = useCallback(
    async (id: string, payload: UpdateAgentSchedulePayload): Promise<AgentSchedule | null> => {
      const updated = await invoke<AgentSchedule | null>("agent-schedules:update", id, payload);
      if (updated) {
        setSchedules((prev) => prev.map((s) => (s.id === id ? updated : s)));
      }
      return updated;
    },
    []
  );

  const deleteSchedule = useCallback(async (id: string): Promise<boolean> => {
    const ok = await invoke<boolean>("agent-schedules:delete", id);
    if (ok) {
      setSchedules((prev) => prev.filter((s) => s.id !== id));
    }
    return ok;
  }, []);

  const pauseSchedule = useCallback(
    (id: string) => updateSchedule(id, { status: "paused" }),
    [updateSchedule]
  );

  const resumeSchedule = useCallback(
    (id: string) => updateSchedule(id, { status: "active" }),
    [updateSchedule]
  );

  return {
    schedules,
    loading,
    error,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    pauseSchedule,
    resumeSchedule,
    refresh,
  };
}

// ---------------------------------------------------------------------------
// useAgentScheduleRuns
// ---------------------------------------------------------------------------

export function useAgentScheduleRuns(scheduleId: string, limit = 50) {
  const [runs, setRuns] = useState<AgentScheduleRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await invoke<AgentScheduleRun[]>(
        "agent-schedules:list-runs",
        scheduleId,
        limit
      );
      setRuns(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load runs");
    } finally {
      setLoading(false);
    }
  }, [scheduleId, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { runs, loading, error, refresh };
}
