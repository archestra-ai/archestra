import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("next/image", () => ({
  default: ({
    alt,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { alt: string }) => (
    <img alt={alt} {...props} />
  ),
}));
vi.mock("@/lib/model-pools.query", () => ({
  useModelPools: vi.fn(),
  useUpdateModelPool: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useLlmProviderApiKeys: () => ({
    data: [{ id: "key", name: "Z.ai", provider: "zhipuai", userId: null }],
  }),
}));
vi.mock("@/lib/llm-models.query", () => ({
  useModelsWithApiKeys: () => ({ data: [] }),
}));
vi.mock("@/components/virtual-key-connection-base-url", () => ({
  useConnectionBaseUrl: () => "http://localhost:9000/v1",
}));

import { useHasPermissions } from "@/lib/auth/auth.query";
import { type ModelPool, useModelPools } from "@/lib/model-pools.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import { EditPoolDialog } from "./edit-pool-dialog";

const NOW = Date.now();

function pool(benchedUntil: string | null): ModelPool {
  return {
    id: "pool",
    organizationId: "org",
    name: "glm-5",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    virtualApiKeyIds: [],
    members: ["glm-5", "glm-5-air"].map((modelId) => ({
      id: modelId,
      poolId: "pool",
      providerApiKeyId: "key",
      providerApiKeyName: "Z.ai",
      provider: "zhipuai",
      modelId,
      priority: 1,
      weight: 1,
      enabled: true,
      createdAt: new Date(NOW).toISOString(),
      benchedUntil: modelId === "glm-5" ? benchedUntil : null,
      benchReason:
        modelId === "glm-5" && benchedUntil ? "rate_limited (429)" : null,
    })),
  } as ModelPool;
}

describe("EditPoolDialog", () => {
  beforeEach(() => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useOrganization).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useAppearanceSettings>);
  });

  it("keeps edits in progress when the list refetches with new status", async () => {
    const user = userEvent.setup();
    const saved = pool(null);
    vi.mocked(useModelPools).mockReturnValue({
      data: [saved],
    } as unknown as ReturnType<typeof useModelPools>);
    const { rerender } = render(
      <EditPoolDialog
        pool={saved}
        onOpenChange={() => {}}
        onConnect={() => {}}
      />,
    );

    const weight = screen.getAllByRole("spinbutton", { name: /Weight/ })[0];
    await user.clear(weight);
    await user.type(weight, "5");

    // The 5 s refetch brings a new pool object: the member is now benched.
    const refetched = pool(new Date(NOW + 20_000).toISOString());
    vi.mocked(useModelPools).mockReturnValue({
      data: [refetched],
    } as unknown as ReturnType<typeof useModelPools>);
    rerender(
      <EditPoolDialog
        pool={refetched}
        onOpenChange={() => {}}
        onConnect={() => {}}
      />,
    );

    expect(
      screen.getAllByRole("spinbutton", { name: /Weight/ })[0],
    ).toHaveValue(5);
    expect(screen.getByText(/Cooling down · \d+ s/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it.each([
    ["Weight", ""],
    ["Weight", "0"],
    ["Weight", "1001"],
  ])("keeps Save off while %s is %j", async (field, value) => {
    const user = userEvent.setup();
    const saved = pool(null);
    vi.mocked(useModelPools).mockReturnValue({
      data: [saved],
    } as unknown as ReturnType<typeof useModelPools>);
    render(
      <EditPoolDialog
        pool={saved}
        onOpenChange={() => {}}
        onConnect={() => {}}
      />,
    );
    const input = screen.getAllByRole("spinbutton", {
      name: new RegExp(field),
    })[0];
    await user.clear(input);
    if (value) await user.type(input, value);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("asks before Cancel discards edits", async () => {
    const user = userEvent.setup();
    const saved = pool(null);
    vi.mocked(useModelPools).mockReturnValue({
      data: [saved],
    } as unknown as ReturnType<typeof useModelPools>);
    const onOpenChange = vi.fn();
    render(
      <EditPoolDialog
        pool={saved}
        onOpenChange={onOpenChange}
        onConnect={() => {}}
      />,
    );
    const weight = screen.getAllByRole("spinbutton", { name: /Weight/ })[0];
    await user.clear(weight);
    await user.type(weight, "5");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByText("Discard unsaved changes?"),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
