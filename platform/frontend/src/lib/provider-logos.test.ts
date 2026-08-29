import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  logoNameForProvider,
  providerLogoUrl,
  providerToLogoProvider,
} from "./provider-logos";

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

  it("uses the Grok mark for a SuperGrok subscription on xAI", () => {
    expect(logoNameForProvider("xai")).toBe("xai");
    expect(logoNameForProvider("xai", null)).toBe("xai");
    expect(logoNameForProvider("xai", "x-premium")).toBe("grok");
    expect(logoNameForProvider("openai", "chatgpt")).toBe("openai");
    expect(
      existsSync(join(__dirname, "../../public/model-logos", "grok.svg")),
    ).toBe(true);
  });
});
