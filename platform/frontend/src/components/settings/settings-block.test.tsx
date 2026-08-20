import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  SettingsCardHeader,
  SettingsSaveBar,
  SettingsSectionStack,
} from "./settings-block";

vi.mock("@/lib/auth/auth.query");

describe("SettingsCardHeader", () => {
  it("adds spacing between the title and description", () => {
    const { container } = render(
      <SettingsCardHeader
        title="Default model"
        description="Pick the model used by default."
      />,
    );

    expect(container.querySelector(".space-y-1\\.5")).toBeTruthy();
    expect(screen.getByText("Pick the model used by default.")).toBeVisible();
  });

  it("vertically centers the action area", () => {
    const { container } = render(
      <SettingsCardHeader
        title="Default model"
        description="Pick the model used by default."
        action={<button type="button">Reset</button>}
      />,
    );

    expect(container.querySelector(".items-center")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset" })).toBeVisible();
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
