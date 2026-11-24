import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import archestraCliRoutes from "./archestra-cli.routes";

describe("GET /api/archestra-cli/install.sh and install.ps1", () => {
  const ctx = useRouteTestApp(archestraCliRoutes);

  test("serves the shell script as text, which runs all of it at the end", async () => {
    const response = await ctx.app.inject({
      url: "/api/archestra-cli/install.sh",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.startsWith("#!/bin/sh\n")).toBe(true);
    // A download that stops halfway runs nothing: the last line calls the
    // one function that does the work.
    expect(response.body.trimEnd().split("\n").at(-1)).toBe(
      'archestra_setup "$@"',
    );
    expect(response.body).toContain('target="$(uname -s)-$(uname -m)"');
    expect(response.body).toContain('"$url/api/archestra-cli/$target"');
    expect(response.body).toContain('bridge start "$@"');
  });

  test("serves the PowerShell script, which reads the address and the setup code from the environment", async () => {
    const response = await ctx.app.inject({
      url: "/api/archestra-cli/install.ps1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.body).toContain("$env:ARCHESTRA_URL");
    expect(response.body).toContain("$env:ARCHESTRA_SETUP_CODE");
    expect(response.body).toContain('"$url/api/archestra-cli/$target"');
    expect(response.body).toContain("@('bridge', 'start', '--url', $url)");
  });
});
