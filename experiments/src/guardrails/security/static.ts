import { ModelMessage, ToolResultPart } from 'ai';
import _ from 'lodash';

import {
  AutonomyPolicyEvaluator,
  AutonomyPolicyEvaluatorResult,
  StaticAutonomyPolicy,
} from './types';

class StaticAutonomyPolicyEvaluator implements AutonomyPolicyEvaluator {
  private context: ModelMessage[];
  private policies: StaticAutonomyPolicy[];

  constructor(context: ModelMessage[], policies: StaticAutonomyPolicy[]) {
    this.context = context;
    this.policies = policies;
  }

  private evaluateValue(
    value: any,
    policy: StaticAutonomyPolicy
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
      // So we return true (allowed) when condition is met
      return {
        isAllowed: conditionMet,
        denyReason: conditionMet
          ? ''
          : `Policy violation: ${policy.description}`,
      };
    } else {
      // Policy says "deny" when condition is met
      // So we return false (not allowed) when condition is met
      return {
        isAllowed: !conditionMet,
        denyReason: conditionMet
          ? `Policy violation: ${policy.description}`
          : '',
      };
    }
  }

  private extractValuesFromPath(obj: any, path: string): any[] {
    // Handle wildcard paths like 'emails[*].from'
    if (path.includes('[*]')) {
      const parts = path.split('[*].');
      const arrayPath = parts[0];
      const itemPath = parts[1];

      const array = _.get(obj, arrayPath);
      if (!Array.isArray(array)) {
        return [];
      }

      return array
        .map((item) => _.get(item, itemPath))
        .filter((v) => v !== undefined);
    } else {
      // Simple path without wildcards
      const value = _.get(obj, path);
      return value !== undefined ? [value] : [];
    }
  }

  evaluate(): AutonomyPolicyEvaluatorResult {
    // Extract tool results from messages
    const toolMessages = this.context.filter(
      (message) => message.role === 'tool'
    );

    for (const message of toolMessages) {
      if (!Array.isArray(message.content)) continue;

      for (const content of message.content) {
        if (content.type !== 'tool-result') continue;

        const toolResult = content as ToolResultPart;

        // Find applicable policies for this tool
        const applicablePolicies = this.policies.filter(
          ({ mcpServerName, toolName }) =>
            toolResult.toolName === `${mcpServerName}__${toolName}`
        );

        for (const policy of applicablePolicies) {
          // Extract values from the tool output using the attribute path
          const outputValue = toolResult.output?.value || toolResult.output;
          const values = this.extractValuesFromPath(
            outputValue,
            policy.attribute
          );

          if (policy.allow) {
            // For "allow" policies, ALL values must meet the condition
            let allMeetCondition = true;
            for (const value of values) {
              const result = this.evaluateValue(value, policy);
              if (!result.isAllowed) {
                allMeetCondition = false;
                break;
              }
            }
            if (!allMeetCondition) {
              return {
                isAllowed: false,
                denyReason: `Policy violation: ${policy.description} - not all values meet the condition`,
              };
            }
          } else {
            // For "deny" policies, ANY value meeting the condition triggers denial
            for (const value of values) {
              const result = this.evaluateValue(value, policy);
              if (!result.isAllowed) {
                return result;
              }
            }
          }
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

export default StaticAutonomyPolicyEvaluator;
