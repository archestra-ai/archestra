import { archestraApiClient } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type OAuthClientFormValues,
  resolveOauthClientFormBody,
} from "./configuration-fields";

const ORIGIN = "http://localhost:9000";
const server = setupServer();
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: ORIGIN });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
const values = (ids: string[]): OAuthClientFormValues => ({
  name: "Example application",
  grantType: "client_credentials",
  scopes: ["a2a"],
  allowedGatewayIds: ids,
  redirectUrisText: "",
});

describe("remote OAuth target normalization", () => {
  it("removes gateway IDs outside the visible metadata page while preserving unknown and agent targets", async () => {
    const selected = [
      ...Array.from({ length: 25 }, (_, index) => `agent-${index}`),
      "gateway-after-first-page",
      "unreadable-retained",
    ];
    const input = values(selected);
    server.use(
      http.get(`${ORIGIN}/api/agents/options/ids`, ({ request }) => {
        const url = new URL(request.url);
        expect(
          url.searchParams.get("agentTypes") ??
            url.searchParams.get("agentTypes[]"),
        ).toBe("mcp_gateway");
        expect(url.searchParams.has("ids")).toBe(false);
        return HttpResponse.json(["gateway-after-first-page"]);
      }),
    );
    const body = await resolveOauthClientFormBody(input);
    expect(body.allowedGatewayIds).toEqual(
      selected.filter((id) => id !== "gateway-after-first-page"),
    );
    expect(input.allowedGatewayIds).toEqual(selected);
  });

  it("does not download any roster or IDs when the MCP scope already allows the selected targets", async () => {
    const input = {
      ...values(["agent", "gateway"]),
      scopes: ["mcp", "a2a"] as OAuthClientFormValues["scopes"],
    };
    expect((await resolveOauthClientFormBody(input)).allowedGatewayIds).toEqual(
      ["agent", "gateway"],
    );
  });

  it("leaves the saved selection unchanged when target resolution fails", async () => {
    server.use(
      http.get(`${ORIGIN}/api/agents/options/ids`, () =>
        HttpResponse.json(
          { error: { message: "Unavailable" } },
          { status: 503 },
        ),
      ),
    );
    const input = values(["saved-target"]);
    await expect(resolveOauthClientFormBody(input)).rejects.toThrow();
    expect(input.allowedGatewayIds).toEqual(["saved-target"]);
  });
});
