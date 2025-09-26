import { ToolCallPart } from 'ai';
import _ from 'lodash';

import {
  AutonomyPolicyEvaluator,
  AutonomyPolicyEvaluatorResult,
  isToolInvocationStaticAutonomyPolicy,
  ToolInvocationStaticAutonomyPolicy,
  ToolStaticAutonomyPolicy,
} from '../types';

class StaticInvocationPolicyEvaluator implements AutonomyPolicyEvaluator {
  private toolCalls: ToolCallPart[];
  private policies: ToolInvocationStaticAutonomyPolicy[];

  constructor(toolCalls: ToolCallPart[], policies: ToolStaticAutonomyPolicy[]) {
    this.toolCalls = toolCalls;
    // Filter to only invocation policies
    this.policies = policies.filter(isToolInvocationStaticAutonomyPolicy);
  }

  private evaluateValue(
    value: any,
    policy: ToolInvocationStaticAutonomyPolicy
  ): AutonomyPolicyEvaluatorResult {
    let conditionMet = false;

    switch (policy.operator) {
      case 'endsWith':
        conditionMet =
          typeof value === 'string' && value.endsWith(policy.value);
        break;
      case 'startsWith':
        conditionMet =
          typeof value === 'string' && value.startsWith(policy.value);
        break;
      case 'contains':
        conditionMet =
          typeof value === 'string' && value.includes(policy.value);
        break;
      case 'notContains':
        conditionMet =
          typeof value === 'string' && !value.includes(policy.value);
        break;
      case 'equal':
        conditionMet = value === policy.value;
        break;
      case 'notEqual':
        conditionMet = value !== policy.value;
        break;
    }

    // Apply the allow/deny logic
    if (policy.allow) {
      // Policy says "allow" when condition is met
      return {
        isAllowed: conditionMet,
        denyReason: conditionMet
          ? ''
          : `Policy violation: ${policy.description}`,
      };
    } else {
      // Policy says "deny" when condition is met
      return {
        isAllowed: !conditionMet,
        denyReason: conditionMet
          ? `Policy violation: ${policy.description}`
          : '',
      };
    }
  }

  evaluate(): AutonomyPolicyEvaluatorResult {
    // Check each tool call against applicable policies
    for (const toolCall of this.toolCalls) {
      // Find applicable policies for this tool
      const applicablePolicies = this.policies.filter(
        ({ mcpServerName, toolName }) =>
          toolCall.toolName === `${mcpServerName}__${toolName}`
      );

      for (const policy of applicablePolicies) {
        // Parse the input if it's a string
        const input =
          typeof toolCall.input === 'string'
            ? JSON.parse(toolCall.input)
            : toolCall.input;

        // Extract the argument value
        const argumentValue = _.get(input, policy.argumentName);

        if (argumentValue === undefined) {
          // If the argument doesn't exist and we have a deny policy, that's okay
          if (!policy.allow) {
            continue;
          }
          // If it's an allow policy and the argument is missing, that's a problem
          return {
            isAllowed: false,
            denyReason: `Missing required argument: ${policy.argumentName}`,
          };
        }

        const result = this.evaluateValue(argumentValue, policy);
        if (!result.isAllowed) {
          return result;
        }
      }
    }

    // All policies passed
    return {
      isAllowed: true,
      denyReason: '',
    };
  }
}

export default StaticInvocationPolicyEvaluator;
