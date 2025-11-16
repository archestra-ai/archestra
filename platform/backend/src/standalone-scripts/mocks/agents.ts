import { randomUUID } from "node:crypto";
import type { InsertAgent } from "@/types";
import { randomBool, randomElement } from "./utils";

const AGENT_NAME_TEMPLATES = [
  "Data Analyst",
  "API Monitor",
  "Security Scanner",
  "Performance Optimizer",
  "Code Reviewer",
  "Content Moderator",
  "Quality Assurance",
  "System Administrator",
  "Database Manager",
  "Network Engineer",
  "Cloud Architect",
  "DevOps Specialist",
  "Frontend Developer",
  "Backend Developer",
  "Full Stack Engineer",
  "Machine Learning Engineer",
  "Data Scientist",
  "Automation Specialist",
  "Integration Expert",
  "Support Agent",
];

const AGENT_SUFFIXES = [
  "",
  " Pro",
  " Advanced",
  " Enterprise",
  " Plus",
  " AI",
  " Assistant",
  " Bot",
  " v2",
  " Next",
];

/**
 * Generate a unique agent name by combining templates and suffixes
 */
function generateAgentName(index: number): string {
  const template = randomElement(AGENT_NAME_TEMPLATES);
  const suffix =
    index < AGENT_NAME_TEMPLATES.length * 3
      ? randomElement(AGENT_SUFFIXES)
      : ` #${Math.floor(index / 10) + 1}`;
  return `${template}${suffix}`;
}

type MockAgent = InsertAgent & { id: string };

/**
 * Generate mock agent data
 * @param count - Number of agents to generate (defaults to 90)
 */
export function generateMockAgents(count = 90): MockAgent[] {
  const agents: MockAgent[] = [];

  for (let i = 0; i < count; i++) {
    agents.push({
      id: randomUUID(),
      name: generateAgentName(i),
      isDemo: randomBool(0.3), // 30% chance of being a demo agent
      teams: [],
    });
  }

  return agents;
}
