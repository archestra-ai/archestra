import { UNRESTRICTED_ROLE_RESOURCE_ACCESS } from "@archestra/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/lib/organization.query";
import { RoleResourceAccessBuilder } from "./role-resource-access-builder.ee";

vi.mock("@/lib/organization.query");

const providers = () => screen.getByTestId("role-access-modelProviders");

describe("RoleResourceAccessBuilder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useOrganization).mockReturnValue({
      data: { modelProviderOverrides: null },
    } as unknown as ReturnType<typeof useOrganization>);
  });

  // An unrestricted role owns the whole catalog. Rendering it as an empty box
  // would read as "none allowed", which is the opposite of what it means.
  it("shows an unrestricted role as every chip", () => {
    render(
      <RoleResourceAccessBuilder
        resourceAccess={UNRESTRICTED_ROLE_RESOURCE_ACCESS}
        onChange={vi.fn()}
      />,
    );

    expect(within(providers()).getByText("OpenAI")).toBeVisible();
    expect(within(providers()).getByText("Anthropic")).toBeVisible();
  });

  it("writes an explicit list when a chip is removed from an unrestricted role", async () => {
    const onChange = vi.fn();
    render(
      <RoleResourceAccessBuilder
        resourceAccess={UNRESTRICTED_ROLE_RESOURCE_ACCESS}
        onChange={onChange}
      />,
    );

    const chip = within(providers()).getByText("OpenAI").closest("span");
    await userEvent.click(
      within(chip as HTMLElement).getByRole("button", {
        name: /remove selected option/i,
      }),
    );

    const next = onChange.mock.calls[0][0];
    expect(next.modelProviders).not.toContain("openai");
    expect(next.modelProviders).toContain("anthropic");
    // Untouched catalogs stay unrestricted.
    expect(next.messagingChannels).toBeNull();
  });

  it("offers no edits on a read-only role", () => {
    render(
      <RoleResourceAccessBuilder
        resourceAccess={UNRESTRICTED_ROLE_RESOURCE_ACCESS}
        onChange={vi.fn()}
        readOnly
      />,
    );

    for (const remove of within(providers()).getAllByRole("button", {
      name: /remove selected option/i,
    })) {
      expect(remove).toBeDisabled();
    }
  });

  it("says out loud that an empty list means nothing is allowed", () => {
    render(
      <RoleResourceAccessBuilder
        resourceAccess={{
          ...UNRESTRICTED_ROLE_RESOURCE_ACCESS,
          messagingChannels: [],
        }}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText("This role cannot use any messaging channel."),
    ).toBeVisible();
  });
});
