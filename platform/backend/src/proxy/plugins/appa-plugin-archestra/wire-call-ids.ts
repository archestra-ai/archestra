import { policyCallId } from "@/openappa/call-id";
import type {
  LlmProxyHostedToolCallsContext,
  LlmProxyHostedToolCallsOutcome,
  LlmProxyToolCallsContext,
  LlmProxyToolCallsOutcome,
  LlmProxyToolResultsContext,
  LlmProxyToolResultsOutcome,
} from "@/proxy/plugins/registry";

type ToolCall = LlmProxyToolCallsContext["toolCalls"][number];

/**
 * One hook's tool traffic under the ids each side knows it by: policy ids for
 * everything the plugin rules on and records, wire ids for whatever goes back
 * to the proxy's adapters, which match and answer by the id the wire carries.
 */
export class WireCallIds {
  private readonly wireIds = new Map<string, string>();
  private readonly resultWireIds = new Map<string, string[]>();

  /** Every id here is its own policy id: both sides name each call the same way. */
  get same(): boolean {
    return this.wireIds.size === 0;
  }

  /**
   * The call under its policy id. Its wire id rides along, so a trajectory
   * stamp still wraps the id the provider must be given back.
   */
  toolCall(call: ToolCall): ToolCall {
    const id = this.policyId(call.id);
    return id === call.id
      ? call
      : { ...call, id, wireId: call.wireId ?? call.id };
  }

  hostedToolCall(
    call: LlmProxyHostedToolCallsContext["hostedToolCalls"][number],
  ): LlmProxyHostedToolCallsContext["hostedToolCalls"][number] {
    return { ...call, id: this.policyId(call.id) };
  }

  toolResult(
    result: LlmProxyToolResultsContext["toolResults"][number],
  ): LlmProxyToolResultsContext["toolResults"][number] {
    const id = this.policyId(result.id);
    this.resultWireIds.set(id, [
      ...(this.resultWireIds.get(id) ?? []),
      result.id,
    ]);
    return { ...result, id };
  }

  toolCallsOutcome(
    outcome: LlmProxyToolCallsOutcome | undefined,
  ): LlmProxyToolCallsOutcome | undefined {
    switch (outcome?.decision) {
      case undefined:
        return outcome;
      case "refuse": {
        const { blockedToolId } = outcome.refusal;
        return blockedToolId === undefined
          ? outcome
          : {
              ...outcome,
              refusal: {
                ...outcome.refusal,
                blockedToolId: this.wireId(blockedToolId),
              },
            };
      }
      case "allow":
        return {
          ...outcome,
          toolCalls: outcome.toolCalls.map((call) => this.wireToolCall(call)),
          ...(outcome.blocked
            ? { blocked: outcome.blocked.map((each) => this.onWire(each)) }
            : {}),
          ...(outcome.rewritten
            ? { rewritten: outcome.rewritten.map((each) => this.onWire(each)) }
            : {}),
          ...(outcome.annotated
            ? { annotated: outcome.annotated.map((each) => this.onWire(each)) }
            : {}),
          ...(outcome.runtimeProofs
            ? {
                runtimeProofs: outcome.runtimeProofs.map((each) =>
                  this.onWire(each),
                ),
              }
            : {}),
        };
    }
  }

  hostedToolCallsOutcome(
    outcome: LlmProxyHostedToolCallsOutcome | undefined,
  ): LlmProxyHostedToolCallsOutcome | undefined {
    switch (outcome?.decision) {
      case undefined:
      case "release":
        return outcome;
      case "hold":
        return {
          ...outcome,
          notices: outcome.notices.map((call) => this.wireToolCall(call)),
          blocked: outcome.blocked.map((each) => this.onWire(each)),
        };
    }
  }

  toolResultsOutcome(
    outcome: LlmProxyToolResultsOutcome | undefined,
  ): LlmProxyToolResultsOutcome | undefined {
    return (
      outcome && {
        ...outcome,
        toolResultUpdates: Object.fromEntries(
          // A ruling on a policy id goes to every result the request
          // carries under it: a signed id and its bare one are one call.
          Object.entries(outcome.toolResultUpdates).flatMap(([id, content]) =>
            (this.resultWireIds.get(id) ?? [id]).map((wireId) => [
              wireId,
              content,
            ]),
          ),
        ),
      }
    );
  }

  private policyId(wireId: string): string {
    const policyId = policyCallId(wireId);
    if (policyId !== wireId) this.wireIds.set(policyId, wireId);
    return policyId;
  }

  private wireId(policyId: string): string {
    return this.wireIds.get(policyId) ?? policyId;
  }

  private onWire<T extends { id: string }>(named: T): T {
    return { ...named, id: this.wireId(named.id) };
  }

  /** The id the plugin chose for the client stays; the wire's own needs none. */
  private wireToolCall(call: ToolCall): ToolCall {
    const id = this.wireId(call.id);
    if (id === call.id) return call;
    const { wireId, ...named } = call;
    return {
      ...named,
      id,
      ...(wireId !== undefined && wireId !== id ? { wireId } : {}),
    };
  }
}
