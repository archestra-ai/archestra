import { z } from "zod";

type SupportedAutonomyPolicyOperators =
  | "equal"
  | "notEqual"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "regex";

export type ToolInvocationAutonomyPolicy = {
  mcpServerName: string;
  toolName: string;
  description: string;
  operator: SupportedAutonomyPolicyOperators;
  value: string;
  argumentName: string;
  allow: boolean;
};

export type ToolInvocationAutonomyPolicyEvaluatorResult = {
  isAllowed: boolean;
  denyReason: string;
};

export type TrustedDataAutonomyPolicy = {
  mcpServerName: string;
  toolName: string;
  description: string;
  operator: SupportedAutonomyPolicyOperators;
  value: string;
  attributePath: string;
};

export type TrustedDataAutonomyPolicyEvaluatorResult = {
  isTrusted: boolean;
  trustReason: string;
};

export type DynamicAutonomyPolicyEvaluatorResult = {
  isAllowed: boolean;
  denyReason: string;
};

export interface AutonomyPolicyEvaluator<R> {
  evaluate(): Promise<R> | R;
}

export const ToolCallContentSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  role: z.string().optional(),
  output: z.any().optional(),
  content: z.any().optional(),
});

export type ToolCallContent = z.infer<typeof ToolCallContentSchema>;

export type TaintedInteractionData = {
  toolCallId: string;
  toolName: string;
  isTainted: boolean;
  taintReason: string | null;
  // biome-ignore lint/suspicious/noExplicitAny: tbd later
  output: any;
};
