import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter, useSearchParams } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useOAuthClientInfo,
  useSubmitOAuthConsent,
} from "@/lib/auth/oauth.query";
import { postConnected } from "@/lib/connect-signal";
import { ConsentForm } from "./consent-form";

vi.mock("next/navigation");
vi.mock("@/lib/connect-signal");

vi.mock("@/lib/auth/oauth.query", () => ({
  useOAuthClientInfo: vi.fn(),
  useSubmitOAuthConsent: vi.fn(),
}));

const BASE_QUERY = "client_id=cursor-client&client_name=Cursor&scope=mcp";

function mockSearchParams(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>,
  );
}

function expSecondsFromNow(seconds: number) {
  return String(Math.floor(Date.now() / 1000) + seconds);
}

const mockPush = vi.fn();
const mockMutateAsync = vi.fn();

describe("ConsentForm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useRouter).mockReturnValue({
      push: mockPush,
    } as unknown as ReturnType<typeof useRouter>);

    mockSearchParams(BASE_QUERY);

    vi.mocked(useOAuthClientInfo).mockReturnValue({
      data: null,
    } as ReturnType<typeof useOAuthClientInfo>);

    vi.mocked(useSubmitOAuthConsent).mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useSubmitOAuthConsent>);
  });

  it("replaces the consent buttons with a return-to-app state for custom protocol redirects", async () => {
    const assignMock = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      assign: assignMock,
      replace: vi.fn(),
    });

    mockMutateAsync.mockResolvedValue({
      redirectTo: "cursor://oauth/callback?code=abc",
    });

    render(<ConsentForm />);

    await userEvent.click(screen.getByRole("button", { name: "Allow" }));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      accept: true,
      oauth_query: "client_id=cursor-client&client_name=Cursor&scope=mcp",
      scope: "mcp",
    });
    expect(assignMock).toHaveBeenCalledWith("cursor://oauth/callback?code=abc");
    expect(screen.getByText(/Returning you to/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /switch back to it manually/i }),
    ).toHaveAttribute("href", "cursor://oauth/callback?code=abc");
    expect(
      screen.getByText(
        /You can close this tab after the authorization flow completes/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Deny" }),
    ).not.toBeInTheDocument();
    // The Connect page, open in another tab, hears it once.
    expect(postConnected).toHaveBeenCalledTimes(1);
  });

  it("tells the Connect page nothing when consent is denied", async () => {
    const replaceMock = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      assign: vi.fn(),
      replace: replaceMock,
    });
    mockMutateAsync.mockResolvedValue({
      redirectTo: "http://localhost:1234/callback?error=access_denied",
    });

    render(<ConsentForm />);
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));

    expect(replaceMock).toHaveBeenCalledWith(
      "http://localhost:1234/callback?error=access_denied",
    );
    expect(postConnected).not.toHaveBeenCalled();
  });

  it("explains an expired request instead of offering buttons that cannot succeed", () => {
    mockSearchParams(`${BASE_QUERY}&exp=${expSecondsFromNow(-60)}&sig=abc`);

    render(<ConsentForm />);

    expect(screen.getByText("Request expired")).toBeInTheDocument();
    expect(
      screen.getByText(/Go back to Cursor and connect again/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Deny" }),
    ).not.toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("switches to the expired state when the page is left open past the expiry", () => {
    vi.useFakeTimers();
    mockSearchParams(`${BASE_QUERY}&exp=${expSecondsFromNow(600)}&sig=abc`);

    render(<ConsentForm />);
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(601_000);
    });

    expect(screen.getByText("Request expired")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow" }),
    ).not.toBeInTheDocument();
  });

  it("shows the server's reason when consent is rejected", async () => {
    mockMutateAsync.mockRejectedValue(
      new Error("This authorization request has expired."),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<ConsentForm />);
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));

    expect(
      screen.getByText("This authorization request has expired."),
    ).toBeInTheDocument();
  });
});
