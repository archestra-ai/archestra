import { AnthropicErrorTypes } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import { isAnthropicBillingBlock } from "./anthropic-billing-error";

describe("isAnthropicBillingBlock", () => {
  test("matches the current 402 billing_error signal", () => {
    expect(
      isAnthropicBillingBlock({
        status: 402,
        type: AnthropicErrorTypes.BILLING,
      }),
    ).toBe(true);
  });

  test("matches a billing_error type at any status", () => {
    expect(
      isAnthropicBillingBlock({
        status: 400,
        type: AnthropicErrorTypes.BILLING,
      }),
    ).toBe(true);
  });

  test("matches the legacy 'credit balance is too low' message", () => {
    expect(
      isAnthropicBillingBlock({
        status: 400,
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API.",
      }),
    ).toBe(true);
  });

  test("matches the usage-limit block off the message (400, non-standard type)", () => {
    expect(
      isAnthropicBillingBlock({
        status: 400,
        type: "api_validation_error",
        message:
          "You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC.",
      }),
    ).toBe(true);
  });

  test("matches a 'spend limit' message", () => {
    expect(
      isAnthropicBillingBlock({
        status: 400,
        type: "invalid_request_error",
        message: "Your organization has reached its monthly spend limit.",
      }),
    ).toBe(true);
  });

  test("matches a 'spending limit' message", () => {
    expect(
      isAnthropicBillingBlock({
        status: 400,
        type: "invalid_request_error",
        message: "This request would exceed your configured spending limit.",
      }),
    ).toBe(true);
  });

  test("does not match an ordinary request-validation 400", () => {
    expect(
      isAnthropicBillingBlock({
        status: 400,
        type: "invalid_request_error",
        message:
          'messages: roles must alternate between "user" and "assistant"',
      }),
    ).toBe(false);
  });

  test("does not match a rate-limit error (429, 'rate limit')", () => {
    expect(
      isAnthropicBillingBlock({
        status: 429,
        type: "rate_limit_error",
        message: "Number of requests has exceeded your per-minute rate limit.",
      }),
    ).toBe(false);
  });
});
