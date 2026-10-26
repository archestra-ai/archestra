import { act, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { parseSidebarOpen } from "@/lib/sidebar-state";
import { useSidebarOpenState } from "./use-sidebar-open";

describe("sidebar state across server rendering and hydration", () => {
  beforeEach(() => {
    localStorage.clear();
    setCookie("sidebar_state=; path=/; max-age=0");
  });
  afterEach(() => vi.restoreAllMocks());

  for (const open of [false, true]) {
    it(`renders the ${open ? "expanded" : "collapsed"} cookie before hydration and never commits the other state`, async () => {
      setCookie(`sidebar_state=${open}; path=/`);
      localStorage.setItem("archestra-sidebar-open", String(open));
      const states: boolean[] = [];
      const shell = (
        <Shell initialOpen={open} onPaint={(state) => states.push(state)} />
      );
      const container = document.createElement("div");
      container.innerHTML = renderToString(shell);
      expect(container.textContent).toBe(open ? "Expanded" : "Collapsed");

      let root: ReturnType<typeof hydrateRoot>;
      await act(async () => {
        root = hydrateRoot(container, shell);
      });
      expect(states).toEqual([open]);
      await act(async () => root.unmount());
    });

    it(`restores an older ${open ? "expanded" : "collapsed"} local-storage preference without painting the wrong shell`, async () => {
      localStorage.setItem("archestra-sidebar-open", String(open));
      const states: boolean[] = [];
      const shell = (
        <Shell initialOpen={null} onPaint={(state) => states.push(state)} />
      );
      const container = document.createElement("div");
      container.innerHTML = renderToString(shell);
      expect(container.textContent).toBe("");
      let root: ReturnType<typeof hydrateRoot>;
      await act(async () => {
        root = hydrateRoot(container, shell);
      });
      expect(container.textContent).toBe(open ? "Expanded" : "Collapsed");
      expect(states).toEqual([open]);
      expect(document.cookie).toContain(`sidebar_state=${open}`);
      await act(async () => root.unmount());
    });
  }

  it("keeps the server cookie when local storage is stale or unavailable", () => {
    setCookie("sidebar_state=false; path=/");
    localStorage.setItem("archestra-sidebar-open", "true");
    const first = render(<Shell initialOpen={false} />);
    expect(screen.getByRole("button")).toHaveTextContent("Collapsed");
    first.unmount();

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    render(<Shell initialOpen={false} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("Expanded");
    expect(document.cookie).toContain("sidebar_state=true");
  });

  it("opens by default for an invalid preference and remembers subsequent toggles", () => {
    setCookie("sidebar_state=invalid; path=/");
    localStorage.setItem("archestra-sidebar-open", "invalid");
    render(<Shell initialOpen={parseSidebarOpen("invalid")} />);
    expect(screen.getByRole("button")).toHaveTextContent("Expanded");
    fireEvent.click(screen.getByRole("button"));
    expect(localStorage.getItem("archestra-sidebar-open")).toBe("false");
    expect(document.cookie).toContain("sidebar_state=false");
    expect(screen.getByRole("button")).toHaveTextContent("Collapsed");
  });

  it("keeps an in-memory choice when both storage mechanisms are blocked", () => {
    vi.spyOn(document, "cookie", "get").mockImplementation(() => {
      throw new Error("Cookies disabled");
    });
    vi.spyOn(document, "cookie", "set").mockImplementation(() => {
      throw new Error("Cookies disabled");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    render(<Shell initialOpen={null} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("Collapsed");
  });
});

function Shell({
  initialOpen,
  onPaint,
}: {
  initialOpen: boolean | null;
  onPaint?: (open: boolean) => void;
}) {
  const [open, setOpen] = useSidebarOpenState(initialOpen);
  useLayoutEffect(() => {
    if (open !== null) onPaint?.(open);
  }, [open, onPaint]);
  if (open === null) return null;
  return (
    <Button onClick={() => setOpen(!open)}>
      {open ? "Expanded" : "Collapsed"}
    </Button>
  );
}

function setCookie(value: string) {
  // biome-ignore lint/suspicious/noDocumentCookie: exercise real browser cookie persistence
  document.cookie = value;
}
