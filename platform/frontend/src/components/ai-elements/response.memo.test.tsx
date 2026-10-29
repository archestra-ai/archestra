import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { preloadResponseMarkdown, Response } from "./response";

const parses = vi.hoisted(() => ({ count: 0 }));
vi.mock("streamdown", () => ({
  defaultRemarkPlugins: {},
  defaultRehypePlugins: {},
  Streamdown: ({ children }: { children: string }) => {
    parses.count += 1;
    return <div>{children}</div>;
  },
}));
vi.mock("@streamdown/code", () => ({ code: {} }));

beforeAll(() => preloadResponseMarkdown());

describe("Response", () => {
  it("does not re-render (re-parse) a message whose text has not changed", () => {
    const { rerender } = render(
      <Response linkSafety={{ enabled: true }}>Some **markdown**</Response>,
    );
    // A parent re-render hands over fresh callbacks and objects each time.
    rerender(
      <Response linkSafety={{ enabled: true }}>Some **markdown**</Response>,
    );
    rerender(
      <Response linkSafety={{ enabled: true }}>Some **markdown**</Response>,
    );
    expect(parses.count).toBe(1);

    rerender(<Response>Some **more** markdown</Response>);
    expect(parses.count).toBe(2);
  });
});
