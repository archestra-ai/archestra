type SupportedStaticAutonomyPolicyOperators =
  | 'equal'
  | 'notEqual'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith';

type StaticAutonomyPolicyBase = {
  mcpServerName: string;
  toolName: string;
  description: string;
  operator: SupportedStaticAutonomyPolicyOperators;
  value: string;
};

export interface ToolInvocationStaticAutonomyPolicy
  extends StaticAutonomyPolicyBase {
  argumentName: string;
  allow: boolean;
}

export type ToolInvocationStaticAutonomyPolicyEvaluatorResult = {
  isAllowed: boolean;
  denyReason: string;
};

export interface ToolResponseStaticAutonomyPolicy
  extends StaticAutonomyPolicyBase {
  attributePath: string;
  trusted: boolean;
}

export type ToolResponseStaticAutonomyPolicyEvaluatorResult = {
  isTainted: boolean;
  taintedReason: string;
};

export type DynamicAutonomyPolicyEvaluatorResult = {
  isAllowed: boolean;
  denyReason: string;
};

export interface AutonomyPolicyEvaluator<R> {
  evaluate(): Promise<R> | R;
}

export type SupportedDynamicAutonomyPolicyEvaluators = 'dual-llm';

export const isSupportedDynamicAutonomyPolicyEvaluator = (
  evaluator: string
): evaluator is SupportedDynamicAutonomyPolicyEvaluators => {
  return ['dual-llm'].includes(evaluator);
};
