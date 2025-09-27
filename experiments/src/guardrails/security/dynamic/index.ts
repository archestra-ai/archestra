import { LanguageModelV2Content } from '@ai-sdk/provider';
import { LanguageModel } from 'ai';
import {
  AutonomyPolicyEvaluator,
  DynamicAutonomyPolicyEvaluatorResult,
  SupportedDynamicAutonomyPolicyEvaluators,
} from '../types';
import DualLLMEvaluator from './dual-llm';

class DynamicAutonomyPolicyEvaluatorFactory
  implements AutonomyPolicyEvaluator<DynamicAutonomyPolicyEvaluatorResult>
{
  private evaluator: AutonomyPolicyEvaluator<DynamicAutonomyPolicyEvaluatorResult>;

  constructor(
    context: LanguageModelV2Content[],
    model: LanguageModel,
    evaluator: SupportedDynamicAutonomyPolicyEvaluators
  ) {
    if (evaluator === 'dual-llm') {
      this.evaluator = new DualLLMEvaluator(context, model);
    } else {
      throw new Error(`Evaluator ${evaluator} not supported`);
    }
  }

  evaluate() {
    return this.evaluator.evaluate();
  }
}

export default DynamicAutonomyPolicyEvaluatorFactory;
