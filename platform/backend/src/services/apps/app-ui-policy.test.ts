import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { getAppTemplates } from "@/app-templates";
import { APP_HTML_MAX_BYTES } from "@/types/app";
import {
  APP_PLATFORM_CSP,
  buildValidatedVersionPayload,
  validateAppHtmlStatic,
} from "./app-ui-policy";

describe("APP_PLATFORM_CSP", () => {
  test("allows only static-asset CDNs — no connect/frame/base-uri egress", () => {
    expect(APP_PLATFORM_CSP.connectDomains).toBeUndefined();
    expect(APP_PLATFORM_CSP.frameDomains).toBeUndefined();
    expect(APP_PLATFORM_CSP.baseUriDomains).toBeUndefined();
    // bare hostnames only: the proxy HTML's client-side CSP builder injects
    // these into the guest meta-tag CSP
    for (const domain of APP_PLATFORM_CSP.resourceDomains ?? []) {
      expect(domain).toMatch(/^[a-z0-9.-]+$/);
    }
  });
});

describe("buildValidatedVersionPayload", () => {
  test("assembles the payload — html and permissions only, no CSP", async () => {
    const { payload, warnings } = await buildValidatedVersionPayload({
      html: "<html><head></head><body><h1/></body></html>",
    });
    expect(payload).toEqual({
      html: "<html><head></head><body><h1/></body></html>",
      uiPermissions: null,
    });
    expect(warnings).toEqual([]);
  });

  test("rejects an unknown permission key", async () => {
    await expect(
      buildValidatedVersionPayload({
        html: "<h1/>",
        // @ts-expect-error — exercising the runtime guard against unknown keys
        uiPermissions: { usb: {} },
      }),
    ).rejects.toThrow(/unknown app permission/);
  });

  test("accepts the whitelisted permission keys", async () => {
    const { payload } = await buildValidatedVersionPayload({
      html: "<h1/>",
      uiPermissions: { camera: {}, clipboardWrite: {} },
    });
    expect(payload.uiPermissions).toEqual({ camera: {}, clipboardWrite: {} });
  });

  test.each([
    "__ARCHESTRA_APP_SDK_URL__",
    "PostMessageTransport",
  ])("rejects html whose <script> bootstraps the SDK (%s)", async (marker) => {
    await expect(
      buildValidatedVersionPayload({
        html: `<html><head><script>const x = window.${marker};</script></head><body/></html>`,
      }),
    ).rejects.toThrow(/must not bootstrap the MCP App SDK/);
  });

  test("a bare < before the marker cannot evade the bootstrap rejection", async () => {
    // Script text is raw text to the browser; a comparison operator before the
    // marker must not hide it from the gate.
    await expect(
      buildValidatedVersionPayload({
        html: "<html><head><script>if (a < b) { const u = window.__ARCHESTRA_APP_SDK_URL__; }</script></head><body/></html>",
      }),
    ).rejects.toThrow(/must not bootstrap the MCP App SDK/);
  });

  test("a marker mentioned outside <script> does not reject", async () => {
    const { warnings } = await buildValidatedVersionPayload({
      html: "<html><head></head><body><p>Docs about PostMessageTransport and __ARCHESTRA_APP_SDK_URL__.</p><!-- PostMessageTransport --></body></html>",
    });
    expect(warnings).toEqual([]);
  });

  test("a module script using window.archestra passes clean", async () => {
    const { warnings } = await buildValidatedVersionPayload({
      html: '<html><head><script type="module">await window.archestra.storage.user.set("k", 1);</script></head><body/></html>',
    });
    expect(warnings).toEqual([]);
  });

  test("warns on a fragment without <head> or <html>", async () => {
    const { warnings } = await buildValidatedVersionPayload({
      html: "<h1>fragment</h1>",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no <head> or <html>");
  });

  test("rejects html that <link>s the platform stylesheet itself", async () => {
    await expect(
      buildValidatedVersionPayload({
        html: '<html><head><link rel="stylesheet" href="/_sandbox/archestra-app-base.css"></head><body/></html>',
      }),
    ).rejects.toThrow(/must not load the platform stylesheet/);
  });

  test("a whitespace-spliced href cannot slip the self-link past", async () => {
    await expect(
      buildValidatedVersionPayload({
        html: '<html><head><link rel="stylesheet" href="/_sandbox/archestra-app-\n\tbase.css"></head><body/></html>',
      }),
    ).rejects.toThrow(/must not load the platform stylesheet/);
  });

  test("an unrelated stylesheet link is allowed", async () => {
    const { warnings } = await buildValidatedVersionPayload({
      html: '<html><head><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/normalize.css"></head><body/></html>',
    });
    expect(warnings).toEqual([]);
  });

  test("rejects html over the byte cap", async () => {
    await expect(
      buildValidatedVersionPayload({
        html: `<html><head></head><body>${"z".repeat(APP_HTML_MAX_BYTES)}</body></html>`,
      }),
    ).rejects.toThrow(/byte limit/);
  });
});

describe("validateAppHtmlStatic", () => {
  test("a clean document yields no findings", async () => {
    const findings = await validateAppHtmlStatic(
      "<!doctype html><html><head><title>x</title></head><body><h1>hi</h1></body></html>",
    );
    expect(findings).toEqual([]);
  });

  test("SDK self-bootstrap is an error finding", async () => {
    const findings = await validateAppHtmlStatic(
      "<html><head><script>const x = window.__ARCHESTRA_APP_SDK_URL__;</script></head><body/></html>",
    );
    expect(findings).toContainEqual({
      severity: "error",
      message: expect.stringContaining("must not bootstrap the MCP App SDK"),
    });
  });

  test("a missing document root is a warning finding", async () => {
    const findings = await validateAppHtmlStatic("<h1>fragment</h1>");
    expect(findings).toEqual([
      {
        severity: "warning",
        message: expect.stringContaining("no <head> or <html>"),
      },
    ]);
  });

  test("a script host outside the CDN allowlist is a warning finding", async () => {
    const findings = await validateAppHtmlStatic(
      '<html><head><script src="https://evil.example.com/a.js"></script></head><body/></html>',
    );
    expect(findings).toContainEqual({
      severity: "warning",
      message: expect.stringContaining("evil.example.com"),
    });
  });

  test("a protocol-relative off-allowlist host is flagged once", async () => {
    const findings = await validateAppHtmlStatic(
      '<html><head><link href="//assets.example.org/x.css" rel="stylesheet"><link href="//assets.example.org/y.css" rel="stylesheet"></head><body/></html>',
    );
    const hostWarnings = findings.filter((f) =>
      /references the host "assets\.example\.org"/.test(f.message),
    );
    expect(hostWarnings).toHaveLength(1);
  });

  test("a resource ref inside an HTML comment does not warn", async () => {
    // The lint reads real DOM attributes (Rust `tl` walk), so a commented-out
    // tag — which the browser never loads — no longer counts as a reference.
    const findings = await validateAppHtmlStatic(
      '<html><head><!-- <script src="https://evil.example.com/a.js"></script> --></head><body/></html>',
    );
    expect(findings).toEqual([]);
  });

  test("allowlisted CDN hosts and relative refs are not flagged", async () => {
    const findings = await validateAppHtmlStatic(
      '<html><head><script src="https://cdn.jsdelivr.net/npm/x.js"></script><link rel="stylesheet" href="https://fonts.googleapis.com/css"><script src="/local.js"></script></head><body/></html>',
    );
    expect(findings).toEqual([]);
  });

  test.each([
    "localStorage",
    "sessionStorage",
    "indexedDB",
  ])("browser storage (%s) in a script is a warning naming the api and archestra.storage", async (api) => {
    const findings = await validateAppHtmlStatic(
      `<html><head><script>window.${api}.getItem("k");</script></head><body/></html>`,
    );
    expect(findings).toContainEqual({
      severity: "warning",
      message: expect.stringContaining(`Uses browser storage (${api})`),
    });
    expect(findings.at(-1)?.message).toContain("archestra.storage");
  });

  test("an api named only in prose or a comment does not warn", async () => {
    const findings = await validateAppHtmlStatic(
      "<html><head><!-- avoid localStorage --></head><body><p>This app does not use localStorage.</p></body></html>",
    );
    expect(findings).toEqual([]);
  });

  test("a bare < in ordinary script code does not hide the script from the lint", async () => {
    // Script text is raw text to the browser; a comparison operator must not
    // splinter the block and swallow what follows it.
    const findings = await validateAppHtmlStatic(
      '<html><head><script>if (items.length < 5) { localStorage.setItem("k", "1"); }</script></head><body/></html>',
    );
    expect(findings).toContainEqual({
      severity: "warning",
      message: expect.stringContaining("Uses browser storage (localStorage)"),
    });
  });

  test("multiple browser storage APIs are reported once, deduplicated", async () => {
    const findings = await validateAppHtmlStatic(
      "<html><head><script>localStorage.x; localStorage.y; sessionStorage.z;</script></head><body/></html>",
    );
    const storageWarnings = findings.filter((f) =>
      f.message.includes("Uses browser storage"),
    );
    expect(storageWarnings).toHaveLength(1);
    expect(storageWarnings[0].message).toContain(
      "localStorage, sessionStorage",
    );
    expect(storageWarnings[0].message).not.toMatch(
      /localStorage,.*localStorage/,
    );
  });

  test("calling a storage method on the store directly is a warning naming the partitions", async () => {
    const findings = await validateAppHtmlStatic(
      '<html><head><script>const x = await archestra.storage.get("k");</script></head><body/></html>',
    );
    expect(findings).toContainEqual({
      severity: "warning",
      message: expect.stringContaining("archestra.storage.get"),
    });
    const misuse = findings.find((f) =>
      f.message.includes("archestra.storage.get"),
    );
    expect(misuse?.message).toContain("archestra.storage.user.");
  });

  test("an unknown top-level archestra member is a warning naming the real surface", async () => {
    const findings = await validateAppHtmlStatic(
      "<html><head><script>archestra.tool.call('x');</script></head><body/></html>",
    );
    const unknown = findings.find((f) => f.message.startsWith("Uses "));
    expect(unknown?.severity).toBe("warning");
    // \b after "tool" so this names the offending archestra.tool, not the valid
    // archestra.tools it points at (a substring of it).
    expect(unknown?.message).toMatch(/\barchestra\.tool\b/);
    expect(unknown?.message).toContain("archestra.tools");
  });

  test("correct SDK usage yields no findings", async () => {
    const findings = await validateAppHtmlStatic(
      `<html><head><script>
        await archestra.ready;
        const me = archestra.user;
        const v = await archestra.storage.user.get("k");
        await archestra.storage.shared.set("k", 1);
        await archestra.tools.call("github__x", {});
        await archestra.llm.complete("hi");
        archestra.ui.openLink("/a/" + archestra.context.appId);
      </script></head><body/></html>`,
    );
    expect(findings).toEqual([]);
  });

  test("a bad archestra call named only in page prose does not warn", async () => {
    const findings = await validateAppHtmlStatic(
      "<html><head></head><body><p>Do not call archestra.storage.get directly.</p></body></html>",
    );
    expect(findings).toEqual([]);
  });

  test("a bad archestra call only inside a JS comment does not warn", async () => {
    const findings = await validateAppHtmlStatic(
      `<html><head><script>
        // use archestra.storage.user.get, not archestra.storage.get
        /* archestra.tool.call is also wrong */
        const x = 1;
      </script></head><body/></html>`,
    );
    expect(findings).toEqual([]);
  });

  test("repeated and distinct bad members are reported once per category", async () => {
    const findings = await validateAppHtmlStatic(
      `<html><head><script>
        archestra.storage.get("a"); archestra.storage.get("b"); archestra.storage.delete("c");
        archestra.tool.call(); archestra.tool.list();
      </script></head><body/></html>`,
    );
    const storageWarnings = findings.filter((f) =>
      f.message.startsWith("Accesses archestra.storage"),
    );
    expect(storageWarnings).toHaveLength(1);
    expect(storageWarnings[0].message).toContain(
      "archestra.storage.get, archestra.storage.delete",
    );
    const topWarnings = findings.filter((f) => f.message.startsWith("Uses"));
    expect(topWarnings).toHaveLength(1);
    // The offending member is listed once, even though .call and .list both hit
    // it. \b so the count ignores the valid archestra.tools in the surface list.
    expect(topWarnings[0].message.match(/\barchestra\.tool\b/g)).toHaveLength(
      1,
    );
  });
});

describe("starter templates pass the save gate", () => {
  test.each(
    getAppTemplates().map((t) => [t.id, t.html] as const),
  )("%s validates with no warnings (vars resolve against the base sheet)", async (_id, html) => {
    const { warnings } = await buildValidatedVersionPayload({ html });
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
