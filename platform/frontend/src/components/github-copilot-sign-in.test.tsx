import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GithubCopilotDeviceStart,
  usePollGithubCopilotDeviceFlow,
  useStartGithubCopilotDeviceFlow,
} from "@/lib/github-copilot-auth.query";
import { GithubCopilotSignIn } from "./github-copilot-sign-in";

vi.mock("@/lib/github-copilot-auth.query");

// The real CopyableCode reaches for the clipboard/toast; we only need the code
// and link to render so the flow view can be asserted.
vi.mock("@/components/copyable-code", () => ({
  CopyableCode: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

const DEVICE_START: GithubCopilotDeviceStart = {
  deviceCode: "device-code-123",
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
  interval: 5,
  expiresIn: 900,
};

const startMutate = vi.fn();
const pollMutate = vi.fn();
let openSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  startMutate.mockResolvedValue(DEVICE_START);
  // Resolve as still-pending so the polling effect just reschedules a timer
  // (never fired under real timers within a test) instead of completing.
  pollMutate.mockResolvedValue({ status: "pending" });
  vi.mocked(useStartGithubCopilotDeviceFlow).mockReturnValue({
    mutateAsync: startMutate,
    isPending: false,
  } as unknown as ReturnType<typeof useStartGithubCopilotDeviceFlow>);
  vi.mocked(usePollGithubCopilotDeviceFlow).mockReturnValue({
    mutateAsync: pollMutate,
  } as unknown as ReturnType<typeof usePollGithubCopilotDeviceFlow>);
  openSpy = vi.spyOn(window, "open").mockReturnValue(null);
});

afterEach(() => {
  openSpy.mockRestore();
});

describe("GithubCopilotSignIn", () => {
  it("shows the start button and does not fetch a code on mount by default", () => {
    render(<GithubCopilotSignIn onToken={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: /sign in with github/i }),
    ).toBeInTheDocument();
    expect(startMutate).not.toHaveBeenCalled();
  });

  it("auto-starts the fetch step on mount, showing the code without opening a tab", async () => {
    render(<GithubCopilotSignIn autoStart onToken={vi.fn()} />);

    // The code + link appear from the automatic fetch, no click required.
    expect(await screen.findByText(DEVICE_START.userCode)).toBeInTheDocument();
    expect(startMutate).toHaveBeenCalledTimes(1);
    // The provider tab must never open automatically — that is a separate click.
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("opens the verification page only on the explicit open click, with noopener", async () => {
    render(<GithubCopilotSignIn autoStart onToken={vi.fn()} />);
    await screen.findByText(DEVICE_START.userCode);

    await userEvent.click(
      screen.getByRole("button", { name: /open github sign-in/i }),
    );

    expect(openSpy).toHaveBeenCalledExactlyOnceWith(
      DEVICE_START.verificationUri,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("auto-fetches at most once under strict mode's double mount", async () => {
    render(
      <StrictMode>
        <GithubCopilotSignIn autoStart onToken={vi.fn()} />
      </StrictMode>,
    );

    await screen.findByText(DEVICE_START.userCode);
    expect(startMutate).toHaveBeenCalledTimes(1);
  });
});
