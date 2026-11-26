// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  copilotAccountsFor,
  copilotPlansAfterClick,
  copilotPlansOpen,
  namedEnterprisePlanCard,
  personalSubscriptionCard,
  planModelsAfterClick,
  withPlanModel,
  withPlanModels,
} from "./runtime-account-cards";

describe("personalSubscriptionCard", () => {
  it.each([
    ["chatgpt", "ChatGPT"],
    ["x-premium", "SuperGrok"],
    ["github-copilot", "GitHub Copilot"],
  ] as const)("names %s by the provider, in its title and in whose account it is", (kind, name) => {
    const card = personalSubscriptionCard(kind);
    expect(card.title).toBe(`Each person's ${name} subscription`);
    // The account is the provider's: "ChatGPT account", not "ChatGPT
    // Subscription account".
    expect(card.description).toBe(
      `Everyone connects their own ${name} account once. No cost limits. A run's container only gets a short-lived key.`,
    );
  });
});

describe("namedEnterprisePlanCard", () => {
  it("names a plan the reader cannot read by the name the runtime's settings give", () => {
    expect(namedEnterprisePlanCard("GitHub Copilot Example Org")).toEqual({
      title: "Enterprise plan: GitHub Copilot Example Org",
      description:
        "Billed to the organization on GitHub. A run's container only gets a short-lived key.",
    });
  });

  it("names a plan with no name left, such as one that no longer exists, by its kind alone", () => {
    expect(namedEnterprisePlanCard(undefined).title).toBe("Enterprise plan");
  });
});

describe("the Copilot CLI's enterprise plan cards", () => {
  const planIds = ["plan-a", "plan-b"];

  it("opens the company's way on every plan, or on the one that is fixed", () => {
    expect(
      copilotPlansOpen({ companyWayOpen: true, fixedPlanId: undefined }),
    ).toBe("all");
    expect(
      copilotPlansOpen({ companyWayOpen: true, fixedPlanId: "plan-a" }),
    ).toBe("plan-a");
    expect(
      copilotPlansOpen({ companyWayOpen: false, fixedPlanId: "plan-a" }),
    ).toBeNull();
  });

  it("settles on one plan where a click would leave a set short of all of them", () => {
    // Unticking one of all leaves the other.
    expect(
      copilotPlansAfterClick({ planIds, open: "all", planId: "plan-b" }),
    ).toBe("plan-a");
    // Ticking the last unticked plan of two opens them all.
    expect(
      copilotPlansAfterClick({ planIds, open: "plan-a", planId: "plan-b" }),
    ).toBe("all");
    // Unticking the one that is fixed closes the company's way.
    expect(
      copilotPlansAfterClick({ planIds, open: "plan-a", planId: "plan-a" }),
    ).toBeNull();
    // With three, ticking another moves to it.
    expect(
      copilotPlansAfterClick({
        planIds: [...planIds, "plan-c"],
        open: "plan-a",
        planId: "plan-c",
      }),
    ).toBe("plan-c");
    // A lone plan is all of them.
    expect(
      copilotPlansAfterClick({
        planIds: ["plan-a"],
        open: null,
        planId: "plan-a",
      }),
    ).toBe("all");
  });

  it("names the kind that is open and the plan that is fixed, keeping the plan's model", () => {
    expect(
      copilotAccountsFor({
        subscription: true,
        open: "all",
        fixedPlanId: undefined,
        modelId: undefined,
      }),
    ).toEqual({ lock: null, llmApiKeyId: undefined, modelId: undefined });
    expect(
      copilotAccountsFor({
        subscription: false,
        open: "plan-a",
        fixedPlanId: "plan-a",
        modelId: "model-1",
      }),
    ).toEqual({ lock: "key", llmApiKeyId: "plan-a", modelId: "model-1" });
    // Another plan does not take the old one's model.
    expect(
      copilotAccountsFor({
        subscription: false,
        open: "plan-b",
        fixedPlanId: "plan-a",
        modelId: "model-1",
      }),
    ).toEqual({ lock: "key", llmApiKeyId: "plan-b", modelId: undefined });
    expect(
      copilotAccountsFor({
        subscription: true,
        open: null,
        fixedPlanId: undefined,
        modelId: undefined,
      }),
    ).toMatchObject({ lock: "subscription" });
    expect(
      copilotAccountsFor({
        subscription: false,
        open: null,
        fixedPlanId: undefined,
        modelId: undefined,
      }),
    ).toEqual({ lock: "none" });
  });

  it("keeps a plan's model with it when every plan opens, and sets none per plan where one plan is fixed", () => {
    // The plan that was fixed with a model: once both are open, that model
    // is the one set for it, beside what the other plans already hold.
    expect(
      planModelsAfterClick({
        models: { "plan-b": "model-2" },
        open: "all",
        fixedPlanId: "plan-a",
        fixedModelId: "model-1",
      }),
    ).toEqual({ "plan-a": "model-1", "plan-b": "model-2" });
    expect(
      planModelsAfterClick({
        models: undefined,
        open: "all",
        fixedPlanId: "plan-a",
        fixedModelId: undefined,
      }),
    ).toEqual({});
    // One plan fixed: its model is the holder's own.
    expect(
      planModelsAfterClick({
        models: { "plan-a": "model-1", "plan-b": "model-2" },
        open: "plan-b",
        fixedPlanId: undefined,
        fixedModelId: undefined,
      }),
    ).toEqual({});
  });

  it("stores the model set for each plan, and nothing when none is set", () => {
    const runtime = { image: "example", connectionModels: { a: "1" } };
    expect(withPlanModel(runtime, "b", "2")).toEqual({
      image: "example",
      connectionModels: { a: "1", b: "2" },
    });
    expect(withPlanModel(runtime, "a", null)).toEqual({ image: "example" });
    expect(withPlanModels(runtime, {})).toEqual({ image: "example" });
  });
});
