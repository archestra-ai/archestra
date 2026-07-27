import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { providerLogoUrl, providerToLogoProvider } from "./provider-logos";

describe("provider logos", () => {
  // Logos are bundled (not fetched from models.dev) so they render when
  // third-party requests are blocked. Adding a provider to the map without
  // adding its SVG under public/model-logos would bring back the broken-icon
  // bug this pins against.
  it.each(
    Object.entries(providerToLogoProvider),
  )("bundles a logo file for %s", (_provider, logoName) => {
    expect(
      existsSync(
        join(__dirname, "../../public/model-logos", `${logoName}.svg`),
      ),
    ).toBe(true);
  });

  it("builds a same-origin URL", () => {
    expect(providerLogoUrl("anthropic")).toBe("/model-logos/anthropic.svg");
    expect(providerLogoUrl("ollama")).toBe("/model-logos/ollama-cloud.svg");
  });
});
