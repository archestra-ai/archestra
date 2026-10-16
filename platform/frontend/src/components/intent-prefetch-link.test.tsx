import { fireEvent, render, screen } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntentPrefetchLink } from "./intent-prefetch-link";

vi.mock("next/navigation");

const prefetch = vi.fn();

beforeEach(() => {
  prefetch.mockReset();
  vi.mocked(useRouter).mockReturnValue({
    prefetch,
  } as unknown as ReturnType<typeof useRouter>);
});

// Checked by type-check: a caller cannot pass prefetch and turn viewport
// prefetch back on.
// @ts-expect-error prefetch is fixed to on-intent
void (<IntentPrefetchLink href="/agents" prefetch />);

describe("IntentPrefetchLink", () => {
  it("does not prefetch when it renders", () => {
    render(<IntentPrefetchLink href="/agents/a1">Agent</IntentPrefetchLink>);

    expect(screen.getByRole("link", { name: "Agent" })).toHaveAttribute(
      "href",
      "/agents/a1",
    );
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("prefetches the route on hover, focus and touch", () => {
    render(<IntentPrefetchLink href="/agents/a1">Agent</IntentPrefetchLink>);
    const link = screen.getByRole("link", { name: "Agent" });

    fireEvent.mouseEnter(link);
    expect(prefetch).toHaveBeenLastCalledWith("/agents/a1");

    fireEvent.focus(link);
    expect(prefetch).toHaveBeenCalledTimes(2);
    expect(prefetch).toHaveBeenLastCalledWith("/agents/a1");

    fireEvent.touchStart(link);
    expect(prefetch).toHaveBeenCalledTimes(3);
    expect(prefetch).toHaveBeenLastCalledWith("/agents/a1");
  });

  it("prefetches a UrlObject href with its query and hash", () => {
    render(
      <IntentPrefetchLink
        href={{
          pathname: "/agents",
          query: { tab: "runs", label: ["a", "b"], empty: undefined },
          hash: "#top",
        }}
      >
        Agents
      </IntentPrefetchLink>,
    );

    fireEvent.mouseEnter(screen.getByRole("link", { name: "Agents" }));

    expect(prefetch).toHaveBeenCalledWith(
      "/agents?tab=runs&label=a&label=b#top",
    );
  });

  it.each([
    "https://docs.example.com/guide",
    "mailto:team@example.com",
    "//cdn.example.com/file",
    { protocol: "https:", host: "docs.example.com", pathname: "/guide" },
  ])("does not prefetch a link to another site (%o)", (href) => {
    const onPrefetch = vi.fn();
    render(
      <IntentPrefetchLink href={href} onPrefetch={onPrefetch}>
        Elsewhere
      </IntentPrefetchLink>,
    );

    fireEvent.mouseEnter(screen.getByRole("link", { name: "Elsewhere" }));

    expect(prefetch).not.toHaveBeenCalled();
    expect(onPrefetch).not.toHaveBeenCalled();
  });

  it("still runs the caller's hover, focus and touch handlers", () => {
    const onMouseEnter = vi.fn();
    const onFocus = vi.fn();
    const onTouchStart = vi.fn();
    const onPrefetch = vi.fn();
    render(
      <IntentPrefetchLink
        href="/apps"
        onMouseEnter={onMouseEnter}
        onFocus={onFocus}
        onTouchStart={onTouchStart}
        onPrefetch={onPrefetch}
      >
        Apps
      </IntentPrefetchLink>,
    );
    const link = screen.getByRole("link", { name: "Apps" });

    fireEvent.mouseEnter(link);
    fireEvent.focus(link);
    fireEvent.touchStart(link);

    expect(onMouseEnter).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onTouchStart).toHaveBeenCalledTimes(1);
    expect(onPrefetch).toHaveBeenCalledTimes(3);
    expect(onPrefetch).toHaveBeenCalledWith("/apps");
  });
});
