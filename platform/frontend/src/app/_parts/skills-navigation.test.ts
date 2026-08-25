import { describe, expect, it } from "vitest";
import { getSkillsNavigation } from "./skills-navigation";

describe("getSkillsNavigation", () => {
  it("names both pages when the reader may open both", () => {
    expect(
      getSkillsNavigation({
        permissionMap: { "/skills": true, "/plugins": true },
        pluginsEnabled: true,
      }),
    ).toEqual({ url: "/skills", title: "Skills & Plugins" });
  });

  it("names Skills alone when the deployment has plugins turned off", () => {
    expect(
      getSkillsNavigation({
        permissionMap: { "/skills": true, "/plugins": true },
        pluginsEnabled: false,
      }),
    ).toEqual({ url: "/skills", title: "Skills" });
  });

  it("opens Plugins when that is the only page the reader may see", () => {
    expect(
      getSkillsNavigation({
        permissionMap: { "/skills": false, "/plugins": true },
        pluginsEnabled: true,
      }),
    ).toEqual({ url: "/plugins", title: "Plugins" });
  });

  it("stays on Skills while the permission answer is still loading", () => {
    expect(
      getSkillsNavigation({ permissionMap: undefined, pluginsEnabled: true }),
    ).toEqual({ url: "/skills", title: "Skills" });
  });
});
