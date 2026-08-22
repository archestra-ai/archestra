import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientRedirect } from "./client-redirect";

const { mockReplace } = vi.hoisted(() => ({ mockReplace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

describe("ClientRedirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards to the target route and renders nothing", () => {
    const { container } = render(<ClientRedirect to="/account/api-keys" />);

    expect(mockReplace).toHaveBeenCalledWith("/account/api-keys");
    expect(container).toBeEmptyDOMElement();
  });
});
