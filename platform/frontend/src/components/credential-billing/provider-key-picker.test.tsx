import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import type { ProviderApiKeyMappings } from "@/components/provider-key-mappings-field";
import { useSession } from "@/lib/auth/auth.query";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useOrganization } from "@/lib/organization.query";
import { ProviderKeyPicker } from "./provider-key-picker";

vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/llm-models.query", () => ({
  useModelsWithApiKeys: vi.fn(),
}));

const providerApiKeys = [
  { id: "openai-prod", name: "OpenAI prod", provider: "openai", scope: "org" },
  {
    id: "openai-staging",
    name: "OpenAI staging",
    provider: "openai",
    scope: "team",
    teamName: "Platform",
  },
  { id: "glm", name: "GLM gateway", provider: "vllm", scope: "org" },
  { id: "deepseek", name: "DeepSeek gateway", provider: "vllm", scope: "org" },
] as LlmProviderApiKeyResponse[];

beforeEach(() => {
  vi.mocked(useOrganization).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "u-self" } },
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useModelsWithApiKeys).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useModelsWithApiKeys>);
});

describe("ProviderKeyPicker", () => {
  it("keeps one key for a hosted provider", async () => {
    const user = userEvent.setup();
    renderPicker([{ provider: "openai", providerApiKeyId: "openai-prod" }]);

    await user.click(screen.getByRole("radio", { name: "OpenAI staging" }));

    expect(selection()).toHaveTextContent("OpenAI · OpenAI staging");
    expect(selection()).not.toHaveTextContent("OpenAI prod");
  });

  it("maps every endpoint of a self-hosted provider", async () => {
    const user = userEvent.setup();
    renderPicker([]);

    await user.click(
      screen.getByRole("button", { name: /OpenAI-compatible\s*2 keys/ }),
    );
    await user.click(screen.getByRole("checkbox", { name: "GLM gateway" }));
    await user.click(
      screen.getByRole("checkbox", { name: "DeepSeek gateway" }),
    );
    expect(selection()).toHaveTextContent("GLM gateway");
    expect(selection()).toHaveTextContent("DeepSeek gateway");

    await user.click(
      within(selection()).getByRole("button", {
        name: "Remove OpenAI-compatible · GLM gateway",
      }),
    );
    expect(selection()).not.toHaveTextContent("GLM gateway");
    expect(selection()).toHaveTextContent("DeepSeek gateway");
  });
});

function selection() {
  return screen.getByRole("region", { name: "Selected provider keys" });
}

function renderPicker(initial: ProviderApiKeyMappings) {
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <ProviderKeyPicker
        value={value}
        onChange={setValue}
        providerApiKeys={providerApiKeys}
      />
    );
  }
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
}
