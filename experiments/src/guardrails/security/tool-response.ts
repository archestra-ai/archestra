import _ from 'lodash';

import {
  AutonomyPolicyEvaluator,
  ToolResponseStaticAutonomyPolicy,
  ToolResponseStaticAutonomyPolicyEvaluatorResult,
} from './types';

type ToolResultInput = {
  toolName: string;
  toolCallId: string;
  output: any;
};

/**
 * StaticToolResponsePolicyEvaluator evalutes all tool responses in the current context
 * and based on the defined `policies` (static autonomy policies) and determines whether
 * or not the context has been "tainted" (ie. untrusted data has been introduced)
 */
class StaticToolResponsePolicyEvaluator
  implements
    AutonomyPolicyEvaluator<ToolResponseStaticAutonomyPolicyEvaluatorResult>
{
  private toolResult: ToolResultInput;
  private policies: ToolResponseStaticAutonomyPolicy[];

  constructor(
    toolResult: ToolResultInput,
    policies: ToolResponseStaticAutonomyPolicy[]
  ) {
    this.toolResult = toolResult;
    this.policies = policies;
  }

  private evaluateValue(
    value: any,
    {
      operator,
      value: policyValue,
      description,
      trusted,
    }: ToolResponseStaticAutonomyPolicy
  ): ToolResponseStaticAutonomyPolicyEvaluatorResult {
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

    if (trusted) {
      // Policy says the data is trusted when condition is met
      return {
        isTainted: conditionMet,
        taintedReason: conditionMet ? '' : `Policy violation: ${description}`,
      };
    } else {
      // Policy says the data is tainted when condition is met
      return {
        isTainted: !conditionMet,
        taintedReason: conditionMet ? `Policy violation: ${description}` : '',
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

  evaluate(): ToolResponseStaticAutonomyPolicyEvaluatorResult {
    const { toolName: toolNameFromResult, output: toolResultOutput } =
      this.toolResult;

    // Find applicable policies for this tool
    const applicablePolicies = this.policies.filter(
      ({ mcpServerName, toolName }) =>
        toolNameFromResult === `${mcpServerName}__${toolName}`
    );

    for (const policy of applicablePolicies) {
      const { attributePath, description, trusted } = policy;

      // Extract values from the tool output using the attribute path
      const outputValue = toolResultOutput?.value || toolResultOutput;
      const values = this.extractValuesFromPath(outputValue, attributePath);

      if (trusted) {
        // For "trusted" policies, ALL values must meet the condition
        let allMeetCondition = true;
        for (const value of values) {
          const result = this.evaluateValue(value, policy);
          if (!result.isTainted) {
            allMeetCondition = false;
            break;
          }
        }
        if (!allMeetCondition) {
          return {
            isTainted: false,
            taintedReason: `Policy violation: ${description} - not all values meet the condition`,
          };
        }
      } else {
        // For "tainted" policies, ANY value meeting the condition triggers tainting
        for (const value of values) {
          const result = this.evaluateValue(value, policy);
          if (!result.isTainted) {
            return result;
          }
        }
      }
    }

    // All policies passed
    return {
      isTainted: false,
      taintedReason: '',
    };
  }
}

export default StaticToolResponsePolicyEvaluator;
