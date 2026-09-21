import {
  mayHoldAttestationToken,
  removeAttestationTokens,
  takeLeadingAttestation,
} from "@/archestra-mcp-server/tool-attestation";
import {
  type DeclaredToolSpelling,
  declaredToolEntries,
} from "@/openappa/wire";

/** A tool the request declares, with the attestation marker its description led with. */
export type GatewayToolDeclaration = DeclaredToolSpelling & { marker?: string };

/**
 * Takes the gateway's attestation markers out of a request body, in place,
 * and returns one entry per named declaration, in order.
 *
 * The gateway puts a marker in front of every tool description it serves, and
 * the client forwards it here. Each declaration's leading marker is recorded
 * and removed; a description that held only the marker loses its key. Every
 * other marker-shaped token anywhere in the body is then removed too: a second
 * token stacked in a description, and every place a client echoes a
 * description back — system prompts, tool results that list tool definitions
 * (Claude Code's tool search), Responses `function_call_output`, Chat
 * Completions tool messages.
 *
 * Runs before the provider's request adapter is created, and so before any
 * log, provider request or discovered-tool row can see the body: the adapters
 * keep a reference to this same object rather than a copy, so the model, the
 * interaction record and persistence all read the stripped body.
 */
export function extractGatewayToolDeclarations(
  body: unknown,
): GatewayToolDeclaration[] {
  return takeMarkers(body).declarations;
}

/**
 * The same removal for a raw JSON body the proxy forwards without handling it
 * (a provider's catch-all route, such as Anthropic's count_tokens). Returns
 * the parsed body with every marker taken out, or null when the bytes hold no
 * marker or are not JSON, so they can go upstream unchanged.
 */
export function removeMarkersFromForwardedJson(raw: Buffer): object | null {
  if (!mayHoldAttestationToken(raw)) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  return takeMarkers(body).changed ? body : null;
}

// === Internal helpers ===

function takeMarkers(body: unknown): {
  declarations: GatewayToolDeclaration[];
  changed: boolean;
} {
  const declarations: GatewayToolDeclaration[] = [];
  for (const { holder, name, namespace } of declaredToolEntries(body)) {
    if (!name) continue;
    let marker: string | undefined;
    if (holder && typeof holder.description === "string") {
      const taken = takeLeadingAttestation(holder.description);
      marker = taken.marker;
      if (marker !== undefined) {
        if (taken.rest === "") delete holder.description;
        else holder.description = taken.rest;
      }
    }
    declarations.push({
      name,
      ...(namespace ? { namespace } : {}),
      ...(marker ? { marker } : {}),
    });
  }
  const removedElsewhere = removeTokensEverywhere(body);
  return {
    declarations,
    changed:
      removedElsewhere ||
      declarations.some((declaration) => declaration.marker !== undefined),
  };
}

/**
 * Removes every token from every string value in the body, in place, and
 * returns whether any string changed. Keys are never touched, and a string is
 * only reassigned when it changed. Iterative, so a deeply nested body cannot
 * overflow the stack.
 */
function removeTokensEverywhere(body: unknown): boolean {
  let changed = false;
  const stack: unknown[] = [body];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== "object" || value === null) continue;
    if (ArrayBuffer.isView(value) || seen.has(value)) continue;
    seen.add(value);
    // An array's own keys are its indices, so one loop serves both.
    const container = value as Record<string, unknown>;
    for (const key of Object.keys(container)) {
      const item = container[key];
      if (typeof item === "string") {
        const stripped = removeAttestationTokens(item);
        if (stripped !== item) {
          container[key] = stripped;
          changed = true;
        }
      } else if (typeof item === "object" && item !== null) {
        stack.push(item);
      }
    }
  }
  return changed;
}
