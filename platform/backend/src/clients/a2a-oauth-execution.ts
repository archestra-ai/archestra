import { z } from "zod";
import type { A2AOAuthExecution } from "@/routes/mcp-gateway/utils";
import { internalCallProvenance } from "./internal-call";

const HEADER = "x-archestra-a2a-oauth-execution";
const Reference = z.strictObject({
  agentId: z.string().uuid(),
  execution: z.strictObject({
    tokenId: z.string().min(1).max(256),
    clientId: z.string().min(1).max(256),
    serviceAccountId: z.string().uuid().optional(),
  }),
});
type Reference = z.infer<typeof Reference>;
type Headers = Record<string, string | string[] | undefined>;
type Carrier = {
  headers: Headers;
  raw?: { headers: Headers; rawHeaders?: string[] };
};
const captured = new WeakMap<
  object,
  { reference?: Reference; error?: Error }
>();

/** Non-bearer reference: adds a live authorization restriction, never a grant. */
export function a2aOAuthExecutionHeader(
  agentId: string,
  execution: A2AOAuthExecution,
): Record<string, string> {
  return { [HEADER]: JSON.stringify({ agentId, execution }) };
}

/** Capture before schema normalization; remove from every forwarding/log view. */
export function a2aOAuthExecutionReference(
  request: Carrier,
): Reference | undefined {
  const key = request.raw ?? request;
  let result = captured.get(key);
  const value = request.headers[HEADER];
  const rawHeaders = request.raw?.rawHeaders;
  const duplicates =
    (rawHeaders?.filter(
      (name, index) => index % 2 === 0 && name.toLowerCase() === HEADER,
    ).length ?? 0) > 1;
  const proof = internalCallProvenance(request);
  for (const headers of new Set([request.headers, request.raw?.headers])) {
    if (headers) delete headers[HEADER];
  }
  if (rawHeaders) {
    for (let index = rawHeaders.length - 2; index >= 0; index -= 2) {
      if (rawHeaders[index].toLowerCase() === HEADER)
        rawHeaders.splice(index, 2);
    }
  }
  if (!result) {
    result = {};
    if (value !== undefined || duplicates) {
      try {
        if (!proof.inProcess || typeof value !== "string" || duplicates) {
          throw new Error("Invalid A2A OAuth execution reference");
        }
        result.reference = Reference.parse(JSON.parse(value));
      } catch {
        // Do not include the supplied header or a parser's input in the error.
        result.error = Object.assign(
          new Error("Invalid A2A OAuth execution reference"),
          { statusCode: 400 },
        );
      }
    }
    captured.set(key, result);
  }
  if (result.error) throw result.error;
  return result.reference;
}
