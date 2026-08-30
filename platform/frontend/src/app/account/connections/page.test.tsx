import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AccountConnectionsPage from "./page";

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const mocks = vi.hoisted(() => ({
  disconnect: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
}));
vi.mock("@/lib/config/config.query", () => ({
  useFeature: (feature: string) => feature === "agentBackgroundExecution",
}));
vi.mock("@/lib/execution-credentials.query", () => ({
  useExecutionCredentials: () => ({
    data: [
      {
        key: "github",
        name: "GitHub",
        description: "Repository access",
        icon: "logo:github",
        builtIn: true,
        allowPersonal: true,
        allowOrganization: false,
        personalConfigured: true,
        organizationConfigured: false,
      },
    ],
    isPending: false,
    isError: false,
  }),
  useDeleteExecutionCredentialConnection: () => ({
    mutate: mocks.disconnect,
    isPending: false,
  }),
}));

describe("AccountConnectionsPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("confirms before removing a personal connection", async () => {
    const user = userEvent.setup();
    render(<AccountConnectionsPage />);

    await user.click(
      screen.getByRole("button", { name: "More actions GitHub" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Disconnect" }));

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Background executions you start will no longer be able to use this connection.",
    );
    expect(mocks.disconnect).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(mocks.disconnect).toHaveBeenCalledWith(
      { key: "github", name: "GitHub", scope: "personal" },
      expect.any(Object),
    );
  });
});
