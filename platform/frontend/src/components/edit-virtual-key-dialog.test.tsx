import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdateVirtualApiKey } from "@/lib/virtual-api-keys.query";
import {
  type EditableVirtualKey,
  EditVirtualKeyDialog,
} from "./edit-virtual-key-dialog";

vi.mock("@/lib/virtual-api-keys.query", () => ({
  useUpdateVirtualApiKey: vi.fn(),
}));
vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useLlmProviderApiKeys: () => ({ data: [] }),
}));
vi.mock("@/components/proxy-auth-provider-key-fields", () => ({
  ProviderKeyAccessFields: () => <section>Provider Keys</section>,
}));
vi.mock("@/components/resource-access-section", () => ({
  ResourceAccessSection: ({
    resource,
    id,
  }: {
    resource: string;
    id?: string;
  }) => (
    <div data-testid="resource-access" data-resource={resource} data-id={id} />
  ),
}));

const mutateAsync = vi.fn();

const virtualKey = {
  id: "vk-1",
  name: "Team key",
  keyType: "standard",
  scope: "team",
  teams: [{ id: "team-1", name: "Platform" }],
  providerApiKeys: [{ provider: "openai", providerApiKeyId: "pak-1" }],
  labels: [],
  expiresAt: null,
} as unknown as EditableVirtualKey;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useUpdateVirtualApiKey).mockReturnValue({
    isPending: false,
    mutateAsync,
  } as unknown as ReturnType<typeof useUpdateVirtualApiKey>);
});

describe("EditVirtualKeyDialog", () => {
  it("edits access through the key's own permission policy", () => {
    render(
      <EditVirtualKeyDialog virtualKey={virtualKey} onOpenChange={vi.fn()} />,
    );

    const section = screen.getByTestId("resource-access");
    expect(section).toHaveAttribute("data-resource", "llmVirtualKey");
    expect(section).toHaveAttribute("data-id", "vk-1");
  });

  it("saves without rewriting the retired scope and team fields", async () => {
    // A converted key answers every access question from its grants. Sending
    // a scope here would write columns no read path consults, and would tell
    // the person their change took effect when it did not.
    const user = userEvent.setup();
    render(
      <EditVirtualKeyDialog virtualKey={virtualKey} onOpenChange={vi.fn()} />,
    );

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Renamed key");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const payload = mutateAsync.mock.calls[0]?.[0] as {
      id: string;
      data: Record<string, unknown>;
    };
    expect(payload.id).toBe("vk-1");
    expect(payload.data.name).toBe("Renamed key");
    expect(payload.data).not.toHaveProperty("scope");
    expect(payload.data).not.toHaveProperty("teams");
  });
});
