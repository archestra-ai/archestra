import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { getAppTemplates } from "@/app-templates";
import { APP_HTML_MAX_BYTES } from "@/types/app";
import {
  APP_PLATFORM_CSP,
  buildValidatedVersionPayload,
} from "./app-ui-policy";

describe("APP_PLATFORM_CSP", () => {
  test("allows only static-asset CDNs — no connect/frame/base-uri egress", () => {
    expect(APP_PLATFORM_CSP.connectDomains).toBeUndefined();
    expect(APP_PLATFORM_CSP.frameDomains).toBeUndefined();
    expect(APP_PLATFORM_CSP.baseUriDomains).toBeUndefined();
    // bare hostnames only: both the inner sandbox CSP builder and the
    // serve-time sanitizeCspDomains filter accept exactly this form
    for (const domain of APP_PLATFORM_CSP.resourceDomains ?? []) {
      expect(domain).toMatch(/^[a-z0-9.-]+$/);
    }
  });
});

describe("buildValidatedVersionPayload", () => {
  test("assembles the payload — html and permissions only, no CSP", () => {
    const { payload, warnings } = buildValidatedVersionPayload({
      html: "<html><head></head><body><h1/></body></html>",
    });
    expect(payload).toEqual({
      html: "<html><head></head><body><h1/></body></html>",
      uiPermissions: null,
    });
    expect(warnings).toEqual([]);
  });

  test("rejects an unknown permission key", () => {
    expect(() =>
      buildValidatedVersionPayload({
        html: "<h1/>",
        // @ts-expect-error — exercising the runtime guard against unknown keys
        uiPermissions: { usb: {} },
      }),
    ).toThrow(/unknown app permission/);
  });

  test("accepts the whitelisted permission keys", () => {
    const { payload } = buildValidatedVersionPayload({
      html: "<h1/>",
      uiPermissions: { camera: {}, clipboardWrite: {} },
    });
    expect(payload.uiPermissions).toEqual({ camera: {}, clipboardWrite: {} });
  });

  test.each([
    "__ARCHESTRA_APP_SDK_URL__",
    "PostMessageTransport",
  ])("rejects html whose <script> bootstraps the SDK (%s)", (marker) => {
    expect(() =>
      buildValidatedVersionPayload({
        html: `<html><head><script>const x = window.${marker};</script></head><body/></html>`,
      }),
    ).toThrow(/must not bootstrap the MCP App SDK/);
  });

  test("a marker mentioned outside <script> does not reject", () => {
    const { warnings } = buildValidatedVersionPayload({
      html: "<html><head></head><body><p>Docs about PostMessageTransport and __ARCHESTRA_APP_SDK_URL__.</p><!-- PostMessageTransport --></body></html>",
    });
    expect(warnings).toEqual([]);
  });

  test("a module script using window.archestra passes clean", () => {
    const { warnings } = buildValidatedVersionPayload({
      html: '<html><head><script type="module">await window.archestra.storage.user.set("k", 1);</script></head><body/></html>',
    });
    expect(warnings).toEqual([]);
  });

  test("warns on a fragment without <head> or <html>", () => {
    const { warnings } = buildValidatedVersionPayload({
      html: "<h1>fragment</h1>",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no <head> or <html>");
  });

  test("rejects html that <link>s the platform stylesheet itself", () => {
    expect(() =>
      buildValidatedVersionPayload({
        html: '<html><head><link rel="stylesheet" href="/_sandbox/archestra-app-base.css"></head><body/></html>',
      }),
    ).toThrow(/must not load the platform stylesheet/);
  });

  test("a whitespace-spliced href cannot slip the self-link past", () => {
    expect(() =>
      buildValidatedVersionPayload({
        html: '<html><head><link rel="stylesheet" href="/_sandbox/archestra-app-\n base.css"></head><body/></html>',
      }),
    ).toThrow(/must not load the platform stylesheet/);
  });

  test("an unrelated stylesheet link is allowed", () => {
    const { warnings } = buildValidatedVersionPayload({
      html: '<html><head><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/normalize.css"></head><body/></html>',
    });
    expect(warnings).toEqual([]);
  });

  test("rejects html over the byte cap", () => {
    expect(() =>
      buildValidatedVersionPayload({
        html: `<html><head></head><body>${"z".repeat(APP_HTML_MAX_BYTES)}</body></html>`,
      }),
    ).toThrow(/byte limit/);
  });
});

describe("starter templates pass the save gate", () => {
  test.each(
    getAppTemplates().map((t) => [t.id, t.html] as const),
  )("%s validates with no warnings (vars resolve against the base sheet)", (_id, html) => {
    const { warnings } = buildValidatedVersionPayload({ html });
    expect(warnings).toEqual([]);
  });

  test("every CSS variable a template references is defined in the base sheet", () => {
    const baseCss = readFileSync(
      join(__dirname, "../../static/archestra-app-base.css"),
      "utf-8",
    );
    const defined = new Set(baseCss.match(/--[\w-]+(?=\s*:)/g) ?? []);
    for (const { id, html } of getAppTemplates()) {
      for (const ref of html.match(/var\(\s*(--[\w-]+)/g) ?? []) {
        const name = ref.replace(/var\(\s*/, "");
        expect(defined, `${id} references undefined ${name}`).toContain(name);
      }
    }
  });
});
