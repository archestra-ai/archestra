import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it } from "vitest";
import { preloadableLazy } from "./preloadable-lazy";

function Greeting({ name }: { name: string }) {
  return <p>Hello {name}</p>;
}

describe("preloadableLazy", () => {
  it("shows the fallback until the module loads, then the component", async () => {
    let resolve: (module: { default: typeof Greeting }) => void = () => {};
    const { Component } = preloadableLazy(
      () =>
        new Promise<{ default: typeof Greeting }>((r) => {
          resolve = r;
        }),
    );
    render(
      <Suspense fallback={<p>plain</p>}>
        <Component name="Ada" />
      </Suspense>,
    );
    expect(screen.getByText("plain")).toBeInTheDocument();

    await act(async () => resolve({ default: Greeting }));
    expect(screen.getByText("Hello Ada")).toBeInTheDocument();
  });

  it("renders in the first pass once preloaded, without the fallback", async () => {
    const { Component, preload } = preloadableLazy(async () => ({
      default: Greeting,
    }));
    await preload();

    const { container } = render(
      <Suspense fallback={<p>plain</p>}>
        <Component name="Grace" />
      </Suspense>,
    );
    // Synchronous: no act/await between render and the assertion.
    expect(container).toHaveTextContent("Hello Grace");
    expect(screen.queryByText("plain")).not.toBeInTheDocument();
  });
});
