import { describe, expect, test, useRouteTestApp } from "@/test";
import skillRoutes from "./skill.routes";
import { MANIFEST } from "./skill.test-helpers";

describe("GET /api/skills", () => {
  const ctx = useRouteTestApp(skillRoutes);

  test("lists skills with a file count that includes SKILL.md", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: MANIFEST,
        files: [{ path: "references/FORMS.md", content: "# Forms" }],
      },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skills",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    // one bundled resource (references/FORMS.md) plus the SKILL.md manifest.
    expect(body.data[0].fileCount).toBe(2);
  });
});
