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
 * Removes gateway attestation markers from a request body in place.
 * Returns an ordered array of declarations with recorded markers.
 *
 * The gateway prepends a marker to each tool description in tools/list.
 * Clients forward descriptions here. Each declaration's leading marker is
 * recorded and removed. If a description contained only the marker, its key is
 * deleted. All other marker-like tokens across the request body are removed,
 * including echoed descriptions in system prompts, tool results, and tool messages.
 *
 * Runs before the provider request adapter is created. As a result, logs,
 * provider requests, and persisted records only receive the cleaned request body.
 */
export function extractGatewayToolDeclarations(
  body: unknown,
): GatewayToolDeclaration[] {
  return takeMarkers(body).declarations;
}

/**
 * Removes attestation markers from a raw JSON body forwarded without proxy handling
 * (such as Anthropic count_tokens). Returns the parsed body with markers removed,
 * or null if the payload contains no markers or is invalid JSON.
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
 * Iteratively removes attestation tokens from all string values in the body.
 * Modifies objects in place and returns true if any values changed.
 * Object keys remain unchanged.
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
