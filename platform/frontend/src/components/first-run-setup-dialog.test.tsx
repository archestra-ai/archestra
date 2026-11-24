import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix dialog needs these in jsdom
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

// The shell's gate is released in these tests.
vi.mock("@/lib/shell-deferral", () => ({ useShellReady: () => true }));
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");

const completeMutate = vi.fn();
const mockState: { setup: { show: boolean } | undefined } = {
  setup: { show: true },
};

vi.mock("@/lib/onboarding/onboarding.query", () => ({
  useFirstRunSetup: ({ enabled }: { enabled: boolean }) => ({
    data: enabled ? mockState.setup : undefined,
  }),
  useCompleteFirstRunSetup: () => ({
    mutate: completeMutate,
    isPending: false,
  }),
}));

import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { FirstRunSetupDialog } from "./first-run-setup-dialog";

beforeEach(() => {
  vi.clearAllMocks();
  mockState.setup = { show: true };
  window.history.replaceState(null, "", "/");
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
});

describe("FirstRunSetupDialog", () => {
  it("stays closed for non-admins", () => {
    vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
      typeof useHasPermissions
    >);
    render(<FirstRunSetupDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays closed when the setup is already finished", () => {
    mockState.setup = { show: false };
    render(<FirstRunSetupDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("subscribes the email and keeps telemetry on by default", async () => {
    const user = userEvent.setup();
    render(<FirstRunSetupDialog />);

    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.click(screen.getByRole("button", { name: "Subscribe" }));
    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(completeMutate).toHaveBeenCalledWith(
      { email: "admin@example.com", telemetryEnabled: true },
      expect.anything(),
    );
  });

  it("does not offer Subscribe for an invalid email", async () => {
    const user = userEvent.setup();
    render(<FirstRunSetupDialog />);

    await user.type(screen.getByLabelText("Email"), "admin@");

    expect(screen.getByRole("button", { name: "Subscribe" })).toBeDisabled();
  });

  it("sends no email when skipped, even if one was typed", async () => {
    const user = userEvent.setup();
    render(<FirstRunSetupDialog />);

    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.click(
      screen.getByRole("switch", { name: "Share product telemetry" }),
    );
    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(completeMutate).toHaveBeenCalledWith(
      { telemetryEnabled: false },
      expect.anything(),
    );
  });

  it("asks to keep telemetry on once it is turned off", async () => {
    const user = userEvent.setup();
    render(<FirstRunSetupDialog />);
    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(screen.queryByText(/kindly ask/)).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("switch", { name: "Share product telemetry" }),
    );
    expect(screen.getByText(/kindly ask/)).toBeInTheDocument();
  });

  it("closes once the setup is saved", async () => {
    completeMutate.mockImplementation((_body, options) => options.onSuccess());
    const user = userEvent.setup();
    render(<FirstRunSetupDialog />);

    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("preview opens the dialog and then works as for real", async () => {
    mockState.setup = { show: false };
    window.history.replaceState(null, "", "/?first-run-setup=preview");
    const user = userEvent.setup();
    render(<FirstRunSetupDialog />);

    await user.type(await screen.findByLabelText("Email"), "admin@example.com");
    await user.click(screen.getByRole("button", { name: "Subscribe" }));
    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(completeMutate).toHaveBeenCalledWith(
      { email: "admin@example.com", telemetryEnabled: true },
      expect.anything(),
    );
  });
});
