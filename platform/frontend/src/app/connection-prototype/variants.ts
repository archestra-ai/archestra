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
// or heavy prototype only costs something when it is selected.
export const PROTOTYPE_VARIANTS: PrototypeVariant[] = [
  {
    id: "today",
    title: "Today (production page)",
    hypothesis: "Baseline: the current Connect page against real data.",
    data: "live",
    Component: dynamic(() => import("./variants/today")),
  },
  {
    id: "starter",
    title: "Starter",
    hypothesis:
      "Template to copy: shows every mock field a variant can render.",
    data: "mock",
    Component: dynamic(() => import("./variants/starter")),
  },
];
