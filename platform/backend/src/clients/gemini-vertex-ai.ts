/**
 * Whether Gemini runs on Vertex AI. Kept apart from gemini-client.ts, which
 * loads the Google GenAI SDK, so that model resolution can read the setting
 * without the SDK.
 */
import config from "@/config";

/** Check if Vertex AI mode is enabled */
export function isVertexAiEnabled(): boolean {
  return config.llm.gemini.vertexAi.enabled;
}
