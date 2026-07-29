import { APPS_HACKATHON_OPENS_AT_MS } from "@archestra/shared";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFeature } from "@/lib/config/config.query";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import { useOrganization } from "@/lib/organization.query";
import {
  useAppsHackathonAvailable,
  useAppsHackathonOffered,
} from "./apps-hackathon";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/hooks/use-mobile");

/** Drive the public flag the hook reads. */
function mockFeatures(flags: { enabled: boolean }) {
  vi.mocked(useFeature).mockImplementation(((flag: string) => {
    if (flag === "hackathonRecorderEnabled") return flags.enabled;
    return undefined;
  }) as typeof useFeature);
}

/** Stand in for the org query — `undefined` models the still-loading state. */
function mockOrgToggle(enabled: boolean | undefined) {
  vi.mocked(useOrganization).mockReturnValue({
    data:
      enabled === undefined
        ? undefined
        : { appsHackathonRecorderEnabled: enabled },
  } as ReturnType<typeof useOrganization>);
}

describe("useAppsHackathonOffered", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is not offered outside the window, whatever the deployment flag says", () => {
    // The date window has no bypass — before the opening, nothing is offered.
    vi.useFakeTimers();
    vi.setSystemTime(APPS_HACKATHON_OPENS_AT_MS - 60 * 60 * 1000);
    mockFeatures({ enabled: true });
    const { result } = renderHook(() => useAppsHackathonOffered());
    expect(result.current).toBe(false);
  });

  it("is offered inside the window when the deployment flag is on", () => {
    vi.useFakeTimers();
    vi.setSystemTime(APPS_HACKATHON_OPENS_AT_MS);
    mockFeatures({ enabled: true });
    const { result } = renderHook(() => useAppsHackathonOffered());
    expect(result.current).toBe(true);
  });

  it("is never offered when the deployment flag is off, even inside the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(APPS_HACKATHON_OPENS_AT_MS);
    mockFeatures({ enabled: false });
    const { result } = renderHook(() => useAppsHackathonOffered());
    expect(result.current).toBe(false);
  });
});

describe("useAppsHackathonAvailable", () => {
  // "Offered" is the composition of the deployment/date gates, tested above.
  // Here we hold it true (deployment on, clock inside the window) and pin how
  // the device gate and the org toggle combine on top of it — each is an
  // independent AND, so any one being wrong hides the recorder.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(APPS_HACKATHON_OPENS_AT_MS);
    mockFeatures({ enabled: true });
    mockOrgToggle(true);
    vi.mocked(useIsMobile).mockReturnValue(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is available when offered, on a desktop, and the org has it on", () => {
    const { result } = renderHook(() => useAppsHackathonAvailable());
    expect(result.current).toBe(true);
  });

  it("is not available when the org toggle is off", () => {
    mockOrgToggle(false);
    const { result } = renderHook(() => useAppsHackathonAvailable());
    expect(result.current).toBe(false);
  });

  it("is not available on a phone-sized screen, whatever else allows it", () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    const { result } = renderHook(() => useAppsHackathonAvailable());
    expect(result.current).toBe(false);
  });

  it("is not available when the deployment does not offer it", () => {
    mockFeatures({ enabled: false });
    const { result } = renderHook(() => useAppsHackathonAvailable());
    expect(result.current).toBe(false);
  });

  it("defaults closed while the organization is still loading", () => {
    mockOrgToggle(undefined);
    const { result } = renderHook(() => useAppsHackathonAvailable());
    expect(result.current).toBe(false);
  });
});
