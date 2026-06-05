import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const platformRoot = join(__dirname, "../..");
const repositoryRoot = join(platformRoot, "..");

describe("Docker quickstart configuration", () => {
  it("uses IPv4 loopback for the container healthcheck", () => {
    const dockerfile = readFileSync(join(platformRoot, "Dockerfile"), "utf8");

    expect(dockerfile).toContain(
      "wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/",
    );
    expect(dockerfile).not.toContain(
      "wget --no-verbose --tries=1 --spider http://localhost:3000/",
    );
  });

  it("binds quickstart host ports to loopback by default", () => {
    const files = [
      join(repositoryRoot, "README.md"),
      join(repositoryRoot, "docs/pages/platform-quickstart.md"),
      join(repositoryRoot, "docs/pages/platform-deployment.md"),
      join(repositoryRoot, "docs/pages/platform-pydantic-example.md"),
      join(repositoryRoot, "docs/pages/platform-vercel-ai-example.md"),
      join(platformRoot, "frontend/src/app/agents/triggers/ms-teams/page.tsx"),
      join(repositoryRoot, ".github/workflows/platform-e2e-tests.yml"),
    ];

    for (const file of files) {
      const contents = readFileSync(file, "utf8");

      expect(contents).toContain("-p 127.0.0.1:9000:9000");
      expect(contents).toContain("-p 127.0.0.1:3000:3000");
      expect(contents).not.toMatch(/-p 9000:9000\s+-p 3000:3000/);
      expect(contents).not.toMatch(/-p 9000:9000\s+-p 127\.0\.0\.1:3000:3000/);
    }
  });

  it("uses IPv4 loopback URLs in the platform setup action", () => {
    const action = readFileSync(
      join(
        repositoryRoot,
        ".github/actions/setup-archestra-platform/action.yml",
      ),
      "utf8",
    );

    expect(action).toContain("http://127.0.0.1:3000/");
    expect(action).toContain("http://127.0.0.1:9000/health");
    expect(action).toContain("frontend-url=http://127.0.0.1:3000");
    expect(action).toContain("backend-url=http://127.0.0.1:9000");
  });
});
