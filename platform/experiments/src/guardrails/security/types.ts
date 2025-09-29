type SupportedAutonomyPolicyOperators =
  | 'equal'
  | 'notEqual'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'regex';

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

export type SupportedDynamicAutonomyPolicyEvaluators = 'dual-llm';

export const isSupportedDynamicAutonomyPolicyEvaluator = (
  evaluator: string
): evaluator is SupportedDynamicAutonomyPolicyEvaluators => {
  return ['dual-llm'].includes(evaluator);
};

// Taint tracking for tool responses
export interface TaintedContext {
  toolCallId: string;
  toolName: string;
  isTainted: boolean;
  taintReason?: string;
  output?: any;
}

// Result from quarantined LLM analysis
export interface QuarantineAnalysisResult {
  summary: string; // Structured summary, not raw content
  hasPromptInjection: boolean;
  injectionType?:
    | 'direct_command'
    | 'social_engineering'
    | 'context_manipulation'
    | 'unknown';
  confidence: number; // 0-1 confidence score
  extractedIntent?: string; // What the injection is trying to do
}

// Final security decision from privileged LLM
export interface PrivilegedDecision {
  isAllowed: boolean;
  denyReason?: string;
  requiresUserConfirmation?: boolean;
  suggestedAction?: string;
}
