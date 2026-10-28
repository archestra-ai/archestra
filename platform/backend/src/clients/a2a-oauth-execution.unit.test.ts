import { describe, expect, test } from "vitest";
import {
  a2aOAuthExecutionHeader,
  a2aOAuthExecutionReference,
} from "./a2a-oauth-execution";
import { guardrailCallHeader, internalCallHeader } from "./internal-call";

const agentId = "5b98f4f9-005d-47fa-9e28-19b71514b309";
const execution = { tokenId: "oauth:row-id", clientId: "client-id" };
const header = a2aOAuthExecutionHeader(agentId, execution);
const headerName = Object.keys(header)[0];
function carrier(headers: Record<string, string | string[] | undefined>) {
  return {
    headers: { ...headers },
    raw: {
      headers: { ...headers },
      rawHeaders: Object.entries(headers).flatMap(([name, value]) => [
        name,
        String(value),
      ]),
    },
  };
}

describe("A2A OAuth reference ingress", () => {
  test("retains trusted references across schema changes and removes every header view", () => {
    const request = carrier({ ...header, ...internalCallHeader() });
    expect(a2aOAuthExecutionReference(request)).toEqual({ agentId, execution });
    expect(request.headers).toEqual({});
    expect(request.raw.headers).toEqual({});
    expect(request.raw.rawHeaders).toEqual([]);
    request.headers = {};
    expect(a2aOAuthExecutionReference(request)).toEqual({ agentId, execution });
  });
  test.each([
    {},
    { "x-archestra-internal-call": "forged" },
    guardrailCallHeader(),
  ])("rejects references without an in-process proof: %j", (proof) => {
    const request = carrier({ ...header, ...proof });
    expect(() => a2aOAuthExecutionReference(request)).toThrow(
      "Invalid A2A OAuth execution reference",
    );
    expect(request.headers).toEqual({});
    expect(request.raw.headers).toEqual({});
    expect(request.raw.rawHeaders).toEqual([]);
  });
  test.each([
    "{invalid",
    JSON.stringify({ agentId, execution, grants: ["admin"] }),
    [header[headerName], header[headerName]],
  ])("rejects malformed or repeated trusted references: %j", (value) => {
    const request = carrier({ [headerName]: value, ...internalCallHeader() });
    expect(() => a2aOAuthExecutionReference(request)).toThrow(
      "Invalid A2A OAuth execution reference",
    );
    expect(() => a2aOAuthExecutionReference(request)).toThrow(
      "Invalid A2A OAuth execution reference",
    );
    expect(request.raw.rawHeaders).toEqual([]);
  });
  test("rejects duplicates even when another header view collapsed them", () => {
    const request = carrier({ ...header, ...internalCallHeader() });
    request.raw.rawHeaders.push(headerName.toUpperCase(), header[headerName]);
    expect(() => a2aOAuthExecutionReference(request)).toThrow(
      "Invalid A2A OAuth execution reference",
    );
    expect(request.raw.rawHeaders).toEqual([]);
  });
  test("a later hook cannot introduce a trusted reference", () => {
    const request = carrier(internalCallHeader());
    expect(a2aOAuthExecutionReference(request)).toBeUndefined();
    request.headers = { ...header };
    expect(a2aOAuthExecutionReference(request)).toBeUndefined();
    expect(request.headers).toEqual({});
  });
});
