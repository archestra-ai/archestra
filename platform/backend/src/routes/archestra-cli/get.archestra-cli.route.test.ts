import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import config from "@/config";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import archestraCliRoutes from "./archestra-cli.routes";

describe("GET /api/archestra-cli/:target", () => {
  const ctx = useRouteTestApp(archestraCliRoutes);
  let downloadDir: string;

  beforeEach(async () => {
    downloadDir = await mkdtemp(path.join(tmpdir(), "archestra-cli-"));
    await writeFile(
      path.join(downloadDir, "archestra-darwin-arm64"),
      "program for Apple silicon",
    );
  });
  afterEach(async () => {
    await rm(downloadDir, { recursive: true, force: true });
  });

  test("serves the program for the asked system", async () => {
    config.archestraCli.downloadDir = downloadDir;

    const response = await ctx.app.inject({
      url: "/api/archestra-cli/darwin-arm64",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="archestra"',
    );
    expect(response.body).toBe("program for Apple silicon");
  });

  test("a system named as uname prints it gets the same file", async () => {
    config.archestraCli.downloadDir = downloadDir;

    const response = await ctx.app.inject({
      url: "/api/archestra-cli/Darwin-arm64",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("program for Apple silicon");
  });

  test("a CPU named the Linux way gets the same file", async () => {
    config.archestraCli.downloadDir = downloadDir;
    await writeFile(
      path.join(downloadDir, "archestra-linux-arm64"),
      "program for Linux arm64",
    );
    await writeFile(
      path.join(downloadDir, "archestra-linux-x86_64"),
      "program for Linux x86_64",
    );

    const arm = await ctx.app.inject({
      url: "/api/archestra-cli/linux-aarch64",
    });
    const intel = await ctx.app.inject({
      url: "/api/archestra-cli/Linux-amd64",
    });

    expect(arm.body).toBe("program for Linux arm64");
    expect(intel.body).toBe("program for Linux x86_64");
  });

  test("serves the .exe for Windows, named as PROCESSOR_ARCHITECTURE prints the CPU", async () => {
    config.archestraCli.downloadDir = downloadDir;
    await writeFile(
      path.join(downloadDir, "archestra-windows-x86_64.exe"),
      "program for Windows x64",
    );
    await writeFile(
      path.join(downloadDir, "archestra-windows-arm64.exe"),
      "program for Windows on Arm",
    );

    const intel = await ctx.app.inject({
      url: "/api/archestra-cli/windows-AMD64",
    });
    const arm = await ctx.app.inject({
      url: "/api/archestra-cli/windows-ARM64",
    });

    expect(intel.statusCode).toBe(200);
    expect(intel.headers["content-disposition"]).toBe(
      'attachment; filename="archestra.exe"',
    );
    expect(intel.body).toBe("program for Windows x64");
    expect(arm.body).toBe("program for Windows on Arm");
  });

  test("answers 404 for a system with no program, an unknown system, and a deployment that offers none", async () => {
    config.archestraCli.downloadDir = downloadDir;
    const noProgram = await ctx.app.inject({
      url: "/api/archestra-cli/darwin-x86_64",
    });
    const unknownSystem = await ctx.app.inject({
      url: "/api/archestra-cli/..%2F..%2Fetc%2Fpasswd",
    });
    // 32-bit PowerShell on 64-bit Windows says x86: no program for it.
    const unknownCpu = await ctx.app.inject({
      url: "/api/archestra-cli/windows-x86",
    });
    // The Windows file needs its .exe: a file with no suffix is not served.
    await writeFile(path.join(downloadDir, "archestra-windows-x86_64"), "x");
    const windowsWithoutExe = await ctx.app.inject({
      url: "/api/archestra-cli/windows-x86_64",
    });
    // A deployment with no folder, as one that runs outside the image.
    config.archestraCli.downloadDir = path.join(downloadDir, "missing");
    const notOffered = await ctx.app.inject({
      url: "/api/archestra-cli/darwin-arm64",
    });

    expect(noProgram.statusCode).toBe(404);
    expect(unknownSystem.statusCode).toBe(400);
    expect(unknownCpu.statusCode).toBe(400);
    expect(windowsWithoutExe.statusCode).toBe(404);
    expect(notOffered.statusCode).toBe(404);
    expect(notOffered.json().error.message).toContain("ARCHESTRA_CLI_DIR");
  });
});
