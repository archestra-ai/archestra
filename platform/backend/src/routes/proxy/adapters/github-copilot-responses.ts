/**
 * GitHub Copilot LLM Proxy Adapter — Responses-shaped
 *
 * The `github-copilot` provider's second surface. Copilot serves an
 * OpenAI-compatible `POST /responses` alongside `/chat/completions`, and its
 * Codex and GPT-5.x models are reachable *only* there — they declare
 * `supported_endpoints: ["/responses"]` and reject chat completions outright.
 *
 * Every adapter behaviour is the OpenAI Responses behaviour, so this composes
 * from that factory rather than restating it, exactly as
 * `perplexity-responses` does. `openAiResponsesAdapterFactory` is a plain
 * object literal holding no state. Delegated factory methods retain this
 * provider's receiver so provider-specific transport checks stay scoped.
 *
 * What differs is auth, and it is the same difference as the chat surface: the
 * incoming "API key" is a long-lived GitHub OAuth token (`gho_…`) that Copilot
 * does not accept directly, so every outgoing request swaps it for a
 * short-lived Copilot bearer. That swap lives in a fetch wrapper because
 * `createClient` is synchronous. Inheriting OpenAI's `createClient` here would
 * send the raw GitHub token upstream and 401 on every call.
 */
import { randomUUID } from "node:crypto";
import OpenAIProvider from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import config from "@/config";
import { metrics } from "@/observability";
import { createGithubCopilotFetch } from "@/services/github-copilot-token";
import type { CreateClientOptions, GithubCopilot, LLMProvider } from "@/types";
import { fetchWithAbortSignal } from "@/utils/client-disconnect-signal";
import { openAiResponsesAdapterFactory } from "./openai-responses";
import { PROXY_SDK_MAX_RETRIES } from "./sdk-retry-policy";

type GithubCopilotResponsesRequest = GithubCopilot.Types.ResponsesRequest;
type GithubCopilotResponsesResponse = GithubCopilot.Types.ResponsesResponse;
type GithubCopilotResponsesHeaders = GithubCopilot.Types.ResponsesHeaders;
type GithubCopilotResponseChunk = GithubCopilot.Types.ResponseChunk;
type GithubCopilotResponsesInput = string | ResponseInput | undefined;

export const githubCopilotResponsesAdapterFactory: LLMProvider<
  GithubCopilotResponsesRequest,
  GithubCopilotResponsesResponse,
  GithubCopilotResponsesInput,
  GithubCopilotResponseChunk,
  GithubCopilotResponsesHeaders
> = {
  ...openAiResponsesAdapterFactory,

  provider: "github-copilot",
  interactionType: "github-copilot:responses",

  /**
   * Copilot credentials are GitHub OAuth tokens, never the `chatgpt-oauth:…`
   * marker strings OpenAI's check looks for — so the inherited implementation
   * would answer `false` anyway. Stated explicitly because leaving it inherited
   * makes that a coincidence of OpenAI's format check rather than a decision,
   * and because it must stay in lockstep with the chat surface: a provider
   * whose two surfaces disagree about billing mode would bill the same
   * subscription differently depending on which endpoint the client happened to
   * call.
   */
  isSubscriptionCredential(): boolean {
    return false;
  },

  getBaseUrl(): string | undefined {
    return config.llm["github-copilot"].baseUrl || undefined;
  },

  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    const observableFetch = options.agent
      ? metrics.llm.getObservableFetch(
          "github-copilot",
          options.agent,
          options.source,
        )
      : undefined;

    return new OpenAIProvider({
      maxRetries: PROXY_SDK_MAX_RETRIES,
      // Placeholder satisfies the SDK; the wrapper sets the real bearer.
      apiKey: apiKey ?? "github-copilot",
      baseURL: options.baseUrl ?? config.llm["github-copilot"].baseUrl,
      fetch: createGithubCopilotFetch({
        githubToken: apiKey,
        providerApiKeyId: options.llmProviderApiKeyId,
        innerFetch: fetchWithAbortSignal(observableFetch, options.abortSignal),
      }),
      defaultHeaders: options.defaultHeaders,
    });
  },

  async executeStream(client: unknown, request: GithubCopilotResponsesRequest) {
    return withStableReasoningIds(
      await openAiResponsesAdapterFactory.executeStream.call(
        this,
        client,
        request,
      ),
    );
  },
};

// ===== Internal helpers =====

/**
 * Repairs the one place Copilot's Responses stream diverges from OpenAI's.
 *
 * On OpenAI, `response.output_item.added` announces an item with an `item.id`,
 * and every event that belongs to that item repeats the same value in
 * `item_id`. That shared id is the only thing binding a delta to the part it
 * extends. Copilot instead emits a DIFFERENT opaque string in `item_id` on
 * every single event, none of them equal to the item's own `id` — verified
 * against a live subscription, where one reasoning item and one message item
 * produced a distinct id on each of their events.
 *
 * Consumers register a part when the item is added, then look it up by each
 * event's `item_id`. Under Copilot every lookup misses, and the AI SDK's
 * Responses parser fails on the miss — "Cannot read properties of undefined
 * (reading 'summaryParts')" for reasoning, "Received text-delta for missing
 * text part" for message text. Either kills the turn, so Archestra's own chat
 * could not complete a single Copilot Responses turn.
 *
 * Re-anchor by output_index, which stays stable even when message, reasoning,
 * and function-call items overlap. For legacy events without an index, only
 * use the sole open item; choosing the most recently opened item would attach
 * another item's deltas or closing events to the wrong identity.
 */
async function* withStableReasoningIds(
  stream: AsyncIterable<GithubCopilotResponseChunk>,
): AsyncIterable<GithubCopilotResponseChunk> {
  const openItems = new Map<number | undefined, string>();

  for await (const chunk of stream) {
    const type = (chunk as { type?: string }).type;
    const item = (chunk as { item?: { type?: string; id?: string } }).item;
    const outputIndex = (chunk as { output_index?: number }).output_index;
    const index =
      outputIndex === undefined && openItems.size === 1
        ? openItems.keys().next().value
        : outputIndex;

    // Opening an item defines the id its indexed events must carry.
    // Copilot has been seen to omit `id` on a reasoning item, so mint one
    // rather than propagate an undefined key.
    if (type === "response.output_item.added" && item) {
      const id = item.id ?? `item_${randomUUID()}`;
      openItems.set(outputIndex, id);
      yield {
        ...chunk,
        item: { ...item, id },
      } as GithubCopilotResponseChunk;
      continue;
    }

    const id =
      outputIndex === undefined && openItems.size !== 1
        ? undefined
        : openItems.get(index);
    if (type === "response.output_item.done" && item) {
      if (id) openItems.delete(index);
      yield {
        ...chunk,
        item: { ...item, id: id ?? item.id },
      } as GithubCopilotResponseChunk;
      continue;
    }

    // Every other per-item event (content parts, text deltas, reasoning
    // summaries, function-call arguments) is bound to its own open item.
    if (id && "item_id" in (chunk as unknown as object)) {
      yield {
        ...chunk,
        item_id: id,
      } as GithubCopilotResponseChunk;
      continue;
    }

    yield chunk;
  }
}
