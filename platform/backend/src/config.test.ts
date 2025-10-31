import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDatabaseUrl } from "./config";

describe("getDatabaseUrl", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Create a fresh copy of process.env for each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore the original environment
    process.env = originalEnv;
  });

  it("should use ARCHESTRA_DATABASE_URL when both ARCHESTRA_DATABASE_URL and DATABASE_URL are set", () => {
    process.env.ARCHESTRA_DATABASE_URL =
      "postgresql://archestra:pass@host:5432/archestra_db";
    process.env.DATABASE_URL = "postgresql://other:pass@host:5432/other_db";

    const result = getDatabaseUrl();

    expect(result).toBe("postgresql://archestra:pass@host:5432/archestra_db");
  });

  it("should use DATABASE_URL when only DATABASE_URL is set", () => {
    delete process.env.ARCHESTRA_DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://other:pass@host:5432/other_db";

    const result = getDatabaseUrl();

    expect(result).toBe("postgresql://other:pass@host:5432/other_db");
  });

  it("should use ARCHESTRA_DATABASE_URL when only ARCHESTRA_DATABASE_URL is set", () => {
    process.env.ARCHESTRA_DATABASE_URL =
      "postgresql://archestra:pass@host:5432/archestra_db";
    delete process.env.DATABASE_URL;

    const result = getDatabaseUrl();

    expect(result).toBe("postgresql://archestra:pass@host:5432/archestra_db");
  });

  it("should throw an error when neither ARCHESTRA_DATABASE_URL nor DATABASE_URL is set", () => {
    delete process.env.ARCHESTRA_DATABASE_URL;
    delete process.env.DATABASE_URL;

    expect(() => getDatabaseUrl()).toThrow(
      "Database URL is not set. Please set ARCHESTRA_DATABASE_URL or DATABASE_URL",
    );
  });

  it("should throw an error when both are empty strings", () => {
    process.env.ARCHESTRA_DATABASE_URL = "";
    process.env.DATABASE_URL = "";

    expect(() => getDatabaseUrl()).toThrow(
      "Database URL is not set. Please set ARCHESTRA_DATABASE_URL or DATABASE_URL",
    );
  });

  it("should use DATABASE_URL when ARCHESTRA_DATABASE_URL is empty string", () => {
    process.env.ARCHESTRA_DATABASE_URL = "";
    process.env.DATABASE_URL = "postgresql://other:pass@host:5432/other_db";

    const result = getDatabaseUrl();

    expect(result).toBe("postgresql://other:pass@host:5432/other_db");
  });
});
