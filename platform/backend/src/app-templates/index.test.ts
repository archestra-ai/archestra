import { describe, expect, test } from "vitest";
import { resolveCreateAppHtml } from "./index";

describe("resolveCreateAppHtml", () => {
  test("injects the app name into the seeded default template", () => {
    const { html, seededFromTemplate } = resolveCreateAppHtml({
      name: "Sales Dashboard",
    });
    expect(seededFromTemplate).toBe(true);
    expect(html).toContain("<title>Sales Dashboard</title>");
    expect(html).toContain("<h1>Sales Dashboard</h1>");
    expect(html).not.toContain("{{APP_NAME}}");
  });

  test("HTML-escapes a name with special characters", () => {
    const { html } = resolveCreateAppHtml({ name: "Tom & Jerry <v2>" });
    expect(html).toContain("Tom &amp; Jerry &lt;v2&gt;");
    expect(html).not.toContain("Tom & Jerry <v2>");
  });

  test("falls back to a neutral name when none is given", () => {
    const { html } = resolveCreateAppHtml({});
    expect(html).toContain("<h1>My App</h1>");
    expect(html).not.toContain("{{APP_NAME}}");
  });

  test("explicit html wins and is not templated", () => {
    const explicit = "<html><head></head><body>{{APP_NAME}}</body></html>";
    const { html, seededFromTemplate } = resolveCreateAppHtml({
      html: explicit,
      name: "Ignored",
    });
    expect(seededFromTemplate).toBe(false);
    expect(html).toBe(explicit);
  });
});
