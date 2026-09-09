import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  FloatingActionBar,
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "./settings-block";

vi.mock("@/lib/auth/auth.query");

describe("FloatingActionBar", () => {
  it("floats its actions in a sticky bar when there is no stack to portal into", () => {
    // The shape the agent, skill and plugin detail pages render it in: on their
    // own, not inside a SettingsSectionStack, so the bar sticks from where it
    // stands instead of riding away at the foot of a long form.
    render(
      <FloatingActionBar>
        <button type="button">Save changes</button>
      </FloatingActionBar>,
    );

    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save.closest(".sticky")).not.toBeNull();
  });

  it("moves into the stack's slot when rendered inside one", () => {
    const { container } = render(
      <SettingsSectionStack>
        <FloatingActionBar>
          <button type="button">Save changes</button>
        </FloatingActionBar>
      </SettingsSectionStack>,
    );

    const stack = container.firstElementChild as HTMLElement;
    const slot = stack.lastElementChild as HTMLElement;
    expect(slot.className).toContain("sticky");
    expect(slot).toContainElement(
      screen.getByRole("button", { name: "Save changes" }),
    );
  });
});

describe("SettingsBlock", () => {
  it("renders a semantic section with an accessible heading", () => {
    render(
      <SettingsBlock
        title="Default model"
        description="Pick the model used by default."
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Default model" }),
    ).toBeVisible();
    expect(screen.getByText("Pick the model used by default.")).toBeVisible();
  });

  it("supports an aligned control and full-width content", () => {
    render(
      <SettingsBlock
        title="Default model"
        description="Pick the model used by default."
        control={<button type="button">Reset</button>}
      >
        <div>Advanced controls</div>
      </SettingsBlock>,
    );

    expect(screen.getByRole("button", { name: "Reset" })).toBeVisible();
    expect(screen.getByText("Advanced controls")).toBeVisible();
  });
});

describe("SettingsSaveBar", () => {
  beforeEach(() => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
  });

  const renderStack = (ui: React.ReactNode) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsSectionStack>{ui}</SettingsSectionStack>
      </QueryClientProvider>,
    );

  const bar = (label: string) => (
    <SettingsSaveBar
      hasChanges
      isSaving={false}
      permissions={{ organizationSettings: ["update"] }}
      onSave={() => {}}
      onCancel={() => {}}
      key={label}
    />
  );

  it("renders nothing until there is something to save", () => {
    const { container } = renderStack(
      <SettingsSaveBar
        hasChanges={false}
        isSaving={false}
        permissions={{ organizationSettings: ["update"] }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    // The slot collapses rather than leaving a gap at the foot of the page.
    expect(container.querySelector(".sticky")?.childElementCount ?? 0).toBe(0);
  });

  it("floats at the foot of the stack, not where the page declared it", () => {
    // A page that declares its save bar between two sections — the shape that
    // stopped the bar floating, because `position: sticky` only lifts a box
    // that would otherwise fall below the viewport.
    const { container } = renderStack(
      <>
        <div data-testid="first-section" />
        {bar("page")}
        <div data-testid="trailing-section" />
      </>,
    );

    const stack = container.firstElementChild as HTMLElement;
    const last = stack.lastElementChild as HTMLElement;

    expect(last.className).toContain("sticky");
    expect(last).toContainElement(screen.getByRole("button", { name: "Save" }));
    expect(
      screen.getByTestId("trailing-section").compareDocumentPosition(last),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("stacks two bars in one slot instead of piling them at the same offset", () => {
    renderStack(
      <>
        {bar("first")}
        <div data-testid="between" />
        {bar("second")}
      </>,
    );

    const saves = screen.getAllByRole("button", { name: "Save" });
    expect(saves).toHaveLength(2);
    expect(saves[0].closest(".sticky")).toBe(saves[1].closest(".sticky"));
  });
});
