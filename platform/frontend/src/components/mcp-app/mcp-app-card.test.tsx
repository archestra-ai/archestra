import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIN_CONTENT_ID } from "@/lib/app-shell-region";
import { McpAppCard } from "./mcp-app-card";

// The card observes the shell's main region so it tracks the sidebar's collapse
// animation; jsdom ships no ResizeObserver, and the initial measurement (which
// is what these assert) does not need one.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const SIDEBAR_WIDTH = 256;

function mountAppShellMain() {
  const main = document.createElement("main");
  main.id = MAIN_CONTENT_ID;
  main.getBoundingClientRect = () =>
    ({
      top: 0,
      left: SIDEBAR_WIDTH,
      width: window.innerWidth - SIDEBAR_WIDTH,
      height: window.innerHeight,
    }) as DOMRect;
  document.body.appendChild(main);
  return main;
}

afterEach(() => {
  document.getElementById(MAIN_CONTENT_ID)?.remove();
});

describe("McpAppCard fullscreen geometry", () => {
  it("fills the shell's main region rather than the viewport, leaving the sidebar on screen", () => {
    mountAppShellMain();

    const { container } = render(
      <McpAppCard displayMode="fullscreen" onToggleFullscreen={() => {}}>
        <div>app</div>
      </McpAppCard>,
    );

    const card = container.firstElementChild as HTMLElement;
    expect(card.style.left).toBe(`${SIDEBAR_WIDTH}px`);
    expect(card.style.width).toBe(`${window.innerWidth - SIDEBAR_WIDTH}px`);
  });

  it("falls back to the viewport where no shell is rendered (the standalone run page)", () => {
    const { container } = render(
      <McpAppCard displayMode="fullscreen" onToggleFullscreen={() => {}}>
        <div>app</div>
      </McpAppCard>,
    );

    const card = container.firstElementChild as HTMLElement;
    expect(card.style.left).toBe("0px");
    expect(card.style.width).toBe(`${window.innerWidth}px`);
  });

  it("takes no fixed geometry while inline", () => {
    mountAppShellMain();

    const { container } = render(
      <McpAppCard displayMode="inline" onToggleFullscreen={() => {}}>
        <div>app</div>
      </McpAppCard>,
    );

    const card = container.firstElementChild as HTMLElement;
    expect(card.style.width).toBe("");
    expect(card.className).not.toContain("fixed");
  });

  it("leaves fullscreen on Escape", async () => {
    mountAppShellMain();
    const onToggleFullscreen = vi.fn();

    render(
      <McpAppCard
        displayMode="fullscreen"
        onToggleFullscreen={onToggleFullscreen}
      >
        <div>app</div>
      </McpAppCard>,
    );

    await userEvent.keyboard("{Escape}");
    expect(onToggleFullscreen).toHaveBeenCalledOnce();
  });
});
