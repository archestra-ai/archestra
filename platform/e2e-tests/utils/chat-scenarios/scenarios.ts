import {
  mockChatScenarios,
  megaConversationScenario,
  megaConversationStreamScenario,
  authStatesScenario,
  compactToolsScenario,
  dynamicToolScenario,
  fileVariantsScenario,
  mcpAppEarlyUiScenario,
  mixedDemoScenario,
  policyDeniedScenario,
  preexistingUnsafeScenario,
  reasoningAndTextScenario,
  swapAgentScenario,
  systemAndThinkingScenario,
  timelineErrorsScenario,
  todoApprovalScenario,
  unsafeContextScenario,
} from "./scenario-definitions";

export {
  authStatesScenario,
  compactToolsScenario,
  dynamicToolScenario,
  fileVariantsScenario,
  mcpAppEarlyUiScenario,
  megaConversationScenario,
  megaConversationStreamScenario,
  mixedDemoScenario,
  mockChatScenarios,
  policyDeniedScenario,
  preexistingUnsafeScenario,
  reasoningAndTextScenario,
  swapAgentScenario,
  systemAndThinkingScenario,
  timelineErrorsScenario,
  todoApprovalScenario,
  unsafeContextScenario,
};

export function getMockChatScenario(id: string) {
  const scenario = mockChatScenarios.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`Unknown mock chat scenario: ${id}`);
  }
  return scenario;
}
