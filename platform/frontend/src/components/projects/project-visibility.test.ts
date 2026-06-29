import { describe, expect, it } from "vitest";
import { describeProjectVisibility } from "./project-visibility";

describe("describeProjectVisibility", () => {
  it("treats null visibility as a personal scope", () => {
    expect(describeProjectVisibility(null)).toEqual({
      scope: "personal",
      label: "Personal",
    });
  });

  it("maps organization visibility to the org scope", () => {
    expect(describeProjectVisibility("organization")).toEqual({
      scope: "org",
      label: "Organization",
    });
  });

  it("labels a team-shared project with its team names when known", () => {
    expect(
      describeProjectVisibility("team", ["Design", "Engineering"]),
    ).toEqual({
      scope: "team",
      label: "Team: Design, Engineering",
    });
  });

  it("falls back to a bare Team label when names are unknown", () => {
    // Non-owners never receive shareTeamNames, so the pill still reads "Team".
    expect(describeProjectVisibility("team", null)).toEqual({
      scope: "team",
      label: "Team",
    });
    expect(describeProjectVisibility("team", [])).toEqual({
      scope: "team",
      label: "Team",
    });
  });
});
