import { LanguageModel, ModelMessage } from 'ai';
import {
  AutonomyPolicyEvaluator,
  AutonomyPolicyEvaluatorResult,
  SupportedDynamicAutonomyPolicyEvaluators,
} from '../types';
import DualLLMEvaluator from './dual-llm';

class DynamicAutonomyPolicyEvaluatorFactory implements AutonomyPolicyEvaluator {
  private evaluator: AutonomyPolicyEvaluator;

  constructor(
    context: ModelMessage[],
    model: LanguageModel,
    evaluator: SupportedDynamicAutonomyPolicyEvaluators
  ) {
    if (evaluator === 'dual-llm') {
      this.evaluator = new DualLLMEvaluator(context, model);
    } else {
      throw new Error(`Evaluator ${evaluator} not supported`);
    }
  }

  evaluate():
    | Promise<AutonomyPolicyEvaluatorResult>
    | AutonomyPolicyEvaluatorResult {
    return this.evaluator.evaluate();
  }
}

export default DynamicAutonomyPolicyEvaluatorFactory;
