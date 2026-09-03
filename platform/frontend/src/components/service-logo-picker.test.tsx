import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceLogoPicker } from "./service-logo-picker";

describe("ServiceLogoPicker", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  });

  it("loads the catalog only when the picker mounts", async () => {
    const onSelect = vi.fn();
    fetchMock.mockResolvedValue(
      Response.json({
        data: [
          {
            title: "GitHub",
            slug: "github",
            hex: "181717",
            path: "M0 0h24v24H0z",
          },
        ],
        total: 1,
      }),
    );

    render(<ServiceLogoPicker onSelect={onSelect} />);

    expect(fetchMock).toHaveBeenCalledWith("/api/service-icons?limit=120", {
      signal: expect.any(AbortSignal),
    });
    fireEvent.click(await screen.findByTitle("GitHub"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.stringContaining("data:image/svg+xml"),
    );
  });

  it("shows a useful fallback when the catalog cannot be loaded", async () => {
    fetchMock.mockRejectedValue(new Error("network unavailable"));

    render(<ServiceLogoPicker onSelect={vi.fn()} />);

    expect(await screen.findByText("Could not load logos")).toBeVisible();
  });
});
