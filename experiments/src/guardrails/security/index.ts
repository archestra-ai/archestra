import { LanguageModel, ModelMessage } from 'ai';

import DynamicAutonomyPolicyEvaluatorFactory from './dynamic';
import StaticAutonomyPolicyEvaluator from './static';
import {
  AutonomyPolicyEvaluator,
  AutonomyPolicyEvaluatorResult,
  StaticAutonomyPolicy,
  SupportedDynamicAutonomyPolicyEvaluators,
  isSupportedDynamicAutonomyPolicyEvaluator,
} from './types';

export class ContextCredibilityEvaluator implements AutonomyPolicyEvaluator {
  private staticAutonomyPolicyEvaluator: AutonomyPolicyEvaluator;
  private dynamicAutonomyPolicyEvaluator: AutonomyPolicyEvaluator;

  constructor(
    context: ModelMessage[],
    staticAutonomyPolicies: StaticAutonomyPolicy[],
    dynamicAutonomyPolicyModel: LanguageModel,
    dynamicAutonomyPolicyEvaluator: SupportedDynamicAutonomyPolicyEvaluators
  ) {
    this.staticAutonomyPolicyEvaluator = new StaticAutonomyPolicyEvaluator(
      context,
      staticAutonomyPolicies
    );
    this.dynamicAutonomyPolicyEvaluator =
      new DynamicAutonomyPolicyEvaluatorFactory(
        context,
        dynamicAutonomyPolicyModel,
        dynamicAutonomyPolicyEvaluator
      );
  }

  async evaluate(): Promise<AutonomyPolicyEvaluatorResult> {
    const { isAllowed: isAllowedStatic, denyReason: denyReasonStatic } =
      await this.staticAutonomyPolicyEvaluator.evaluate();

    // If static evaluation fails, skip dynamic evaluation
    if (!isAllowedStatic) {
      return {
        isAllowed: false,
        denyReason: denyReasonStatic,
      };
    }

    const { isAllowed: isAllowedDynamic, denyReason: denyReasonDynamic } =
      await this.dynamicAutonomyPolicyEvaluator.evaluate();

    return {
      isAllowed: isAllowedStatic && isAllowedDynamic,
      denyReason: denyReasonStatic || denyReasonDynamic,
    };
  }
}

export {
  isSupportedDynamicAutonomyPolicyEvaluator,
  type StaticAutonomyPolicy,
  type SupportedDynamicAutonomyPolicyEvaluators,
};
