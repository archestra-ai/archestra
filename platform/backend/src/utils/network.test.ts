import { describe, expect, test } from "vitest";
import { isLoopbackAddress } from "./network";

describe("isLoopbackAddress", () => {
  // IPv4 loopback range (127.0.0.0/8)
  test("returns true for 127.0.0.1", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  });

  test("returns true for other 127.x.x.x addresses", () => {
    expect(isLoopbackAddress("127.0.0.2")).toBe(true);
    expect(isLoopbackAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackAddress("127.255.255.255")).toBe(true);
  });

  // IPv6 loopback
  test("returns true for ::1", () => {
    expect(isLoopbackAddress("::1")).toBe(true);
  });

  // IPv4-mapped IPv6 loopback
  test("returns true for ::ffff:127.0.0.1", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  test("returns true for ::ffff:127.1.2.3", () => {
    expect(isLoopbackAddress("::ffff:127.1.2.3")).toBe(true);
  });

  // Non-loopback addresses
  test("returns false for public IPv4", () => {
    expect(isLoopbackAddress("1.2.3.4")).toBe(false);
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
  });

  test("returns false for non-loopback IPv6", () => {
    expect(isLoopbackAddress("::2")).toBe(false);
    expect(isLoopbackAddress("fe80::1")).toBe(false);
  });

  test("returns false for non-loopback IPv4-mapped IPv6", () => {
    expect(isLoopbackAddress("::ffff:192.168.1.1")).toBe(false);
    expect(isLoopbackAddress("::ffff:10.0.0.1")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isLoopbackAddress("")).toBe(false);
  });

  test("returns false for invalid input", () => {
    expect(isLoopbackAddress("not-an-ip")).toBe(false);
    expect(isLoopbackAddress("127.0.0")).toBe(false);
  });
});
