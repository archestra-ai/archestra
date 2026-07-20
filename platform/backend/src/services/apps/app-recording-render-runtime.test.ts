import { beforeEach, vi } from "vitest";
import { describe, expect, test } from "@/test";

/**
 * A filesystem and a package manager are the two boundaries this resolver is
 * made of, so they are the two things faked: which paths exist and are
 * executable, and what an install leaves behind. Everything between them —
 * the candidate order, the retry, the shared in-flight install — is the real
 * module.
 *
 * The fakes are hoisted rather than created inside the factories because each
 * case re-imports the module under test (see `loadRuntime`), which re-runs
 * those factories; a fake built inside one would be replaced with a fresh spy
 * the assertions below no longer hold a reference to.
 */
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  access: mocks.access,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: mocks.execFile,
}));

/** The paths the fake filesystem reports executable. An install adds to it. */
let executables: Set<string>;

beforeEach(() => {
  executables = new Set();
  mocks.access.mockImplementation(async (path: unknown) => {
    if (!executables.has(String(path))) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  });
  mocks.execFile.mockReset();
});

/**
 * A fresh copy of the resolver.
 *
 * It memoizes its answer for the life of the module — deliberately, so a
 * second export arriving mid-install joins the first rather than starting a
 * competing one — so a case that shares a copy reads the previous case's
 * cache instead of resolving. Config is re-imported alongside it: after the
 * reset the module under test binds a new config instance, and the pin has to
 * be written to that one.
 */
async function loadRuntime(chromiumPath?: string) {
  vi.resetModules();
  const config = (await import("@/config")).default;
  // Explicit either way, so a developer's own env cannot decide which branch
  // a case takes.
  config.hackathonRecorder.chromiumPath = chromiumPath;
  return await import("./app-recording-render-runtime");
}

/** Stand in for a package manager that succeeds, running `onInstall` first. */
function mockSuccessfulInstall(onInstall: () => void) {
  mocks.execFile.mockImplementation(((...args: unknown[]) => {
    onInstall();
    (args.at(-1) as (error: null, output: unknown) => void)(null, {
      stdout: "",
      stderr: "",
    });
  }) as never);
}

describe("render runtime", () => {
  test("uses a pinned browser without reaching for an installer", async () => {
    // A system browser is present too: the pin has to beat it, or a deployment
    // cannot override an image's headless shell — which carries no WebCodecs
    // encoder and so cannot render at all — with a full Chromium.
    executables.add("/usr/bin/chromium");
    executables.add("/opt/pinned/chrome");
    const { ensureRenderRuntime } = await loadRuntime("/opt/pinned/chrome");

    await expect(ensureRenderRuntime()).resolves.toStrictEqual({
      chromiumPath: "/opt/pinned/chrome",
      source: "configured",
    });
    // Reaching an installer in an environment that already has a browser is
    // the bug that made video export demand configuration nobody needed.
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  test("falls through to a system browser when no download is present", async () => {
    // The second candidate, not the first: the list is scanned, not sampled.
    executables.add("/usr/bin/chromium-browser");
    const { ensureRenderRuntime } = await loadRuntime();

    await expect(ensureRenderRuntime()).resolves.toStrictEqual({
      chromiumPath: "/usr/bin/chromium-browser",
      source: "system",
    });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  test("installs the distro browser on Alpine, then finds what it installed", async () => {
    executables.add("/sbin/apk");
    mockSuccessfulInstall(() => executables.add("/usr/bin/chromium"));
    const { ensureRenderRuntime } = await loadRuntime();

    await expect(ensureRenderRuntime()).resolves.toStrictEqual({
      chromiumPath: "/usr/bin/chromium",
      source: "system",
    });
    // The fonts ride along on purpose: Chromium's own dependencies bring a
    // single face, which leaves serif, sans and monospace identical and
    // renders emoji and CJK as empty boxes in the exported video.
    expect(mocks.execFile).toHaveBeenCalledWith(
      "/sbin/apk",
      [
        "add",
        "--no-cache",
        "chromium",
        "ttf-liberation",
        "font-noto",
        "font-noto-emoji",
      ],
      expect.anything(),
      expect.any(Function),
    );
  });

  test("concurrent exports share one install rather than racing it", async () => {
    executables.add("/sbin/apk");
    let installs = 0;
    mockSuccessfulInstall(() => {
      installs++;
      executables.add("/usr/bin/chromium");
    });
    const { ensureRenderRuntime } = await loadRuntime();

    const [first, second] = await Promise.all([
      ensureRenderRuntime(),
      ensureRenderRuntime(),
    ]);

    // A package manager takes a global lock, so a second export arriving
    // mid-download would otherwise fail on it.
    expect(installs).toBe(1);
    expect(second).toStrictEqual(first);
  });

  test("a failed install is retried by the next export, not remembered", async () => {
    executables.add("/sbin/apk");
    mocks.execFile.mockImplementation(((...args: unknown[]) => {
      (args.at(-1) as (error: Error) => void)(new Error("network unreachable"));
    }) as never);
    const { ensureRenderRuntime } = await loadRuntime();

    await expect(ensureRenderRuntime()).rejects.toThrow(/could not install/i);

    // A transient network failure must not leave a deployment unable to render
    // for the rest of the process's life.
    mockSuccessfulInstall(() => executables.add("/usr/bin/chromium"));
    await expect(ensureRenderRuntime()).resolves.toStrictEqual({
      chromiumPath: "/usr/bin/chromium",
      source: "system",
    });
  });
});
