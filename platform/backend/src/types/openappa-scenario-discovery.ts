import { z } from "zod";
export const DiscoverOpenAppaScenariosSchema = z.strictObject({});
export const SelectOpenAppaScenarioSchema = z.strictObject({
  discoveryId: z.string().uuid(),
  candidateId: z.string().min(1).max(80),
});
export type OpenAppaScenarioDiscovery = {
  discoveryId: string;
  status: "ready" | "setup_required" | "unavailable";
  message: string;
  scope: string;
  evaluated: number;
  limited: boolean;
  candidates: {
    id: string;
    tool: string;
    arguments: Record<string, unknown>;
    decision: "allow" | "deny";
    content: string;
    existingFiles: string[];
  }[];
  unavailable: {
    tool: string;
    kind: "needs_input" | "cannot_run";
    reason: string;
  }[];
};
