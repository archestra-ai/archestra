import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePermissionMap } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useAgentsNavTabs } from "./agents-nav-tabs";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

function TabHrefs() {
  const tabs = useAgentsNavTabs();
  return <div data-testid="tabs">{tabs.map((tab) => tab.href).join(",")}</div>;
}

const setPageAccess = (pages: Record<string, boolean>) => {
  vi.mocked(usePermissionMap).mockReturnValue(
    pages as unknown as ReturnType<typeof usePermissionMap>,
  );
};

describe("useAgentsNavTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useFeature).mockReturnValue(true);
  });

  it("offers the whole section to a reader who may open every page", () => {
    setPageAccess({ "/agents": true, "/skills": true, "/plugins": true });

    render(<TabHrefs />);

    expect(screen.getByTestId("tabs")).toHaveTextContent(
      "/agents,/skills,/plugins",
    );
  });

  it("drops the pages the reader would only be forbidden from", () => {
    setPageAccess({ "/agents": true, "/skills": false, "/plugins": false });

    render(<TabHrefs />);

    expect(screen.getByTestId("tabs")).toHaveTextContent("/agents");
    expect(screen.getByTestId("tabs")).not.toHaveTextContent("/skills");
    expect(screen.getByTestId("tabs")).not.toHaveTextContent("/plugins");
  });

  it("drops Plugins when the deployment has the feature turned off", () => {
    vi.mocked(useFeature).mockReturnValue(false);
    setPageAccess({ "/agents": true, "/skills": true, "/plugins": true });

    render(<TabHrefs />);

    expect(screen.getByTestId("tabs")).toHaveTextContent("/agents,/skills");
  });

  it("marks the beta pages so the badge the sidebar carried is not lost", () => {
    setPageAccess({ "/agents": true, "/skills": true, "/plugins": true });

    function TabLabels() {
      const tabs = useAgentsNavTabs();
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

    expect(screen.getByTestId("/agents")).not.toHaveTextContent("Beta");
    expect(screen.getByTestId("/skills")).toHaveTextContent("SkillsBeta");
    expect(screen.getByTestId("/plugins")).toHaveTextContent("PluginsBeta");
  });
});
