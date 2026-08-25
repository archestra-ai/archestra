import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePermissionMap } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useSkillsPluginsNavTabs } from "./skills-plugins-nav-tabs";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

function TabHrefs() {
  const tabs = useSkillsPluginsNavTabs();
  return <div data-testid="tabs">{tabs.map((tab) => tab.href).join(",")}</div>;
}

const setPageAccess = (pages: Record<string, boolean>) => {
  vi.mocked(usePermissionMap).mockReturnValue(
    pages as unknown as ReturnType<typeof usePermissionMap>,
  );
};

describe("useSkillsPluginsNavTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useFeature).mockReturnValue(true);
  });

  it("offers both pages to a reader who may open them", () => {
    setPageAccess({ "/skills": true, "/plugins": true });

    render(<TabHrefs />);

    expect(screen.getByTestId("tabs")).toHaveTextContent("/skills,/plugins");
  });

  it("shows no bar at all when the reader may open only one of the pages", () => {
    setPageAccess({ "/skills": true, "/plugins": false });

    render(<TabHrefs />);

    expect(screen.getByTestId("tabs")).toBeEmptyDOMElement();
  });

  it("shows no bar when the deployment has plugins turned off", () => {
    vi.mocked(useFeature).mockReturnValue(false);
    setPageAccess({ "/skills": true, "/plugins": true });

    render(<TabHrefs />);

    expect(screen.getByTestId("tabs")).toBeEmptyDOMElement();
  });

  it("chips each page at its own stage: Skills new, Plugins beta", () => {
    setPageAccess({ "/skills": true, "/plugins": true });

    function TabLabels() {
      const tabs = useSkillsPluginsNavTabs();
      return (
        <ul>
          {tabs.map((tab) => (
            <li key={tab.href} data-testid={tab.href}>
              {tab.label}
            </li>
          ))}
        </ul>
      );
    }
    render(<TabLabels />);

    // Different chips on purpose: Skills has shipped, Plugins has not.
    expect(screen.getByTestId("/skills")).toHaveTextContent("SkillsNew");
    expect(screen.getByTestId("/plugins")).toHaveTextContent("PluginsBeta");
  });
});
