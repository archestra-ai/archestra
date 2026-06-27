import { describe, expect, it } from "vitest";
import {
  AgentEmailSettingsFormSchema,
  describeIncomingEmailSecurityMode,
  formatIncomingEmailExpiry,
  formatIncomingEmailSecurityMode,
  getIncomingEmailTimeUntilExpiry,
  getIncomingEmailWebhookUrl,
} from "./email-trigger.utils";

describe("AgentEmailSettingsFormSchema", () => {
  it("requires an allowed domain for internal mode", () => {
    const result = AgentEmailSettingsFormSchema.safeParse({
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "internal",
      incomingEmailAllowedDomain: "",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([
      "incomingEmailAllowedDomain",
    ]);
  });

  it("accepts internal mode with a valid domain", () => {
    const result = AgentEmailSettingsFormSchema.safeParse({
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "internal",
      incomingEmailAllowedDomain: "company.com",
    });

    expect(result.success).toBe(true);
  });

  it("does not require a domain when email invocation is disabled", () => {
    const result = AgentEmailSettingsFormSchema.safeParse({
      incomingEmailEnabled: false,
      incomingEmailSecurityMode: "internal",
      incomingEmailAllowedDomain: "",
    });

    expect(result.success).toBe(true);
  });
});

describe("email trigger utils", () => {
  it("formats security modes for display", () => {
    expect(formatIncomingEmailSecurityMode("private")).toBe("Private");
    expect(formatIncomingEmailSecurityMode("internal")).toBe("Internal");
    expect(formatIncomingEmailSecurityMode("public")).toBe("Public");
  });

  it("describes internal mode with a configured domain", () => {
    expect(
      describeIncomingEmailSecurityMode("internal", "company.com"),
    ).toContain("@company.com");
  });

  it("uses the app name for private mode descriptions", () => {
    expect(
      describeIncomingEmailSecurityMode("private", undefined, "Acme"),
    ).toContain("Acme users");
  });

  it("builds the incoming email webhook URL", () => {
    expect(getIncomingEmailWebhookUrl("https://app.example.com/")).toBe(
      "https://app.example.com/api/webhooks/incoming-email",
    );
  });

  it("returns invalid date for malformed expiry values", () => {
    expect(formatIncomingEmailExpiry("not-a-date")).toBe("Invalid Date");
  });

  it("formats the time until expiry in days and hours", () => {
    const now = new Date("2026-03-27T10:00:00.000Z");
    const expiry = "2026-03-29T15:00:00.000Z";

    expect(getIncomingEmailTimeUntilExpiry(expiry, now)).toBe(
      "2d 5h remaining",
    );
  });

  it("returns expired when the timestamp has passed", () => {
    const now = new Date("2026-03-27T10:00:00.000Z");
    const expiry = "2026-03-27T09:00:00.000Z";

    expect(getIncomingEmailTimeUntilExpiry(expiry, now)).toBe("Expired");
  });
});
