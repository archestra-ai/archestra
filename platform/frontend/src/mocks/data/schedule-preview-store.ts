// Synthetic preview data only. The local preview has no scheduler or database.

import type { ScheduleTrigger } from "@/lib/schedule-trigger.query";
import { SYNTHETIC_SCHEDULES } from "./scheduled-runs";
export type PreviewProject = {
  id: string;
  name: string;
  defaultAgentId: string | null;
};
type PreviewState = {
  projects: PreviewProject[];
  schedules: ScheduleTrigger[];
};
const KEY = "archestra-schedule-arena-created-v1";
let serverState: PreviewState = { projects: [], schedules: [] };
function read(): PreviewState {
  if (typeof window === "undefined") return serverState;
  try {
    return (
      JSON.parse(window.localStorage.getItem(KEY) ?? "null") ?? {
        projects: [],
        schedules: [],
      }
    );
  } catch {
    return { projects: [], schedules: [] };
  }
}
function write(state: PreviewState) {
  if (typeof window === "undefined") serverState = state;
  else window.localStorage.setItem(KEY, JSON.stringify(state));
}
export function previewProjects(): PreviewProject[] {
  return [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Personal workspace",
      defaultAgentId: "33333333-3333-4333-8333-333333333331",
    },
    {
      id: "11111111-1111-4111-8111-111111111112",
      name: "Team operations",
      defaultAgentId: "33333333-3333-4333-8333-333333333331",
    },
    ...read().projects,
  ];
}
export function previewSchedules() {
  return [...SYNTHETIC_SCHEDULES, ...read().schedules];
}
export function addPreviewProject(project: PreviewProject) {
  const state = read();
  state.projects.push(project);
  write(state);
  return project;
}
export function addPreviewSchedule(schedule: ScheduleTrigger) {
  const state = read();
  state.schedules.push(schedule);
  write(state);
  return schedule;
}
