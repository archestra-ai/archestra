import { UI_BASE_URL } from "../../consts";
import type { MockChatScenario } from "./types";

export function getMockChatStreamUrl(): string {
  return `${UI_BASE_URL}/api/chat-demo`;
}

export function buildMockChatStreamBody(params: {
  requestBody: unknown;
  scenario: MockChatScenario;
}): string {
  const body =
    typeof params.requestBody === "string"
      ? JSON.parse(params.requestBody)
      : params.requestBody;

  return JSON.stringify({
    ...(typeof body === "object" && body !== null ? body : {}),
    __mockScenario: params.scenario,
  });
}
