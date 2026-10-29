import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InstallationProgress } from "./installation-progress";

describe("InstallationProgress", () => {
  it("talks about a deployment while a local server starts", () => {
    render(<InstallationProgress status="pending" serverType="local" />);

    expect(screen.getByText(/^Starting the deployment/)).toBeInTheDocument();
  });

  it("says it is connecting for a remote server, which has no deployment", () => {
    render(<InstallationProgress status="pending" serverType="remote" />);

    expect(screen.getByText(/^Connecting/)).toBeInTheDocument();
    expect(screen.queryByText(/deployment/i)).toBeNull();
  });
});
