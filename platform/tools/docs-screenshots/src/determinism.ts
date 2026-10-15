import { createHash } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import type { SeedState } from "./seed";

/** Shared by the usage SQL fixtures and browser clock; independent of the run date. */
export const FIXTURE_TIME = "2026-10-14T12:00:00.000Z";
export const USAGE_TIMEFRAME =
  "custom:2026-09-14T12:00:00.000Z_2026-10-14T12:00:00.000Z";

/** Wait for real app/query loading to finish, including the sidebar spinner. */
export async function waitForAppReady(page: Page) {
  await expect(
    page.getByRole("status").filter({ hasText: /^Loading…$/ }),
  ).toHaveCount(0, { timeout: 15_000 });
}

/**
 * Normalize display-only identifiers after exercising the real UI/API. Do not
 * alter responses, stored records, or hrefs. No UI actions follow this step.
 * Known fixture ids keep their shape and identity; unrelated UUIDs stay visible.
 */
export async function normalizeIdentifiers(
  page: Page,
  seed: SeedState,
  target?: Locator,
) {
  const replacements = Object.entries(seed).flatMap(([kind, records]) =>
    Object.entries(records)
      .filter(([, id]) =>
        /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id),
      )
      .map(([name, id]) => {
        const hash = createHash("sha256")
          .update(`${kind}:${name}`)
          .digest("hex");
        return [
          id,
          `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4000-8000-${hash.slice(20, 32)}`,
        ];
      }),
  );
  await (target ?? page.locator("body")).evaluate((root, ids) => {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.parentElement?.closest("script, style")) {
        nodes.push(walker.currentNode as Text);
      }
    }
    const inputs = Array.from(root.querySelectorAll("input, textarea")).filter(
      (input): input is HTMLInputElement | HTMLTextAreaElement =>
        input instanceof HTMLInputElement ||
        input instanceof HTMLTextAreaElement,
    );
    // Preserve co-reference: equal tokens stay equal, distinct tokens stay
    // distinct, and a masked prefix keeps matching its full token if present.
    // Only lowercase credentials are normalized: casing/format bugs stay visible.
    const tokenPattern = /\barch_[\da-f]{8,64}(?:\*{3})?(?![\da-f])/g;
    const tokens = [
      ...nodes.map((node) => node.data),
      ...inputs.map((input) => input.value),
    ].flatMap((value) => value.match(tokenPattern) ?? []);
    const identity = (token: string) => {
      const prefix = token.replace(/\*{3}$/, "");
      return token.endsWith("***")
        ? (tokens.find(
            (candidate) =>
              !candidate.endsWith("***") && candidate.startsWith(prefix),
          ) ?? prefix)
        : token;
    };
    const identities = [...new Set(tokens.map(identity))];
    const normalize = (value: string) => {
      for (const [actual, example] of ids)
        value = value.replaceAll(actual, example);
      return value.replace(tokenPattern, (token) => {
        const masked = token.endsWith("***");
        const length = token.length - 5 - (masked ? 3 : 0);
        const ordinal = identities.indexOf(identity(token)) + 1;
        const example = `${ordinal.toString(16).padStart(8, "0")}${"0123456789abcdef".repeat(4)}`;
        return `arch_${example.slice(0, length)}${masked ? "***" : ""}`;
      });
    };
    for (const node of nodes) node.data = normalize(node.data);
    for (const input of inputs) input.value = normalize(input.value);
  }, replacements);
}
