import _ from "lodash";

import type {
  AutonomyPolicyEvaluator,
  TrustedDataAutonomyPolicy,
  TrustedDataAutonomyPolicyEvaluatorResult,
} from "../types";

type ToolResultInput = {
  toolName: string;
  toolCallId: string;
  // biome-ignore lint/suspicious/noExplicitAny: tbd later
  output: any;
};

/**
 * TrustedDataPolicyEvaluator evaluates tool responses and determines if they are trusted.
 *
 * KEY SECURITY PRINCIPLE: Data is UNTRUSTED by default.
 * - Only data that explicitly matches a trusted data policy is considered safe
 * - If no policy matches, the data is considered tainted
 * - This implements an allowlist approach for maximum security
 */
class TrustedDataPolicyEvaluator
  implements AutonomyPolicyEvaluator<TrustedDataAutonomyPolicyEvaluatorResult>
{
  private toolResult: ToolResultInput;
  private policies: TrustedDataAutonomyPolicy[];

  constructor(
    toolResult: ToolResultInput,
    policies: TrustedDataAutonomyPolicy[],
  ) {
    this.toolResult = toolResult;
    this.policies = policies;
  }

  private evaluateValue(
    // biome-ignore lint/suspicious/noExplicitAny: tbd later
    value: any,
    { operator, value: policyValue }: TrustedDataAutonomyPolicy,
  ): boolean {
    switch (operator) {
      case "endsWith":
        return typeof value === "string" && value.endsWith(policyValue);
      case "startsWith":
        return typeof value === "string" && value.startsWith(policyValue);
      case "contains":
        return typeof value === "string" && value.includes(policyValue);
      case "notContains":
        return typeof value === "string" && !value.includes(policyValue);
      case "equal":
        return value === policyValue;
      case "notEqual":
        return value !== policyValue;
      case "regex":
        return typeof value === "string" && new RegExp(policyValue).test(value);
      default:
        return false;
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: tbd later
  private extractValuesFromPath(obj: any, path: string): any[] {
    // Handle wildcard paths like 'emails[*].from'
    if (path.includes("[*]")) {
      const parts = path.split("[*].");
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

  evaluate(): TrustedDataAutonomyPolicyEvaluatorResult {
    const { toolName: toolNameFromResult, output: toolResultOutput } =
      this.toolResult;

    // Find applicable policies for this tool
    const applicablePolicies = this.policies.filter(
      ({ mcpServerName, toolName }) =>
        toolNameFromResult === `${mcpServerName}__${toolName}`,
    );

    // If no policies exist for this tool, the data is UNTRUSTED by default
    if (applicablePolicies.length === 0) {
      return {
        isTrusted: false,
        trustReason: `No trust policy defined for tool ${toolNameFromResult} - data is untrusted by default`,
      };
    }

    // Check if ANY policy marks this data as trusted
    for (const policy of applicablePolicies) {
      const { attributePath, description } = policy;

      // Extract values from the tool output using the attribute path
      const outputValue = toolResultOutput?.value || toolResultOutput;
      const values = this.extractValuesFromPath(outputValue, attributePath);

      // For trusted data policies, ALL extracted values must meet the condition
      let allValuesTrusted = values.length > 0;
      for (const value of values) {
        if (!this.evaluateValue(value, policy)) {
          allValuesTrusted = false;
          break;
        }
      }

      if (allValuesTrusted) {
        // At least one policy trusts this data
        return {
          isTrusted: true,
          trustReason: `Data trusted by policy: ${description}`,
        };
      }
    }

    // No policies trust this data
    return {
      isTrusted: false,
      trustReason:
        "Data does not match any trust policies - considered tainted",
    };
  }
}

export default TrustedDataPolicyEvaluator;
