import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import db, { schema } from "@/database";
import { isEncryptedSecret } from "@/utils/crypto";
import SecretModel from "./secret";

describe("SecretModel", () => {
  describe("findByIds", () => {
    it("decrypts multiple secrets in bulk", async () => {
      const secrets = [
        { name: "bulk-test-1", secret: { apiKey: "sk-bulk-1" } },
        { name: "bulk-test-2", secret: { token: "tok-bulk-2" } },
        { name: "bulk-test-3", secret: { password: "pw-bulk-3" } },
      ];

      const created = await Promise.all(
        secrets.map((s) => SecretModel.create(s)),
      );

      // Verify DB stores encrypted blobs
      for (const row of created) {
        const [raw] = await db
          .select()
          .from(schema.secretsTable)
          .where(eq(schema.secretsTable.id, row.id));
        expect(isEncryptedSecret(raw.secret)).toBe(true);
      }

      // findByIds should return decrypted plaintext
      const ids = created.map((r) => r.id);
      const results = await SecretModel.findByIds(ids);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(isEncryptedSecret(result.secret)).toBe(false);
      }

      const byName = Object.fromEntries(results.map((r) => [r.name, r]));
      expect(byName["bulk-test-1"].secret).toEqual({ apiKey: "sk-bulk-1" });
      expect(byName["bulk-test-2"].secret).toEqual({ token: "tok-bulk-2" });
      expect(byName["bulk-test-3"].secret).toEqual({ password: "pw-bulk-3" });
    });

    it("returns empty array for empty ids", async () => {
      const results = await SecretModel.findByIds([]);
      expect(results).toEqual([]);
    });
  });
});
