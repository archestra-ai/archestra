import { redirect } from "next/navigation";
import { expect, test, vi } from "vitest";
import OpenAppaTestsRedirect from "./page";

vi.mock("next/navigation");
test("existing policy test bookmarks redirect to Validation", () => {
  OpenAppaTestsRedirect();
  expect(redirect).toHaveBeenCalledWith("/openappa/validation");
});
