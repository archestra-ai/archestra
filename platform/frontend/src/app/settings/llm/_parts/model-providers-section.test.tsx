import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockOrganization: Record<string, unknown> | null = null;
const mockMutateAsync = vi.fn();

vi.mock("next/navigation");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");

import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import {
  useOrganization,
  useUpdateIntegrationSettings,
} from "@/lib/organization.query";
import { ModelProvidersSection } from "./model-providers-section";

beforeEach(() => {
  vi.clearAllMocks();
  mockMutateAsync.mockResolvedValue({});
  mockOrganization = { modelProviderOverrides: null };
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue(
    [] as unknown as ReturnType<typeof useMissingPermissions>,
  );
  vi.mocked(useOrganization).mockImplementation(
    () =>
      ({
        data: mockOrganization,
        isPending: false,
      }) as ReturnType<typeof useOrganization>,
  );
  vi.mocked(useUpdateIntegrationSettings).mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateIntegrationSettings>);
});

const planSwitch = (plan: "personal subscription" | "enterprise plan") =>
  screen.getByRole("switch", {
    name: `Make ${plan === "enterprise plan" ? "GitHub Copilot Organization" : "GitHub Copilot"} ${plan} available`,
  });
const save = async () =>
  userEvent.click(await screen.findByRole("button", { name: "Save" }));

describe("ModelProvidersSection — GitHub Copilot", () => {
  it("shows one card per plan, each with its own switch", () => {
    render(<ModelProvidersSection />);

    expect(
      screen.getByTestId("model-provider-row-github-copilot-personal"),
    ).toHaveTextContent("Personal subscription");
    expect(
      screen.getByTestId("model-provider-row-github-copilot-enterprise"),
    ).toHaveTextContent("Enterprise plan");
    expect(
      screen.queryByTestId("model-provider-row-github-copilot"),
    ).toBeNull();
  });

  it("turns off personal subscriptions alone", async () => {
    render(<ModelProvidersSection />);

    await userEvent.click(planSwitch("personal subscription"));
    await save();

    expect(mockMutateAsync).toHaveBeenCalledWith({
      modelProviderOverrides: {
        "github-copilot": { plans: { personal: { hidden: true } } },
      },
    });
  });

  it("stores both cards off as GitHub Copilot off", async () => {
    render(<ModelProvidersSection />);

    await userEvent.click(planSwitch("personal subscription"));
    await userEvent.click(planSwitch("enterprise plan"));
    await save();

    expect(mockMutateAsync).toHaveBeenCalledWith({
      modelProviderOverrides: { "github-copilot": { hidden: true } },
    });
  });

  it("shows GitHub Copilot turned off as both cards off, and turns one back on", async () => {
    mockOrganization = {
      modelProviderOverrides: { "github-copilot": { hidden: true } },
    };
    render(<ModelProvidersSection />);

    expect(planSwitch("personal subscription")).not.toBeChecked();
    expect(planSwitch("enterprise plan")).not.toBeChecked();

    await userEvent.click(planSwitch("enterprise plan"));
    await save();

    expect(mockMutateAsync).toHaveBeenCalledWith({
      modelProviderOverrides: {
        "github-copilot": { plans: { personal: { hidden: true } } },
      },
    });
  });

  it("names the enterprise card GitHub Copilot Organization by default", () => {
    render(<ModelProvidersSection />);

    const card = screen.getByTestId(
      "model-provider-row-github-copilot-enterprise",
    );
    expect(card).toHaveTextContent("GitHub Copilot Organization");
    expect(
      screen.getByRole("textbox", {
        name: "GitHub Copilot Organization enterprise plan display name",
      }),
    ).toHaveAttribute("placeholder", "Show as “GitHub Copilot Organization”");
  });

  it("gives each card its own name", async () => {
    render(<ModelProvidersSection />);

    await userEvent.type(
      screen.getByRole("textbox", {
        name: "GitHub Copilot Organization enterprise plan display name",
      }),
      "Copilot for Teams",
    );

    expect(
      screen.getByRole("textbox", {
        name: "GitHub Copilot personal subscription display name",
      }),
    ).toHaveValue("");
    await save();
    expect(mockMutateAsync).toHaveBeenCalledWith({
      modelProviderOverrides: {
        "github-copilot": {
          plans: { enterprise: { displayName: "Copilot for Teams" } },
        },
      },
    });
  });

  it("notes every personal subscription provider, and no other card", () => {
    render(<ModelProvidersSection />);

    expect(
      screen.getByTestId("model-provider-row-microsoft-365-copilot"),
    ).toHaveTextContent("Personal subscription");
    expect(
      screen.getByTestId("model-provider-row-openai"),
    ).not.toHaveTextContent("Personal subscription");
    expect(
      screen.getByTestId("model-provider-row-github-copilot-enterprise"),
    ).not.toHaveTextContent("Personal subscription");
  });

  it("finds a plan card by its plan name", async () => {
    render(<ModelProvidersSection />);

    await userEvent.type(
      screen.getByPlaceholderText("Search providers…"),
      "enterprise",
    );

    // The search applies after typing settles; until then "en" still matches.
    await waitFor(() =>
      expect(screen.queryByTestId("model-provider-row-openai")).toBeNull(),
    );
    expect(
      screen.getByTestId("model-provider-row-github-copilot-enterprise"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("model-provider-row-github-copilot-personal"),
    ).toBeNull();
  });
});
