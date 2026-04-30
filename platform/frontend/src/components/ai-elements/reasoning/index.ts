"use client";

import {
  Reasoning as RootReasoning,
  type ReasoningProps,
} from "./reasoning";
import {
  ReasoningContent,
  type ReasoningContentProps,
} from "./reasoning-content";
import {
  ReasoningTrigger,
  type ReasoningTriggerProps,
} from "./reasoning-trigger";

export type { ReasoningContentProps, ReasoningProps, ReasoningTriggerProps };

export const Reasoning = Object.assign(RootReasoning, {
  Content: ReasoningContent,
  Trigger: ReasoningTrigger,
});
