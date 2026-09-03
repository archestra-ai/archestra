import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("service icons route", () => {
  it("serves a cacheable first page instead of the full catalog", async () => {
    const response = GET(
      new Request("http://localhost:3000/api/service-icons"),
    );
    const result = (await response.json()) as {
      data: Array<{ title: string; slug: string }>;
      total: number;
    };

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
    expect(result.data).toHaveLength(120);
    expect(result.total).toBeGreaterThan(result.data.length);
    expect(result.data).toContainEqual(
      expect.objectContaining({
        title: "GitHub",
        slug: "github",
      }),
    );
  });

  it("filters and paginates the catalog", async () => {
    const response = GET(
      new Request(
        "http://localhost:3000/api/service-icons?q=github&offset=1&limit=2",
      ),
    );
    const result = (await response.json()) as {
      data: Array<{ title: string; slug: string }>;
      total: number;
    };

    expect(result.total).toBeGreaterThan(1);
    expect(result.data).toHaveLength(Math.min(2, result.total - 1));
    expect(result.data.every((icon) => /github/i.test(icon.slug))).toBe(true);
  });
});
