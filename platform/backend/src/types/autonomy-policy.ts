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
