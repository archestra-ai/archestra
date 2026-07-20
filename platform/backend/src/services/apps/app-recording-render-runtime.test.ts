import config from "@/config";
import { expect, test } from "@/test";
import { ensureRenderRuntime } from "./app-recording-render-runtime";

// One test per file: the resolver memoizes its answer on purpose (a second
// export arriving mid-install must not start a competing one), so a second
// case here would read the first one's cache rather than resolve again.
test("uses a pinned browser without reaching for an installer", async () => {
  // Any real executable stands in for a browser — resolution only checks that
  // the path exists and is executable, and must stop there. Reaching an
  // installer in an environment that already has a browser is the bug that
  // made video export demand configuration that was never needed.
  config.hackathonRecorder.chromiumPath = process.execPath;

  await expect(ensureRenderRuntime()).resolves.toStrictEqual({
    chromiumPath: process.execPath,
    source: "configured",
  });
});
