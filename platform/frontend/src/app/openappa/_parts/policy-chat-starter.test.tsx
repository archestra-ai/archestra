import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { beforeEach, expect, test, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useLlmModels } from "@/lib/llm-models.query";
import { useHasAnyApiKey } from "@/lib/llm-provider-api-keys.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { PolicyChatStarter } from "./policy-chat-starter";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/openappa-github-sync.query", () => ({
  useAppaGithubSync: vi.fn(),
}));
vi.mock("@/lib/llm-models.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm-models.query")>()),
  useLlmModels: vi.fn(),
}));
vi.mock("@/lib/llm-provider-api-keys.query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/llm-provider-api-keys.query")
  >()),
  useHasAnyApiKey: vi.fn(),
}));

const push = vi.fn();
const renderStarter = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PolicyChatStarter />
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  vi.mocked(useRouter).mockReturnValue({
    push,
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "test-user" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useAppaGithubSync).mockReturnValue({
    data: { source: null },
  } as ReturnType<typeof useAppaGithubSync>);
  vi.mocked(useHasAnyApiKey).mockReturnValue({
    hasAnyApiKey: true,
    isLoading: false,
    isLoadError: false,
    refetch: vi.fn(),
  });
  vi.mocked(useLlmModels).mockReturnValue({
    data: [
      { dbId: "model-1", id: "model-1", provider: "openai", isBest: true },
    ],
    isPending: false,
    isError: false,
  } as ReturnType<typeof useLlmModels>);
});

test("starts a chat with the requested policy change and preview instructions", async () => {
  renderStarter();
  fireEvent.change(
    screen.getByRole("textbox", {
      name: "Describe the OpenAPPA policy change",
    }),
    { target: { value: "Require approval for outbound messages" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Start policy chat" }));

  await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
  const url = new URL(push.mock.calls[0][0], "http://localhost");
  expect(url.pathname).toBe("/chat/new");
  expect(url.searchParams.get("user_prompt")).toContain(
    "Require approval for outbound messages",
  );
  expect(url.searchParams.get("user_prompt")).toContain(
    "preview and explain the diff",
  );
  expect(url.searchParams.get("modelId")).toBe("model-1");
});

test("offers provider setup when no chat credential is available", () => {
  vi.mocked(useHasAnyApiKey).mockReturnValue({
    hasAnyApiKey: false,
    isLoading: false,
    isLoadError: false,
    refetch: vi.fn(),
  });

  renderStarter();
  expect(screen.getByText("Connect an LLM provider")).toBeInTheDocument();
  expect(
    screen.queryByText("What should the policy do?"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", {
      name: "Describe the OpenAPPA policy change",
    }),
  ).not.toBeInTheDocument();
});

test("explains that synced changes become pull requests", () => {
  vi.mocked(useAppaGithubSync).mockReturnValue({
    data: { source: { interval: "1h", githubAppConfigId: "app-1" } },
  } as ReturnType<typeof useAppaGithubSync>);

  renderStarter();
  expect(screen.getByText(/opens a GitHub pull request/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Start policy chat" }),
  ).toBeEnabled();
});

test("asks for a GitHub App before proposing changes to a synced policy", () => {
  vi.mocked(useAppaGithubSync).mockReturnValue({
    data: { source: { interval: "1h", githubAppConfigId: null } },
  } as ReturnType<typeof useAppaGithubSync>);

  renderStarter();
  expect(screen.getByText("GitHub App needed")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Start policy chat" }),
  ).toBeDisabled();
});
