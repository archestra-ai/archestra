import {
  removeAttestationTokens,
  takeLeadingAttestation,
} from "@/archestra-mcp-server/tool-attestation";
import {
  type DeclaredToolSpelling,
  declaredToolEntries,
} from "@/openappa/wire";

/** A tool the request declares, with the attestation marker its description led with. */
export type GatewayToolDeclaration = DeclaredToolSpelling & {
  marker?: string;
  /** Lossless callable-contract fingerprint, before proxy parameters are stripped. */
  contract?: string;
};

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
 * Removes attestation markers, in place, from a parsed body a catch-all proxy
 * forwards without proxy handling (such as Anthropic count_tokens). Returns
 * whether it removed any.
 */
export function removeMarkersFromBody(body: object): boolean {
  return takeMarkers(body).changed;
}

// === Internal helpers ===

function takeMarkers(body: unknown): {
  declarations: GatewayToolDeclaration[];
  changed: boolean;
} {
  const declarations: GatewayToolDeclaration[] = [];
  for (const { holder, name, namespace, tool } of declaredToolEntries(body)) {
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
      ...(holder ? callableContract(tool, holder) : {}),
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

function callableContract(
  tool: unknown,
  holder: Record<string, unknown>,
): { contract?: string } {
  const record = tool as Record<string, unknown> | null;
  if (!record || record.type === "custom" || record.custom) return {};
  const input =
    holder.input_schema ??
    holder.parameters ??
    holder.parametersJsonSchema ??
    (holder.inputSchema as Record<string, unknown> | undefined)?.json;
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return {};
  const { name: _name, description: _description, ...definition } = holder;
  try {
    // Unlike diagnostic canonicalization, this never truncates deep schemas.
    // An unrepresentable contract provides no evidence for alias recovery.
    const serialized = JSON.stringify(
      { type: record.type ?? "function", definition },
      (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, value[key]]),
            )
          : value,
    );
    return { contract: createHash("sha256").update(serialized).digest("hex") };
  } catch {
    return {};
  }
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

import { createHash } from "node:crypto";
