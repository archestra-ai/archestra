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
    evaluator: SupportedDynamicAutonomyPolicyEvaluators,
    sessionId: string,
    model: LanguageModel
  ) {
    if (evaluator === 'dual-llm') {
      this.evaluator = new DualLLMEvaluator(sessionId, model);
    } else {
      throw new Error(`Evaluator ${evaluator} not supported`);
    }
  }

  evaluate() {
    return this.evaluator.evaluate();
  }
}

export default DynamicAutonomyPolicyEvaluatorFactory;
