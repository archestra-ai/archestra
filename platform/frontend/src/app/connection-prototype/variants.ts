import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { ConnectScenario, PrototypePersona } from "./_parts/scenarios";

export interface PrototypeVariantProps {
  scenario: ConnectScenario;
  persona: PrototypePersona;
}

interface PrototypeVariant {
  /** URL-safe id, used as `?variant=<id>`. */
  id: string;
  title: string;
  /** One line on the idea this variant tests, shown in the toolbar. */
  hypothesis: string;
  /** Live variants read real data and ignore the scenario picker. */
  data: "mock" | "live";
  Component: ComponentType<PrototypeVariantProps>;
}

// Register a variant by adding one entry. Each one is code-split, so a broken
// or heavy prototype only costs something when it is selected. Letters refer
// to the avenues in the Connect page ideation write-up.
export const PROTOTYPE_VARIANTS: PrototypeVariant[] = [
  {
    id: "today",
    title: "Today (production page)",
    hypothesis: "Baseline: the current Connect page against real data.",
    data: "live",
    Component: dynamic(() => import("./variants/today")),
  },
  {
    id: "guided-flow",
    title: "Core flow, end to end",
    hypothesis:
      "Value, pick, plan, run, prove it, all on one page feels guided, not risky.",
    data: "mock",
    Component: dynamic(() => import("./variants/guided-flow")),
  },
  {
    id: "value-hero",
    title: "A · Value hero",
    hypothesis:
      "Seeing your own tools and example asks first creates the ah-ha moment.",
    data: "mock",
    Component: dynamic(() => import("./variants/value-hero")),
  },
  {
    id: "value-beside",
    title: "A · Value beside picker",
    hypothesis: "Value stays visible next to the action instead of before it.",
    data: "mock",
    Component: dynamic(() => import("./variants/value-beside")),
  },
  {
    id: "route-compare",
    title: "B · Install routes",
    hypothesis:
      "Native command vs script vs agent prompt vs hybrid, for the same agent.",
    data: "mock",
    Component: dynamic(() => import("./variants/route-compare")),
  },
  {
    id: "plan-expanded",
    title: "D · Plan, expanded with toggles",
    hypothesis:
      "Spelling out every piece with undo builds trust before installing.",
    data: "mock",
    Component: dynamic(() => import("./variants/plan-expanded")),
  },
  {
    id: "plan-collapsed",
    title: "D · Plan, collapsed and read-only",
    hypothesis: "One command plus “what's included” on demand is enough.",
    data: "mock",
    Component: dynamic(() => import("./variants/plan-collapsed")),
  },
  {
    id: "tools-first",
    title: "D · Tools first, add-ons after",
    hypothesis: "Smallest step first, then offer add-ons once tools work.",
    data: "mock",
    Component: dynamic(() => import("./variants/tools-first")),
  },
  {
    id: "picker-groups",
    title: "C · Picker grouped by guardrails",
    hypothesis:
      "Supported / Other / n8n tabs answer “is my harness supported?”.",
    data: "mock",
    Component: dynamic(() => import("./variants/picker-groups")),
  },
  {
    id: "picker-search",
    title: "C · Searchable picker",
    hypothesis:
      "Search plus a first-class “not listed?” says any MCP agent works.",
    data: "mock",
    Component: dynamic(() => import("./variants/picker-search")),
  },
  {
    id: "context-impact",
    title: "E · Context impact",
    hypothesis:
      "Honest token numbers and a discovery mode answer “will it burn context?”.",
    data: "mock",
    Component: dynamic(() => import("./variants/context-impact")),
  },
  {
    id: "prove-it",
    title: "F · Prove it",
    hypothesis:
      "A live “waiting for your first tool call” flip plus starter prompts.",
    data: "mock",
    Component: dynamic(() => import("./variants/prove-it")),
  },
  {
    id: "my-connections",
    title: "G · My connections",
    hypothesis:
      "A return-visit home with status and a disconnect that works everywhere.",
    data: "mock",
    Component: dynamic(() => import("./variants/my-connections")),
  },
  {
    id: "personal-gateway",
    title: "H · Personal gateway",
    hypothesis: "Users pick tools inside the box an admin sets, at any scale.",
    data: "mock",
    Component: dynamic(() => import("./variants/personal-gateway")),
  },
  {
    id: "admin-adoption",
    title: "I · Admin adoption",
    hypothesis:
      "Admins see who connected, nudge the rest, and share a rollout link.",
    data: "mock",
    Component: dynamic(() => import("./variants/admin-adoption")),
  },
  {
    id: "ask-your-agent",
    title: "J · Ask your agent",
    hypothesis:
      "The agent itself explains what it's connected to and how to disconnect.",
    data: "mock",
    Component: dynamic(() => import("./variants/ask-your-agent")),
  },
  {
    id: "starter",
    title: "Starter template",
    hypothesis:
      "Template to copy: shows every mock field a variant can render.",
    data: "mock",
    Component: dynamic(() => import("./variants/starter")),
  },
];
