import { describe, expect, test } from "@/test";
import { escapeLikePattern } from "./sql-search";

describe("sql-search utils", () => {
  test("escapes LIKE pattern wildcard characters", () => {
    expect(escapeLikePattern("100%_match\\path")).toBe(
      "100\\%\\_match\\\\path",
    );
  });

  test("leaves ordinary search text unchanged", () => {
    expect(escapeLikePattern("plain text")).toBe("plain text");
  });
});
