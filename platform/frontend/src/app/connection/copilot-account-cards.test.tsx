import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { hasPermissions } from "@/lib/auth/auth.utils";
import {
  CopilotAccountCards,
  copilotAccountMissing,
} from "./copilot-account-cards";

vi.mock("@/lib/auth/auth.query");

vi.mock("@/components/github-copilot-sign-in", () => ({
  GithubCopilotSignIn: ({
    onToken,
    disabled,
  }: {
    onToken: (token: string) => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onToken("gho_test")}
    >
      Sign in with GitHub
    </button>
  ),
}));

vi.mock(
  "@/app/llm/model-providers/_parts/copilot-organization-connect-dialog",
  () => ({
    CopilotOrganizationConnectDialog: ({
      open,
      onOpenChange,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }) =>
      open ? (
        <div data-testid="copilot-plan-dialog">
          <button type="button" onClick={() => onOpenChange(false)}>
            Close
          </button>
        </div>
      ) : null,
  }),
);

const own = { id: "copilot-own", isGithubAppKey: false };
const plan = { id: "copilot-plan", isGithubAppKey: true };

function grant(permissions: Parameters<typeof hasPermissions>[0]) {
  vi.mocked(useHasPermissions).mockImplementation(
    (wanted) =>
      ({
        data: hasPermissions(permissions, wanted),
      }) as ReturnType<typeof useHasPermissions>,
  );
}

beforeEach(() => {
  grant({ llmProviderApiKey: ["create"] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("copilotAccountMissing", () => {
  it("is true until both a sign-in and a plan are connected", () => {
    expect(copilotAccountMissing([])).toBe(true);
    expect(copilotAccountMissing([own])).toBe(true);
    expect(copilotAccountMissing([plan])).toBe(true);
    expect(copilotAccountMissing([own, plan])).toBe(false);
  });
});

describe("CopilotAccountCards", () => {
  it("offers both accounts when none is connected, the sign-in on the card itself", async () => {
    const onToken = vi.fn();
    const user = userEvent.setup();
    render(<CopilotAccountCards keys={[]} pending={false} onToken={onToken} />);
    const personal = screen.getByTestId("copilot-account-card-personal");
    expect(personal).toHaveTextContent("Personal subscription");
    expect(personal).toHaveTextContent("Not connected");
    const enterprise = screen.getByTestId("copilot-account-card-enterprise");
    expect(enterprise).toHaveTextContent("Enterprise plan");
    expect(enterprise).toHaveTextContent("GitHub App");

    await user.click(
      within(personal).getByRole("button", { name: "Sign in with GitHub" }),
    );
    expect(onToken).toHaveBeenCalledWith("gho_test");
  });

  it("opens the enterprise plan wizard from its card and closes it again", async () => {
    const user = userEvent.setup();
    render(
      <CopilotAccountCards keys={[own]} pending={false} onToken={vi.fn()} />,
    );
    expect(screen.queryByTestId("copilot-account-card-personal")).toBeNull();
    expect(screen.queryByTestId("copilot-plan-dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByTestId("copilot-plan-dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("copilot-plan-dialog")).toBeNull();
  });

  it("keeps the sign-in on offer when only a plan is connected, and nothing once both are", () => {
    const { rerender } = render(
      <CopilotAccountCards keys={[plan]} pending={false} onToken={vi.fn()} />,
    );
    expect(
      screen.getByTestId("copilot-account-card-personal"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("copilot-account-card-enterprise")).toBeNull();
    rerender(
      <CopilotAccountCards
        keys={[own, plan]}
        pending={false}
        onToken={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("copilot-account-cards")).toBeNull();
  });

  it("gates connecting a plan on the permission to create provider keys", () => {
    grant({});
    render(<CopilotAccountCards keys={[]} pending={false} onToken={vi.fn()} />);
    // The permission button stays focusable for its tooltip.
    expect(screen.getByRole("button", { name: "Connect" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // A sign-in is self-service.
    expect(
      screen.getByRole("button", { name: "Sign in with GitHub" }),
    ).toBeEnabled();
  });

  it("holds the sign-in while the personal key is being saved", () => {
    render(<CopilotAccountCards keys={[]} pending onToken={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Sign in with GitHub" }),
    ).toBeDisabled();
  });
});
