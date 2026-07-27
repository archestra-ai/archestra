import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { User } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreateVirtualApiKey } from "@/lib/virtual-api-keys.query";
import { CreateVirtualKeyDialog } from "./create-virtual-key-dialog";

vi.mock("@/lib/virtual-api-keys.query", () => ({
  useCreateVirtualApiKey: vi.fn(),
}));
vi.mock("@/components/proxy-auth-provider-key-fields", () => ({
  ProviderKeyAccessFields: ({
    onProviderApiKeyIdsChange,
  }: {
    onProviderApiKeyIdsChange: (value: Record<string, string>) => void;
  }) => (
    <button
      type="button"
      onClick={() => onProviderApiKeyIdsChange({ openai: "provider-key-1" })}
    >
      Map provider key
    </button>
  ),
}));

const mutateAsync = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useCreateVirtualApiKey).mockReturnValue({
    isPending: false,
    mutateAsync,
  } as unknown as ReturnType<typeof useCreateVirtualApiKey>);
});

describe("CreateVirtualKeyDialog", () => {
  it("creates the passthrough type supplied by its resource tab without a type selector", async () => {
    const user = userEvent.setup();
    renderDialog("passthrough");

    expect(
      screen.getByRole("heading", { name: "Create Passthrough Key" }),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("My passthrough key"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Key type")).not.toBeInTheDocument();
    expect(screen.queryByText("Standard")).not.toBeInTheDocument();
    expect(screen.queryByText("Passthrough")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Name"), "My passthrough key");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      data: {
        name: "My passthrough key",
        keyType: "passthrough",
        expiresAt: undefined,
        ownerId: undefined,
      },
    });
  });

  it("creates the standard type supplied by its resource tab without a type selector", async () => {
    const user = userEvent.setup();
    renderDialog("standard");

    expect(
      screen.getByRole("heading", { name: "Create Virtual API Key" }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("My virtual key")).toBeInTheDocument();
    expect(screen.queryByText("Key type")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "My virtual key");
    await user.click(screen.getByRole("button", { name: "Map provider key" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(mutateAsync).toHaveBeenCalledWith({
      data: {
        name: "My virtual key",
        keyType: "standard",
        expiresAt: undefined,
        scope: "personal",
        teams: [],
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: "provider-key-1" },
        ],
        ownerId: undefined,
      },
    });
  });
});

function renderDialog(keyType: "standard" | "passthrough") {
  return render(
    <CreateVirtualKeyDialog
      open
      onOpenChange={vi.fn()}
      keyType={keyType}
      parentableKeys={[]}
      defaultExpirationSeconds={null}
      visibilityOptions={[
        {
          value: "personal",
          label: "Personal",
          description: "Only you can use this key",
          icon: User,
        },
      ]}
      teams={[]}
      canReadTeams={false}
      isVirtualKeyAdmin={false}
    />,
  );
}
