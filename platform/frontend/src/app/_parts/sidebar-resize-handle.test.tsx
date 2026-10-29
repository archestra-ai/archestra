import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import {
  SidebarResizeHandle,
  useSidebarWidthState,
} from "./sidebar-resize-handle";

describe("SidebarResizeHandle", () => {
  beforeEach(() => window.localStorage.clear());

  it("resizes the sidebar and remembers the width after a reload", () => {
    const first = render(<Shell />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(handle).toHaveAttribute("aria-valuenow", "240");

    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(handle).toHaveAttribute("aria-valuenow", "280");
    expect(
      screen.getByTestId("wrapper").style.getPropertyValue("--sidebar-width"),
    ).toBe("280px");
    first.unmount();

    render(<Shell />);
    expect(
      screen.getByRole("separator", { name: "Resize sidebar" }),
    ).toHaveAttribute("aria-valuenow", "280");
  });

  it("keeps the width within bounds and resets on double-click", () => {
    render(<Shell />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });

    fireEvent.keyDown(handle, { key: "End" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "480");

    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "200");

    fireEvent.doubleClick(handle);
    expect(handle).toHaveAttribute("aria-valuenow", "240");
  });

  it("closes the sidebar when dragged well past the minimum, keeping the earlier width", () => {
    Element.prototype.setPointerCapture = () => {};
    render(<Shell />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });

    fireEvent.pointerDown(handle, { button: 0, clientX: 240, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 210, pointerId: 1 });
    expect(handle).toHaveAttribute("aria-valuenow", "210");
    fireEvent.pointerMove(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(screen.getByTestId("sidebar-state")).toHaveTextContent("collapsed");
    expect(window.localStorage.getItem("archestra-sidebar-width")).toBe("240");
  });

  it("opens a collapsed sidebar when its rail is dragged out", () => {
    Element.prototype.setPointerCapture = () => {};
    render(<Shell defaultOpen={false} />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });

    fireEvent.pointerDown(handle, { button: 0, clientX: 48, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 80, pointerId: 1 });
    expect(screen.getByTestId("sidebar-state")).toHaveTextContent("collapsed");

    fireEvent.pointerMove(handle, { clientX: 308, pointerId: 1 });

    expect(screen.getByTestId("sidebar-state")).toHaveTextContent("expanded");
    expect(handle).toHaveAttribute("aria-valuenow", "308");
  });

  it("ignores a stored width outside the bounds", () => {
    window.localStorage.setItem("archestra-sidebar-width", "9000");
    render(<Shell />);
    expect(
      screen.getByRole("separator", { name: "Resize sidebar" }),
    ).toHaveAttribute("aria-valuenow", "480");
  });
});

function Shell({ defaultOpen = true }: { defaultOpen?: boolean }) {
  const sidebar = useSidebarWidthState();
  return (
    <SidebarProvider
      defaultOpen={defaultOpen}
      data-testid="wrapper"
      style={{ "--sidebar-width": `${sidebar.width}px` } as React.CSSProperties}
    >
      <SidebarResizeHandle
        width={sidebar.width}
        onWidthChange={sidebar.setWidth}
        onResizingChange={sidebar.setResizing}
      />
      <SidebarState />
    </SidebarProvider>
  );
}

function SidebarState() {
  return <span data-testid="sidebar-state">{useSidebar().state}</span>;
}
