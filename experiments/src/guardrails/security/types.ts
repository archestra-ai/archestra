export type StaticAutonomyPolicy = {
  mcpServerName: string;
  toolName: string;
  description: string;
  attribute: string;
  operator:
    | 'equal'
    | 'notEqual'
    | 'contains'
    | 'notContains'
    | 'startsWith'
    | 'endsWith';
  value: string;
  allow: boolean;
};

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
