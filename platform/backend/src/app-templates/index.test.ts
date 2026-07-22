import OrganizationModel from "@/models/organization";
import { describe, expect, test } from "@/test";
import { getAppTemplates, resolveCreateAppHtml } from "./index";

const PNG_LOGO =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==";
const PNG_LOGO_DARK =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADklEQVR42mNk+M9QDwADgQF/e5IkGQAAAABJRU5ErkJggg==";
// A marker unique to the default Archestra mark's SVG.
const ARCHESTRA_MARK = 'viewBox="0 0 994 953"';

describe("resolveCreateAppHtml", () => {
  test("injects the app name into the seeded default template", async () => {
    const { html, seededFromTemplate } = await resolveCreateAppHtml({
      name: "Sales Dashboard",
    });
    expect(seededFromTemplate).toBe(true);
    expect(html).toContain("<title>Sales Dashboard</title>");
    expect(html).toContain("<h1>Sales Dashboard</h1>");
    expect(html).not.toContain("{{APP_NAME}}");
    expect(html).not.toContain("{{APP_LOGO}}");
  });

  test("HTML-escapes a name with special characters", async () => {
    const { html } = await resolveCreateAppHtml({ name: "Tom & Jerry <v2>" });
    expect(html).toContain("Tom &amp; Jerry &lt;v2&gt;");
    expect(html).not.toContain("Tom & Jerry <v2>");
  });

  test("falls back to a neutral name when none is given", async () => {
    const { html } = await resolveCreateAppHtml({});
    expect(html).toContain("<h1>My App</h1>");
    expect(html).not.toContain("{{APP_NAME}}");
  });

  test("explicit html wins and is not templated", async () => {
    const explicit = "<html><head></head><body>{{APP_NAME}}</body></html>";
    const { html, seededFromTemplate } = await resolveCreateAppHtml({
      html: explicit,
      name: "Ignored",
    });
    expect(seededFromTemplate).toBe(false);
    expect(html).toBe(explicit);
  });

  test("seeds the Archestra mark when no white-label logo is configured", async ({
    makeOrganization,
  }) => {
    await makeOrganization();
    const { html } = await resolveCreateAppHtml({ name: "My App" });
    expect(html).toContain(ARCHESTRA_MARK);
    expect(html).toContain('aria-label="Archestra"');
    expect(html).not.toContain("<img");
  });

  test("seeds the organization's icon logo instead of the Archestra mark", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      iconLogo: PNG_LOGO,
      appName: "Acme Portal",
    });
    const { html } = await resolveCreateAppHtml({ name: "My App" });
    expect(html).toContain(`<img src="${PNG_LOGO}"`);
    expect(html).toContain('aria-label="Acme Portal"');
    expect(html).not.toContain(ARCHESTRA_MARK);
    expect(html).not.toContain("{{APP_LOGO}}");
  });

  test("emits light and dark images when a dark variant is configured", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      iconLogo: PNG_LOGO,
      iconLogoDark: PNG_LOGO_DARK,
    });
    const { html } = await resolveCreateAppHtml({ name: "My App" });
    expect(html).toContain(`<img class="logo-light" src="${PNG_LOGO}"`);
    expect(html).toContain(`<img class="logo-dark" src="${PNG_LOGO_DARK}"`);
  });

  test("falls back to the full logo when no icon logo is configured", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, { logo: PNG_LOGO });
    const { html } = await resolveCreateAppHtml({ name: "My App" });
    expect(html).toContain(`<img src="${PNG_LOGO}"`);
    expect(html).not.toContain(ARCHESTRA_MARK);
  });

  test("uses the dark variant for both themes when it is the only one configured", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, { iconLogoDark: PNG_LOGO_DARK });
    const { html } = await resolveCreateAppHtml({ name: "My App" });
    expect(html).toContain(`<img src="${PNG_LOGO_DARK}"`);
    expect(html).not.toContain('class="logo-dark"');
    expect(html).not.toContain(ARCHESTRA_MARK);
  });

  test("seeds without a logo when the configured logo would exceed the app HTML limit", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const hugeLogo = `data:image/png;base64,${"A".repeat(600 * 1024)}`;
    await OrganizationModel.patch(org.id, { iconLogo: hugeLogo });
    const { html } = await resolveCreateAppHtml({ name: "My App" });
    expect(html).not.toContain("<img");
    expect(html).not.toContain(ARCHESTRA_MARK);
    expect(html).not.toContain("{{APP_LOGO}}");
    expect(html).toContain("<h1>My App</h1>");
  });
});

describe("getAppTemplates", () => {
  test("resolves both tokens in the preview html", async () => {
    const [template] = await getAppTemplates();
    expect(template.html).toContain("<h1>My App</h1>");
    expect(template.html).toContain(ARCHESTRA_MARK);
    expect(template.html).not.toContain("{{APP_NAME}}");
    expect(template.html).not.toContain("{{APP_LOGO}}");
  });

  test("previews the white-label logo when configured", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, { iconLogo: PNG_LOGO });
    const [template] = await getAppTemplates();
    expect(template.html).toContain(`<img src="${PNG_LOGO}"`);
    expect(template.html).not.toContain(ARCHESTRA_MARK);
  });
});
