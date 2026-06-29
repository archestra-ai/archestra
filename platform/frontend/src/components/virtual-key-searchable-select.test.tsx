import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VirtualKeySearchableSelect } from "./virtual-key-searchable-select";

describe("VirtualKeySearchableSelect", () => {
  it("calls onValueChange with virtual key id", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <VirtualKeySearchableSelect
        value=""
        onValueChange={onValueChange}
        virtualKeys={[
          {
            id: "key-456",
            name: "Production Key",
            providerApiKeys: [
              {
                provider: "openai",
                providerApiKeyId: "pk-1",
                providerApiKeyName: "Main API Key",
              },
            ],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /Production Key/i }));

    expect(onValueChange).toHaveBeenCalledWith("key-456");
  });

  it("renders provider logo and name for virtual key with provider", async () => {
    const user = userEvent.setup();

    render(
      <VirtualKeySearchableSelect
        value=""
        onValueChange={vi.fn()}
        virtualKeys={[
          {
            id: "key-1",
            name: "Production Key",
            providerApiKeys: [
              {
                provider: "openai",
                providerApiKeyId: "pk-1",
                providerApiKeyName: "Main API Key",
              },
            ],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    expect(screen.getByText("Production Key")).toBeInTheDocument();
    expect(screen.getByText(/Main API Key/i)).toBeInTheDocument();
  });

  it("renders virtual key without provider info", async () => {
    const user = userEvent.setup();

    render(
      <VirtualKeySearchableSelect
        value=""
        onValueChange={vi.fn()}
        virtualKeys={[
          {
            id: "key-1",
            name: "Test Key",
            providerApiKeys: [],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    expect(screen.getByText("Test Key")).toBeInTheDocument();
  });

  it("filters virtual keys by name search query", async () => {
    const user = userEvent.setup();

    render(
      <VirtualKeySearchableSelect
        value=""
        onValueChange={vi.fn()}
        virtualKeys={[
          {
            id: "key-1",
            name: "Production Key",
            providerApiKeys: [
              {
                provider: "openai",
                providerApiKeyId: "pk-1",
                providerApiKeyName: "Prod API",
              },
            ],
          },
          {
            id: "key-2",
            name: "Staging Key",
            providerApiKeys: [
              {
                provider: "anthropic",
                providerApiKeyId: "pk-2",
                providerApiKeyName: "Staging API",
              },
            ],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(
      screen.getByPlaceholderText("Search virtual keys..."),
      "Staging",
    );

    expect(screen.queryByText("Production Key")).not.toBeInTheDocument();
    expect(screen.getByText("Staging Key")).toBeInTheDocument();
  });

  it("filters virtual keys by provider search query", async () => {
    const user = userEvent.setup();

    render(
      <VirtualKeySearchableSelect
        value=""
        onValueChange={vi.fn()}
        virtualKeys={[
          {
            id: "key-1",
            name: "Key One",
            providerApiKeys: [
              {
                provider: "openai",
                providerApiKeyId: "pk-1",
                providerApiKeyName: "OpenAI API",
              },
            ],
          },
          {
            id: "key-2",
            name: "Key Two",
            providerApiKeys: [
              {
                provider: "anthropic",
                providerApiKeyId: "pk-2",
                providerApiKeyName: "Anthropic API",
              },
            ],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(
      screen.getByPlaceholderText("Search virtual keys..."),
      "openai",
    );

    expect(screen.getByText("Key One")).toBeInTheDocument();
    expect(screen.queryByText("Key Two")).not.toBeInTheDocument();
  });

  it("filters virtual keys by parent key name search query", async () => {
    const user = userEvent.setup();

    render(
      <VirtualKeySearchableSelect
        value=""
        onValueChange={vi.fn()}
        virtualKeys={[
          {
            id: "key-1",
            name: "Key One",
            providerApiKeys: [
              {
                provider: "openai",
                providerApiKeyId: "pk-1",
                providerApiKeyName: "Main API",
              },
            ],
          },
          {
            id: "key-2",
            name: "Key Two",
            providerApiKeys: [
              {
                provider: "anthropic",
                providerApiKeyId: "pk-2",
                providerApiKeyName: "Backup API",
              },
            ],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(
      screen.getByPlaceholderText("Search virtual keys..."),
      "Backup",
    );

    expect(screen.queryByText("Key One")).not.toBeInTheDocument();
    expect(screen.getByText("Key Two")).toBeInTheDocument();
  });

  it("shows empty message when no virtual keys match", async () => {
    const user = userEvent.setup();

    render(
      <VirtualKeySearchableSelect
        value=""
        onValueChange={vi.fn()}
        virtualKeys={[]}
      />,
    );

    await user.click(screen.getByRole("combobox"));

    expect(
      screen.getByText("No matching virtual keys found."),
    ).toBeInTheDocument();
  });

  it("shows custom empty message when provided", async () => {
    const user = userEvent.setup();

    render(
      <VirtualKeySearchableSelect
        value=""
        onValueChange={vi.fn()}
        virtualKeys={[]}
        emptyMessage="No keys available"
      />,
    );

    await user.click(screen.getByRole("combobox"));

    expect(screen.getByText("No keys available")).toBeInTheDocument();
  });
});
