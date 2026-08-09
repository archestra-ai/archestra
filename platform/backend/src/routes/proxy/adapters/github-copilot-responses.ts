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
 * object literal holding no state, and the adapters it builds carry no
 * provider-dependent behaviour, so spreading it is genuine reuse rather than a
 * shallow-copy hazard.
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
        innerFetch: observableFetch,
      }),
      defaultHeaders: options.defaultHeaders,
    });
  },

  async executeStream(client: unknown, request: GithubCopilotResponsesRequest) {
    return withStableReasoningIds(
      await openAiResponsesAdapterFactory.executeStream(client, request),
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
 * Re-anchoring each event onto the id of the item currently open restores the
 * invariant consumers rely on. Ordering guarantees this is sound: an item's
 * events always sit between its `output_item.added` and its `output_item.done`
 * (Copilot streams one item at a time, verified live), so the most recently
 * opened item owns whatever follows. Only ids change — nothing is added,
 * dropped, or reordered — and gateway clients get the same repair, which is
 * the point: the stream they receive is the conformant one either way.
 */
async function* withStableReasoningIds(
  stream: AsyncIterable<GithubCopilotResponseChunk>,
): AsyncIterable<GithubCopilotResponseChunk> {
  let currentItemId: string | null = null;

  for await (const chunk of stream) {
    const type = (chunk as { type?: string }).type;
    const item = (chunk as { item?: { type?: string; id?: string } }).item;

    // Opening an item defines the id everything up to its close must carry.
    // Copilot has been seen to omit `id` on a reasoning item, so mint one
    // rather than propagate an undefined key.
    if (type === "response.output_item.added" && item) {
      currentItemId = item.id ?? `item_${randomUUID()}`;
      yield {
        ...chunk,
        item: { ...item, id: currentItemId },
      } as GithubCopilotResponseChunk;
      continue;
    }

    if (type === "response.output_item.done" && item) {
      const id = currentItemId ?? item.id;
      currentItemId = null;
      yield {
        ...chunk,
        item: { ...item, id },
      } as GithubCopilotResponseChunk;
      continue;
    }

    // Every other per-item event (content parts, text deltas, reasoning
    // summaries, function-call arguments) is bound to the open item.
    if (currentItemId && "item_id" in (chunk as unknown as object)) {
      yield {
        ...chunk,
        item_id: currentItemId,
      } as GithubCopilotResponseChunk;
      continue;
    }

    yield chunk;
  }
}
