import { randomUUID } from "node:crypto";
import type { InsertAgent } from "@/types/agent";
import { randomBool } from "./utils";

export const AGENT_NAMES = [
  "Data Analyst",
  "API Monitor",
  "Security Scanner",
  "Performance Optimizer",
  "Code Reviewer",
];

/**
 * Generate mock agent data
 */
export function generateMockAgents(
  names: string[] = AGENT_NAMES,
): InsertAgent[] {
  return names.map((name) => ({
    id: randomUUID(),
    name,
    isDemo: randomBool(), // Randomly mark some as demo
    createdAt: new Date(),
    updatedAt: new Date(),
    teams: [],
  }));
}
