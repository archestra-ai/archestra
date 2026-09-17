import { HttpResponse, http } from "msw";
import { expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { claudeCodeOAuth } from "./claude-code-oauth";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();

test.for([
  { expires_in: 0 },
  { expires_in: -1 },
  { expires_in: undefined },
  { scope: "user:profile" },
  { token_type: "invalid" },
  { access_token: "not-a-subscription-token" },
])("rejects unusable OAuth credentials: %j", async (override) => {
  server.use(
    http.post(TOKEN_URL, () => HttpResponse.json({ ...RESPONSE, ...override })),
  );
  await expect(
    claudeCodeOAuth.exchange({
      code: "code",
      state: "state",
      verifier: "verifier",
    }),
  ).rejects.toThrow("invalid sign-in result");
});

test("does not forward authorization codes or credentials through redirects", async () => {
  let followed = false;
  server.use(
    http.post(
      TOKEN_URL,
      () =>
        new HttpResponse(null, {
          status: 307,
          headers: { Location: "https://redirect.example.test/token" },
        }),
    ),
    http.post("https://redirect.example.test/token", () => {
      followed = true;
      return HttpResponse.json(RESPONSE);
    }),
  );
  await expect(
    claudeCodeOAuth.exchange({
      code: "private-code",
      state: "state",
      verifier: "private-verifier",
    }),
  ).rejects.toThrow("Could not contact Claude");
  expect(followed).toBe(false);
});

test("loads models using subscription authentication and preserves the runtime default", async () => {
  server.use(
    http.get("https://api.anthropic.com/v1/models", ({ request }) => {
      expect(request.headers.get("Authorization")).toBe(
        `Bearer ${RESPONSE.access_token}`,
      );
      expect(request.headers.get("x-api-key")).toBeNull();
      expect(request.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
      return HttpResponse.json({
        data: [{ id: "example-model", display_name: "Example model" }],
      });
    }),
  );
  expect(await claudeCodeOAuth.models(RESPONSE.access_token)).toEqual([
    {
      value: "default",
      displayName: "Default",
      description: "Claude Code's default model for your account",
    },
    { value: "example-model", displayName: "Example model", description: "" },
  ]);
});

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const RESPONSE = {
  access_token: `sk-ant-oat01-${"example".repeat(8)}`,
  expires_in: 3600,
  token_type: "Bearer",
  scope: "user:inference",
};
