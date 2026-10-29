import { afterEach, describe, expect, test } from "vitest";
import {
  buildSelector,
  describeElement,
  findAnchorElement,
  toRoutePattern,
} from "./element-anchor";

describe("toRoutePattern", () => {
  test("replaces record ids with their param names", () => {
    expect(
      toRoutePattern({
        pathname: "/chat/8f3a-11",
        routeParams: { conversationId: "8f3a-11" },
      }),
    ).toBe("/chat/[conversationId]");
  });

  test("collapses a catch-all into one placeholder", () => {
    expect(
      toRoutePattern({
        pathname: "/docs/a/b/c",
        routeParams: { slug: ["a", "b", "c"] },
      }),
    ).toBe("/docs/[...slug]");
  });
});

describe("buildSelector", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("finds the same element on a page that shows different data", () => {
    document.body.innerHTML = `
      <main>
        <section data-testid="agent-list">
          <div><p>Agent Alpha</p></div>
          <div><p>Agent Beta</p><button id="radix-r1">Edit</button></div>
        </section>
      </main>`;
    const button = document.querySelector("button");
    if (!button) throw new Error("fixture");
    const selector = buildSelector(button);

    document.body.innerHTML = `
      <main>
        <section data-testid="agent-list">
          <div><p>Zeta</p></div>
          <div><p>Omega</p><button id="radix-r9">Edit</button></div>
        </section>
      </main>`;

    expect(
      findAnchorElement(selector)?.previousElementSibling?.textContent,
    ).toBe("Omega");
  });

  test("ignores test ids that embed record ids", () => {
    document.body.innerHTML = `
      <div data-testid="row-8f3a1b2c-1111-2222-3333-444455556666"><span>x</span></div>`;
    const span = document.querySelector("span");
    if (!span) throw new Error("fixture");

    expect(buildSelector(span)).toBe("body > div > span");
  });
});

describe("describeElement", () => {
  test("names the element by its nearest labelled ancestor and its text", () => {
    document.body.innerHTML = `
      <div data-testid="private-mode-banner"><p>Use this mode for highly sensitive work. This chat is private</p></div>`;
    const paragraph = document.querySelector("p");
    if (!paragraph) throw new Error("fixture");

    expect(describeElement(paragraph)).toBe(
      'private-mode-banner › p "Use this mode for highly sensitive work.…"',
    );
  });
});
