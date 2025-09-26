import {
  SupportedDynamicAutonomyPolicyEvaluators,
  isSupportedDynamicAutonomyPolicyEvaluator,
} from './security';

const parseDynamicAutonomyPolicyEvaluatorTypeArg =
  (): SupportedDynamicAutonomyPolicyEvaluators => {
    let dynamicAutonomyPolicyEvaluatorType: SupportedDynamicAutonomyPolicyEvaluators;

    const dynamicAutonomyPolicyEvaluatorTypeArg = process.argv
      .find((arg) => arg === '--dynamic-autonomy-policy-evaluator-type')
      ?.split('=')[1];

    if (
      dynamicAutonomyPolicyEvaluatorTypeArg &&
      !isSupportedDynamicAutonomyPolicyEvaluator(
        dynamicAutonomyPolicyEvaluatorTypeArg
      )
    ) {
      throw new Error(
        'Dynamic autonomy policy evaluator type is not supported'
      );
    } else {
      dynamicAutonomyPolicyEvaluatorType = 'dual-llm';
    }

    return dynamicAutonomyPolicyEvaluatorType;
  };

const printHelp = () => {
  console.log('Usage: pnpm cli-chat-with-guardrails [options]\n');
  console.log('Options:');
  console.log(
    '--dynamic-autonomy-policy-evaluator-type=TYPE - The type of dynamic autonomy policy evaluator to use (default: dual-llm)'
  );
  console.log(
    '--include-external-email - Include external email in mock Gmail data'
  );
  console.log(
    '--include-malicious-email - Include malicious email in mock Gmail data'
  );
  console.log('--help - Print this help message');
};

const parseArgs = (): {
  dynamicAutonomyPolicyEvaluatorType: SupportedDynamicAutonomyPolicyEvaluators;
  includeExternalEmail: boolean;
  includeMaliciousEmail: boolean;
} => {
  if (process.argv.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const dynamicAutonomyPolicyEvaluatorType =
    parseDynamicAutonomyPolicyEvaluatorTypeArg();

  return {
    dynamicAutonomyPolicyEvaluatorType,
    includeExternalEmail: process.argv.includes('--include-external-email'),
    includeMaliciousEmail: process.argv.includes('--include-malicious-email'),
  };
};

export default parseArgs;
