import { DOMAIN_VALIDATION_REGEX } from "@shared";
import { describe, expect, it } from "vitest";

describe("DOMAIN_VALIDATION_REGEX", () => {
  describe("valid domains", () => {
    it("accepts simple domain", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("company.com")).toBe(true);
    });

    it("accepts subdomain", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("mail.company.com")).toBe(true);
    });

    it("accepts multiple subdomains", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("sub.mail.company.com")).toBe(true);
    });

    it("accepts domain with hyphen", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("my-company.com")).toBe(true);
    });

    it("accepts domain with numbers", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("company123.com")).toBe(true);
    });

    it("accepts country code TLD", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("company.co.uk")).toBe(true);
    });

    it("accepts long TLD", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("company.technology")).toBe(true);
    });

    it("accepts single character subdomain", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("a.company.com")).toBe(true);
    });
  });

  describe("invalid domains", () => {
    it("rejects domain with spaces", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("company .com")).toBe(false);
    });

    it("rejects domain starting with hyphen", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("-company.com")).toBe(false);
    });

    it("rejects domain ending with hyphen", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("company-.com")).toBe(false);
    });

    it("rejects domain with special characters", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("company@.com")).toBe(false);
    });

    it("rejects domain with underscore", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("company_name.com")).toBe(false);
    });

    it("rejects domain without TLD", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("company")).toBe(false);
    });

    it("rejects domain with single character TLD", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("company.c")).toBe(false);
    });

    it("rejects domain with protocol", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("https://company.com")).toBe(false);
    });

    it("rejects domain with path", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("company.com/path")).toBe(false);
    });

    it("rejects domain with port", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("company.com:8080")).toBe(false);
    });

    it("rejects IP address", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("192.168.1.1")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("")).toBe(false);
    });

    it("rejects domain with consecutive dots", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("company..com")).toBe(false);
    });

    it("rejects domain starting with dot", () => {
      expect(DOMAIN_VALIDATION_REGEX.test(".company.com")).toBe(false);
    });

    it("rejects domain ending with dot", () => {
      expect(DOMAIN_VALIDATION_REGEX.test("company.com.")).toBe(false);
    });
  });
});
