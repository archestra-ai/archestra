import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onGithubAppSetup as onGuardrailsSetup } from "@/app/openappa/_parts/github-app-channel";
import {
  notifyGithubAppSetup,
  onGithubAppSetup,
} from "@/components/github-app-setup/github-app-window";
import { useCompleteCopilotGithubApp } from "@/lib/github-copilot-app.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { COPILOT_SETUP_CHANNEL } from "../_parts/copilot-github-app-setup";
import CopilotGithubAppReturnPage from "./page";

vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/github-copilot-app.query", () => ({
  useCompleteCopilotGithubApp: vi.fn(),
}));
// The deployment's own logo and name, as every sign-in page shows them.
vi.mock("@/components/app-logo", () => ({
  AppLogo: () => <div>Deployment logo</div>,
}));

function completion(extra?: Record<string, unknown>) {
  return {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    ...extra,
  };
}

async function open(search: string) {
  window.history.replaceState(
    null,
    "",
    `/llm/model-providers/github-app${search}`,
  );
  render(<CopilotGithubAppReturnPage />);
  // The page reads GitHub's answer in a microtask.
  await act(async () => {});
}

beforeEach(() => {
  vi.mocked(useAppName).mockReturnValue("My App");
  vi.spyOn(window, "close").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CopilotGithubAppReturnPage", () => {
  it("saves the created App, branded as the deployment", async () => {
    const complete = completion({ isPending: true });
    vi.mocked(useCompleteCopilotGithubApp).mockReturnValue(complete as never);
    await open("?code=one-time&state=s1");

    expect(screen.getByText("Deployment logo")).toBeInTheDocument();
    expect(screen.getByText("Connecting the GitHub App")).toBeInTheDocument();
    expect(
      screen.getByText("Saving it to My App. This takes a few seconds."),
    ).toBeInTheDocument();
    expect(screen.getByText("Saving the GitHub App")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(complete.mutate).toHaveBeenCalledWith(
      { code: "one-time", state: "s1" },
      expect.anything(),
    );
    // GitHub's code leaves the address bar.
    expect(window.location.search).toBe("");
  });

  it("says the App was created and tells the connect dialog", async () => {
    const listener = vi.fn();
    const stop = onGithubAppSetup(listener, COPILOT_SETUP_CHANNEL);
    const complete = completion({
      mutate: vi.fn((_body, options) => options.onSuccess()),
    });
    vi.mocked(useCompleteCopilotGithubApp).mockReturnValue(complete as never);
    await open("?code=one-time&state=s1");

    expect(screen.getByText("GitHub App created")).toBeInTheDocument();
    expect(
      screen.getByText("Go back to My App to install it."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close this tab" }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open Model Providers" }),
    ).toHaveAttribute("href", "/llm/model-providers");
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith("created"));
    stop();
  });

  it("says the App was installed", async () => {
    vi.mocked(useCompleteCopilotGithubApp).mockReturnValue(
      completion() as never,
    );
    await open("?installation_id=5&setup_action=install");

    expect(screen.getByText("GitHub App installed")).toBeInTheDocument();
    expect(
      screen.getByText("Go back to My App to finish."),
    ).toBeInTheDocument();
  });

  it("says what went wrong and where to start again", async () => {
    vi.mocked(useCompleteCopilotGithubApp).mockReturnValue(
      completion({
        isError: true,
        error: new Error("GitHub App setup expired. Create the App again."),
      }) as never,
    );
    await open("?code=one-time&state=s1");

    expect(
      screen.getByText("GitHub App setup didn't finish"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Setup expired. Create the App again."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Start again in My App" }),
    ).toHaveAttribute("href", "/llm/model-providers");
    expect(screen.queryByText(/OpenAPPA|Guardrails|Git sync/)).toBeNull();
  });
});

describe("GitHub App setup channels", () => {
  it("keeps Copilot's and Guardrails' setups apart, both ways", async () => {
    const copilot = vi.fn();
    const guardrails = vi.fn();
    const stopCopilot = onGithubAppSetup(copilot, COPILOT_SETUP_CHANNEL);
    const stopGuardrails = onGuardrailsSetup(guardrails);

    notifyGithubAppSetup("installed", COPILOT_SETUP_CHANNEL);
    await vi.waitFor(() => expect(copilot).toHaveBeenCalledWith("installed"));
    const { notifyGithubAppSetup: notifyGuardrails } = await import(
      "@/app/openappa/_parts/github-app-channel"
    );
    notifyGuardrails("created");
    await vi.waitFor(() => expect(guardrails).toHaveBeenCalledWith("created"));
    // Let any stray message arrive before checking it didn't.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(copilot).toHaveBeenCalledTimes(1);
    expect(guardrails).toHaveBeenCalledTimes(1);
    stopCopilot();
    stopGuardrails();
  });
});
