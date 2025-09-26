type SupportedStaticAutonomyPolicyOperators =
  | 'equal'
  | 'notEqual'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith';

export type StaticAutonomyPolicyBase = {
  mcpServerName: string;
  toolName: string;
  description: string;
  operator: SupportedStaticAutonomyPolicyOperators;
  value: string;
  allow: boolean;
};

export interface ToolInvocationStaticAutonomyPolicy
  extends StaticAutonomyPolicyBase {
  argumentName: string;
}

export interface ToolResponseStaticAutonomyPolicy
  extends StaticAutonomyPolicyBase {
  attributePath: string;
}

export type ToolStaticAutonomyPolicy =
  | ToolInvocationStaticAutonomyPolicy
  | ToolResponseStaticAutonomyPolicy;

export type AutonomyPolicyEvaluatorResult = {
  isAllowed: boolean;
  denyReason: string;
};

export interface AutonomyPolicyEvaluator {
  evaluate():
    | Promise<AutonomyPolicyEvaluatorResult>
    | AutonomyPolicyEvaluatorResult;
}

export type SupportedDynamicAutonomyPolicyEvaluators = 'dual-llm';

export const isSupportedDynamicAutonomyPolicyEvaluator = (
  evaluator: string
): evaluator is SupportedDynamicAutonomyPolicyEvaluators => {
  return ['dual-llm'].includes(evaluator);
};

export const isToolInvocationStaticAutonomyPolicy = (
  policy: ToolStaticAutonomyPolicy
): policy is ToolInvocationStaticAutonomyPolicy => {
  return 'argumentName' in policy;
};

export const isToolResponseStaticAutonomyPolicy = (
  policy: ToolStaticAutonomyPolicy
): policy is ToolResponseStaticAutonomyPolicy => {
  return 'attributePath' in policy;
};
