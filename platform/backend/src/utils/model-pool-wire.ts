import { isModelPoolProvider, type SupportedProvider } from "@archestra/shared";

/** The request formats a pool can carry a request in. */
export type PoolWire =
  | "openai-chat"
  | "openai-responses"
  | "anthropic"
  | "bedrock-converse"
  | "gemini";

export function providerChatWire(provider: SupportedProvider): PoolWire | null {
  if (!isModelPoolProvider(provider)) return null;
  if (provider === "anthropic") return "anthropic";
  if (provider === "bedrock") return "bedrock-converse";
  if (provider === "gemini") return "gemini";
  return "openai-chat";
}

/** Whether a client on `inbound` can be answered by a member on `provider`. */
export function canReachMember(
  inbound: PoolWire,
  provider: SupportedProvider,
): boolean {
  if (inbound === "openai-responses")
    return (
      provider === "openai" ||
      provider === "azure" ||
      provider === "github-copilot"
    );
  const target = providerChatWire(provider);
  if (!target) return false;
  return target === inbound || TRANSLATED.has(`${inbound}>${target}`);
}

/** Wire pairs a translator connects, as `inbound>member`. */
const TRANSLATED = new Set([
  "openai-chat>anthropic",
  "openai-chat>bedrock-converse",
  "openai-chat>gemini",
  "bedrock-converse>openai-chat",
  "bedrock-converse>anthropic",
  "anthropic>openai-chat",
  "anthropic>bedrock-converse",
  "anthropic>gemini",
  "gemini>openai-chat",
  "gemini>anthropic",
  "gemini>bedrock-converse",
]);
