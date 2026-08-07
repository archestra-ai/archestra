import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseAppearanceSettings } = vi.hoisted(() => ({
  mockUseAppearanceSettings: vi.fn(),
}));

vi.mock("@/lib/organization.query", () => ({
  useAppearanceSettings: () => mockUseAppearanceSettings(),
}));

import { DynamicHead } from "./dynamic-head";

const CUSTOM_FAVICON = "data:image/png;base64,custom";
const CUSTOM_VERSION = "48ac386978254451";

describe("DynamicHead", () => {
  beforeEach(() => {
    const digest = Uint8Array.from([
      0x48, 0xac, 0x38, 0x69, 0x78, 0x25, 0x44, 0x51,
    ]).buffer;
    vi.stubGlobal("crypto", {
      subtle: { digest: vi.fn().mockResolvedValue(digest) },
    });
    mockUseAppearanceSettings.mockReturnValue({
      data: { favicon: CUSTOM_FAVICON },
      isFetched: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
  });

  it("keeps the matching server-rendered favicon candidate stable", async () => {
    document.head.innerHTML = `<link rel="icon" href="/favicon.ico?v=${CUSTOM_VERSION}" data-favicon-version="${CUSTOM_VERSION}">`;
    const link = document.querySelector('link[rel="icon"]');

    render(<DynamicHead />);

    await waitFor(() => {
      expect(globalThis.crypto.subtle.digest).toHaveBeenCalled();
    });
    expect(link).toHaveAttribute("href", `/favicon.ico?v=${CUSTOM_VERSION}`);
  });

  it("applies a changed favicon after the appearance query updates", async () => {
    document.head.innerHTML =
      '<link rel="icon" href="/favicon.ico?v=old" data-favicon-version="old">';

    render(<DynamicHead />);

    await waitFor(() => {
      const link = document.querySelector('link[rel="icon"]');
      expect(link).toHaveAttribute("href", `/favicon.ico?v=${CUSTOM_VERSION}`);
      expect(link).toHaveAttribute("data-favicon-version", CUSTOM_VERSION);
    });
  });
});
