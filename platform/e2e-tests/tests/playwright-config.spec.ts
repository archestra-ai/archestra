import { expect, test } from "../fixtures";
import config from "../playwright.config";

test.describe("playwright project matching", () => {
  test("quickstart files run only in quickstart project, not standard browsers", () => {
    const projects = config.projects ?? [];
    const quickstart = projects.find(
      (project) => project.name === "quickstart",
    );
    const standardBrowsers = projects.filter((project) =>
      ["chromium", "firefox", "webkit"].includes(project.name ?? ""),
    );

    expect(quickstart?.testMatch).toEqual([
      "**/auth-origin.spec.ts",
      "**/mcp-install-quickstart.spec.ts",
      "**/quickstart.spec.ts",
    ]);
    for (const project of standardBrowsers) {
      expect(project.testIgnore).toEqual(
        expect.arrayContaining([
          "**/auth-origin.spec.ts",
          "**/quickstart.spec.ts",
        ]),
      );
      expect(project.testIgnore).not.toContain("**/mcp-install.spec.ts");
      expect(project.grepInvert).toEqual(/@quickstart/);
    }
  });
});
