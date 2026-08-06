import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyMount } from "./lazy-mount";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Stands in for the browser's observer, handing the test its callback so the
 * test decides when the element comes into view. jsdom has no layout, so a
 * real observer would never report an intersection on its own.
 */
function stubIntersectionObserver() {
  const callbacks: IntersectionObserverCallback[] = [];
  const disconnectSpy = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = disconnectSpy;
    },
  );
  return {
    scrollIntoView: () =>
      act(() => {
        for (const callback of callbacks) {
          callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            {} as IntersectionObserver,
          );
        }
      }),
    disconnectSpy,
  };
}

describe("LazyMount", () => {
  it("holds the children back until the element scrolls into view", () => {
    const observer = stubIntersectionObserver();
    render(
      <LazyMount height={200}>
        <p>expensive</p>
      </LazyMount>,
    );

    expect(screen.queryByText("expensive")).not.toBeInTheDocument();
    observer.scrollIntoView();
    expect(screen.getByText("expensive")).toBeInTheDocument();
  });

  it("keeps the children mounted once they have arrived", () => {
    const observer = stubIntersectionObserver();
    render(
      <LazyMount height={200}>
        <p>expensive</p>
      </LazyMount>,
    );

    observer.scrollIntoView();
    // Scrolling away must not tear a built editor down for the next scroll
    // back to rebuild, so the observer is dropped rather than kept watching.
    expect(observer.disconnectSpy).toHaveBeenCalled();
    expect(screen.getByText("expensive")).toBeInTheDocument();
  });

  it("mounts the children outright where there is no observer to wait on", () => {
    // jsdom, and any browser old enough to lack one. Rendering nothing at all
    // would trade a performance cost for a correctness one.
    expect(globalThis.IntersectionObserver).toBeUndefined();
    render(
      <LazyMount height={200}>
        <p>expensive</p>
      </LazyMount>,
    );

    expect(screen.getByText("expensive")).toBeInTheDocument();
  });
});
