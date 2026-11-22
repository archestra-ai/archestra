import { describe, expect, it } from "vitest";
import { agentRunBlock } from "./use-agent-run-block";

const ready = {
  ready: true,
  configured: [],
  missing: [],
  misconfigured: [],
  incompatible: null,
  accountError: null,
  accountErrorFromChoice: false,
  accountErrorFromModel: false,
  accountErrorFromConnection: false,
  companyAccountIsPlan: false,
  missingSubscription: null,
};
const blocked = (
  overrides: Partial<Parameters<typeof agentRunBlock>[0]>,
): Parameters<typeof agentRunBlock>[0] => ({
  ...ready,
  ready: false,
  ...overrides,
});
const credential = (key: string, label: string, extra = {}) => ({
  key,
  label,
  description: "",
  ...extra,
});

describe("agentRunBlock", () => {
  it("is null for an agent the reader can run", () => {
    expect(agentRunBlock(ready)).toBeNull();
  });

  it("tells the reader to sign in when their Claude subscription is not connected", () => {
    expect(
      agentRunBlock(
        blocked({
          missing: [
            credential("CLAUDE_CODE_ACCOUNT", "Claude"),
            credential("GITHUB_TOKEN", "GitHub"),
          ],
        }),
      ),
    ).toBe("Sign in with Claude to run this agent.");
  });

  it("tells the reader to sign in to any other subscription the same way", () => {
    const message =
      "Connect your own ChatGPT Subscription before starting this Agent. The maintained runtime never falls back to usage-based API billing.";
    expect(
      agentRunBlock(
        blocked({ accountError: message, missingSubscription: "chatgpt" }),
      ),
    ).toBe("Sign in with ChatGPT to run this agent.");
    expect(
      agentRunBlock(
        blocked({ accountError: message, missingSubscription: "x-premium" }),
      ),
    ).toBe("Sign in with Grok to run this agent.");
  });

  it("asks for a model when their subscription does not offer the agent's", () => {
    expect(
      agentRunBlock(
        blocked({
          accountError:
            "This agent's model is not available through your GitHub Copilot. Choose a model on the agent's page.",
          accountErrorFromModel: true,
        }),
      ),
    ).toBe("Choose a model to run this agent.");
  });

  it("asks for a connection where the agent leaves it to each person and none of theirs runs", () => {
    expect(
      agentRunBlock(
        blocked({
          accountError:
            "This agent leaves the connection to each person. Choose one on the agent's page.",
          accountErrorFromConnection: true,
        }),
      ),
    ).toBe("Choose a connection to run this agent.");
    // The connection comes first: a model is picked on one.
    expect(
      agentRunBlock(
        blocked({
          accountError: "Choose a connection and a model on the agent's page.",
          accountErrorFromConnection: true,
          accountErrorFromModel: true,
        }),
      ),
    ).toBe("Choose a connection to run this agent.");
  });

  it("asks for a plan, not a connection, on a GitHub Copilot CLI agent", () => {
    expect(
      agentRunBlock(
        blocked({
          accountError: "Choose a plan on the agent's page to run this agent.",
          accountErrorFromConnection: true,
          companyAccountIsPlan: true,
        }),
      ),
    ).toBe("Choose a plan to run this agent.");
  });

  it("says who can fix an account that cannot run, never the raw reason", () => {
    expect(
      agentRunBlock(
        blocked({
          accountError: "Your own account for this agent no longer works.",
          accountErrorFromChoice: true,
        }),
      ),
    ).toBe("Choose your account again to run this agent.");
    expect(
      agentRunBlock(
        blocked({
          accountError:
            "This agent is locked to each person's own subscription, but gemini-2.5-pro has none.",
        }),
      ),
    ).toBe("Contact your admin to set up this agent account.");
  });

  it("names the credentials to set up, and the ones only an admin can give", () => {
    expect(
      agentRunBlock(
        blocked({
          missing: [credential("GITHUB_TOKEN", "GitHub")],
          misconfigured: [credential("API_TOKEN", "API token")],
        }),
      ),
    ).toBe("Set up GitHub and API token to run this agent.");
    expect(
      agentRunBlock(
        blocked({
          missing: [
            credential("GITHUB_TOKEN", "GitHub", { canConnect: false }),
          ],
        }),
      ),
    ).toBe("Contact your admin to set up GitHub for this agent.");
    expect(
      agentRunBlock(
        blocked({
          missing: [credential("ORG_KEY", "Org key", { adminOnly: true })],
        }),
      ),
    ).toBe("Only admins can run this agent.");
  });

  it("asks for a model the runtime can run, then for the rest of the setup", () => {
    expect(
      agentRunBlock(blocked({ incompatible: "This model cannot run here." })),
    ).toBe("Pick a model this agent can run.");
    expect(agentRunBlock(blocked({}))).toBe(
      "Finish its setup to run this agent.",
    );
  });
});
