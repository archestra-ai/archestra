import _ from 'lodash';

import {
  AutonomyPolicyEvaluator,
  ToolInvocationStaticAutonomyPolicy,
  ToolInvocationStaticAutonomyPolicyEvaluatorResult,
} from './types';

type ToolCallInput = {
  toolName: string;
  toolCallId: string;
  input: Record<string, any>;
};

class StaticToolInvocationPolicyEvaluator
  implements
    AutonomyPolicyEvaluator<ToolInvocationStaticAutonomyPolicyEvaluatorResult>
{
  private toolCall: ToolCallInput;
  private policies: ToolInvocationStaticAutonomyPolicy[];

  constructor(
    toolCall: ToolCallInput,
    policies: ToolInvocationStaticAutonomyPolicy[]
  ) {
    this.toolCall = toolCall;
    this.policies = policies;
  }

  private evaluateValue(
    value: any,
    {
      operator,
      value: policyValue,
      description,
      allow,
    }: ToolInvocationStaticAutonomyPolicy
  ): ToolInvocationStaticAutonomyPolicyEvaluatorResult {
    let conditionMet = false;

    switch (operator) {
      case 'endsWith':
        conditionMet = typeof value === 'string' && value.endsWith(policyValue);
        break;
      case 'startsWith':
        conditionMet =
          typeof value === 'string' && value.startsWith(policyValue);
        break;
      case 'contains':
        conditionMet = typeof value === 'string' && value.includes(policyValue);
        break;
      case 'notContains':
        conditionMet =
          typeof value === 'string' && !value.includes(policyValue);
        break;
      case 'equal':
        conditionMet = value === policyValue;
        break;
      case 'notEqual':
        conditionMet = value !== policyValue;
        break;
    }

    // Apply the allow/deny logic
    if (allow) {
      // Policy says "allow" when condition is met
      return {
        isAllowed: conditionMet,
        denyReason: conditionMet ? '' : `Policy violation: ${description}`,
      };
    } else {
      // Policy says "deny" when condition is met
      return {
        isAllowed: !conditionMet,
        denyReason: conditionMet ? `Policy violation: ${description}` : '',
      };
    }
  }

  evaluate(): ToolInvocationStaticAutonomyPolicyEvaluatorResult {
    const { toolName: toolNameFromCall, input: toolCallInput } = this.toolCall;

    // Find applicable policies for this tool
    const applicablePolicies = this.policies.filter(
      ({ mcpServerName, toolName }) =>
        toolNameFromCall === `${mcpServerName}__${toolName}`
    );

    for (const policy of applicablePolicies) {
      const { argumentName, allow } = policy;

      // Extract the argument value
      const argumentValue = _.get(toolCallInput, argumentName);

      if (argumentValue === undefined) {
        // If the argument doesn't exist and we have a deny policy, that's okay
        if (!allow) {
          continue;
        }
        // If it's an allow policy and the argument is missing, that's a problem
        return {
          isAllowed: false,
          denyReason: `Missing required argument: ${argumentName}`,
        };
      }

      const result = this.evaluateValue(argumentValue, policy);
      if (!result.isAllowed) {
        return result;
      }
    }

    // All policies passed
    return {
      isAllowed: true,
      denyReason: '',
    };
  }
}

export default StaticToolInvocationPolicyEvaluator;
