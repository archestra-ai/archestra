import { describe, expect, it } from "vitest";
import { configureStep } from "./configure-step";

describe("configureStep", () => {
  it("opens the schedule dialog when a blob provider exists", () => {
    expect(
      configureStep({
        canSchedule: true,
        canAddProvider: false,
        providerCount: 2,
      }),
    ).toBe("schedule");
  });

  it("starts with the blob provider when there is none yet", () => {
    expect(
      configureStep({
        canSchedule: true,
        canAddProvider: true,
        providerCount: 0,
      }),
    ).toBe("add-provider");
  });

  it("offers nothing to a reader who can schedule but cannot add the first blob provider", () => {
    expect(
      configureStep({
        canSchedule: true,
        canAddProvider: false,
        providerCount: 0,
      }),
    ).toBe("needs-provider");
  });

  it("offers nothing to a reader who cannot schedule, even one who could add a blob provider", () => {
    expect(
      configureStep({
        canSchedule: false,
        canAddProvider: true,
        providerCount: 0,
      }),
    ).toBe("cannot-schedule");
  });

  it("does not wait for a blob provider list that is never fetched for a reader who cannot schedule", () => {
    expect(
      configureStep({
        canSchedule: false,
        canAddProvider: false,
        providerCount: undefined,
      }),
    ).toBe("cannot-schedule");
  });

  it("waits while an answer it needs is still loading", () => {
    expect(
      configureStep({
        canSchedule: undefined,
        canAddProvider: true,
        providerCount: 1,
      }),
    ).toBe("loading");
    expect(
      configureStep({
        canSchedule: true,
        canAddProvider: true,
        providerCount: undefined,
      }),
    ).toBe("loading");
    expect(
      configureStep({
        canSchedule: true,
        canAddProvider: undefined,
        providerCount: 0,
      }),
    ).toBe("loading");
  });
});
