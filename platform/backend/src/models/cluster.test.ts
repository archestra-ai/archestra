import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { seedDefaultCluster } from "@/database/seed-default-cluster";
import { beforeEach, describe, expect, test } from "@/test";
import ClusterModel from "./cluster";
import SecretModel from "./secret";

/**
 * Build a structurally valid kubeconfig YAML. ClusterModel validates content
 * via `validateKubeconfigContent` before persisting, so "any string" no longer
 * round-trips. The `tag` parameter just makes each fixture distinguishable so
 * round-trip equality assertions still discriminate between revisions.
 */
function makeKubeconfigYaml(tag: string): string {
  return [
    "apiVersion: v1",
    "kind: Config",
    `current-context: ${tag}`,
    "clusters:",
    `  - name: ${tag}`,
    "    cluster:",
    "      server: https://example.invalid:6443",
    "contexts:",
    `  - name: ${tag}`,
    "    context:",
    `      cluster: ${tag}`,
    `      user: ${tag}`,
    "users:",
    `  - name: ${tag}`,
    "    user: {}",
    "",
  ].join("\n");
}

describe("ClusterModel", () => {
  beforeEach(async () => {
    await seedDefaultCluster();
  });

  describe("list", () => {
    test("returns only the seeded default row when nothing else has been created", async () => {
      const rows = await ClusterModel.list();

      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("default");
      expect(rows[0].isDefault).toBe(true);
    });

    test("orders rows by created_at ascending", async () => {
      const a = await ClusterModel.create({ name: "alpha" });
      const b = await ClusterModel.create({ name: "beta" });

      const rows = await ClusterModel.list();
      const names = rows.map((r) => r.name);

      expect(names[0]).toBe("default");
      expect(names.indexOf(a.name)).toBeLessThan(names.indexOf(b.name));
    });
  });

  describe("getById", () => {
    test("returns null for an unknown UUID", async () => {
      const result = await ClusterModel.getById(
        "00000000-0000-4000-8000-000000000000",
      );
      expect(result).toBeNull();
    });

    test("returns the row for a known id", async () => {
      const created = await ClusterModel.create({ name: "lookup-target" });

      const found = await ClusterModel.getById(created.id);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.name).toBe("lookup-target");
    });
  });

  describe("getDefault", () => {
    test("returns the seeded default row", async () => {
      const def = await ClusterModel.getDefault();

      expect(def.isDefault).toBe(true);
      expect(def.name).toBe("default");
    });
  });

  describe("getPersonalDefault", () => {
    test("returns null when no personal-default exists", async () => {
      const result = await ClusterModel.getPersonalDefault();
      expect(result).toBeNull();
    });

    test("returns the row after one is marked personal-default", async () => {
      const created = await ClusterModel.create({
        name: "my-personal",
        isPersonalDefault: true,
      });

      const result = await ClusterModel.getPersonalDefault();

      expect(result).not.toBeNull();
      expect(result?.id).toBe(created.id);
      expect(result?.isPersonalDefault).toBe(true);
    });
  });

  describe("create", () => {
    test("encrypts kubeconfigYaml and stores a decryptable secret", async () => {
      const yaml = makeKubeconfigYaml("roundtrip");

      const created = await ClusterModel.create({
        name: "with-kubeconfig",
        kubeconfigYaml: yaml,
      });

      expect(created.kubeconfigSecretId).not.toBeNull();
      expect(created.kubeconfigSecretId).toBeDefined();

      // Underlying secret row stores ciphertext (not the raw YAML).
      const [rawSecretRow] = await db
        .select()
        .from(schema.secretsTable)
        .where(
          eq(schema.secretsTable.id, created.kubeconfigSecretId as string),
        );
      expect(rawSecretRow).toBeDefined();
      const rawJson = JSON.stringify(rawSecretRow.secret);
      expect(rawJson).not.toContain("roundtrip");

      // Reading the secret via SecretModel decrypts and yields the original YAML.
      const decrypted = await SecretModel.findById(
        created.kubeconfigSecretId as string,
      );
      expect(decrypted).not.toBeNull();
      const decryptedValues = Object.values(
        decrypted?.secret as Record<string, unknown>,
      );
      expect(decryptedValues).toContain(yaml);
    });

    test("clears isPersonalDefault on every other row when created with isPersonalDefault=true", async () => {
      const a = await ClusterModel.create({
        name: "first-personal",
        isPersonalDefault: true,
      });
      const b = await ClusterModel.create({
        name: "second-personal",
        isPersonalDefault: true,
      });

      const refreshedA = await ClusterModel.getById(a.id);
      const refreshedB = await ClusterModel.getById(b.id);

      expect(refreshedA?.isPersonalDefault).toBe(false);
      expect(refreshedB?.isPersonalDefault).toBe(true);

      // The single-personal-default invariant must hold across the table.
      const personal = await ClusterModel.getPersonalDefault();
      expect(personal?.id).toBe(b.id);
    });

    test("rejects attempts to set isDefault=true via create", async () => {
      await expect(
        ClusterModel.create({
          name: "rogue-default",
          // @ts-expect-error — `isDefault` MUST NOT be part of the public create input;
          // this assertion encodes the runtime guard for callers that bypass the type system.
          isDefault: true,
        }),
      ).rejects.toThrow();
    });

    test("rejects garbage kubeconfigYaml on create with no row or secret persisted", async () => {
      const before = await db.select().from(schema.clustersTable);
      const beforeSecrets = await db.select().from(schema.secretsTable);

      await expect(
        ClusterModel.create({
          name: "garbage-yaml",
          kubeconfigYaml: "this is not a kubeconfig",
        }),
      ).rejects.toThrow(/kubeconfig/i);

      const after = await db.select().from(schema.clustersTable);
      const afterSecrets = await db.select().from(schema.secretsTable);
      expect(after).toHaveLength(before.length);
      expect(afterSecrets).toHaveLength(beforeSecrets.length);
    });
  });

  describe("update", () => {
    test("replacing kubeconfigYaml updates the encrypted secret content", async () => {
      const initialYaml = makeKubeconfigYaml("initial");
      const updatedYaml = makeKubeconfigYaml("updated");

      const created = await ClusterModel.create({
        name: "rotate-kubeconfig",
        kubeconfigYaml: initialYaml,
      });
      const initialSecretId = created.kubeconfigSecretId as string;
      expect(initialSecretId).toBeTruthy();

      const updated = await ClusterModel.update(created.id, {
        kubeconfigYaml: updatedYaml,
      });
      expect(updated).not.toBeNull();
      expect(updated?.kubeconfigSecretId).toBeTruthy();

      const newSecretId = updated?.kubeconfigSecretId as string;
      const decryptedNew = await SecretModel.findById(newSecretId);
      expect(decryptedNew).not.toBeNull();
      const decryptedValues = Object.values(
        decryptedNew?.secret as Record<string, unknown>,
      );
      expect(decryptedValues).toContain(updatedYaml);
      expect(decryptedValues).not.toContain(initialYaml);

      // If the implementation reuses the same secret row, the old ciphertext is gone.
      // If it creates a new row and deletes the old, the old row no longer exists.
      // Both outcomes satisfy the contract — the OLD plaintext must not be retrievable
      // through the OLD secret id.
      if (newSecretId !== initialSecretId) {
        const oldLookup = await SecretModel.findById(initialSecretId);
        expect(oldLookup).toBeNull();
      }
    });

    test("setting kubeconfigYaml=null deletes the linked secret and nulls the FK", async () => {
      const yaml = makeKubeconfigYaml("to-be-removed");
      const created = await ClusterModel.create({
        name: "drop-kubeconfig",
        kubeconfigYaml: yaml,
      });
      const secretId = created.kubeconfigSecretId as string;
      expect(secretId).toBeTruthy();

      const updated = await ClusterModel.update(created.id, {
        kubeconfigYaml: null,
      });

      expect(updated).not.toBeNull();
      expect(updated?.kubeconfigSecretId).toBeNull();

      const orphan = await SecretModel.findById(secretId);
      expect(orphan).toBeNull();
    });

    test("flipping isPersonalDefault=true clears it on the previously-marked row", async () => {
      const a = await ClusterModel.create({
        name: "personal-a",
        isPersonalDefault: true,
      });
      const b = await ClusterModel.create({
        name: "personal-b",
      });

      // Sanity: A holds the flag right now.
      const aBefore = await ClusterModel.getById(a.id);
      expect(aBefore?.isPersonalDefault).toBe(true);

      await ClusterModel.update(b.id, { isPersonalDefault: true });

      const aAfter = await ClusterModel.getById(a.id);
      const bAfter = await ClusterModel.getById(b.id);

      expect(aAfter?.isPersonalDefault).toBe(false);
      expect(bAfter?.isPersonalDefault).toBe(true);
    });

    test("rejects attempts to change isDefault via update", async () => {
      const created = await ClusterModel.create({ name: "no-promote" });

      await expect(
        ClusterModel.update(created.id, {
          // @ts-expect-error — `isDefault` MUST NOT be part of the public update input;
          // this assertion encodes the runtime guard for calls that bypass the type system.
          isDefault: true,
        }),
      ).rejects.toThrow();
    });

    test("rejects garbage kubeconfigYaml on update without rotating the existing secret", async () => {
      const goodYaml = makeKubeconfigYaml("good");
      const created = await ClusterModel.create({
        name: "keep-existing",
        kubeconfigYaml: goodYaml,
      });
      const originalSecretId = created.kubeconfigSecretId as string;
      expect(originalSecretId).toBeTruthy();

      await expect(
        ClusterModel.update(created.id, {
          kubeconfigYaml: "garbage that is not a kubeconfig",
        }),
      ).rejects.toThrow(/kubeconfig/i);

      const stillThere = await ClusterModel.getById(created.id);
      expect(stillThere?.kubeconfigSecretId).toBe(originalSecretId);

      const stillSecret = await SecretModel.findById(originalSecretId);
      expect(stillSecret).not.toBeNull();
      const decryptedValues = Object.values(
        stillSecret?.secret as Record<string, unknown>,
      );
      expect(decryptedValues).toContain(goodYaml);
    });
  });

  describe("regression guards", () => {
    // PGlite cannot simulate mid-transaction failure, so atomicity is covered
    // indirectly by the tests below — kubeconfig-add path, non-existent-id
    // update, plaintext-leak guard, rotate-and-rename.

    test("update() adds a kubeconfig secret to a cluster created without one (kubeconfig-add path)", async () => {
      const created = await ClusterModel.create({ name: "no-kubeconfig-yet" });
      expect(created.kubeconfigSecretId).toBeNull();

      const yaml = makeKubeconfigYaml("late-bound");

      const updated = await ClusterModel.update(created.id, {
        kubeconfigYaml: yaml,
      });

      expect(updated).not.toBeNull();
      expect(updated?.kubeconfigSecretId).toBeTruthy();

      const secretId = updated?.kubeconfigSecretId as string;

      // FK is wired up: the secret row exists at the id stored on the cluster.
      const [rawSecretRow] = await db
        .select()
        .from(schema.secretsTable)
        .where(eq(schema.secretsTable.id, secretId));
      expect(rawSecretRow).toBeDefined();

      // Round-trip: the YAML decrypts back via SecretModel.findById.
      const decrypted = await SecretModel.findById(secretId);
      expect(decrypted).not.toBeNull();
      const decryptedValues = Object.values(
        decrypted?.secret as Record<string, unknown>,
      );
      expect(decryptedValues).toContain(yaml);
    });

    test("update() with non-existent id throws and does not mutate any other row", async () => {
      // Establish a known set of rows to compare against.
      const a = await ClusterModel.create({ name: "untouched-a" });
      const b = await ClusterModel.create({ name: "untouched-b" });

      const before = await db.select().from(schema.clustersTable);
      const beforeById = new Map(before.map((row) => [row.id, row]));

      await expect(
        ClusterModel.update("00000000-0000-0000-0000-000000000000", {
          name: "should-not-apply",
        }),
      ).rejects.toThrow();

      const after = await db.select().from(schema.clustersTable);

      // Same row count.
      expect(after).toHaveLength(before.length);

      // Every row identical (no partial mutation leaked through).
      for (const row of after) {
        const prior = beforeById.get(row.id);
        expect(prior).toBeDefined();
        expect(row).toEqual(prior);
      }

      // Sanity-check the two named rows specifically.
      const refreshedA = await ClusterModel.getById(a.id);
      const refreshedB = await ClusterModel.getById(b.id);
      expect(refreshedA?.name).toBe("untouched-a");
      expect(refreshedB?.name).toBe("untouched-b");
    });

    test("list() and getById() never expose plaintext kubeconfig YAML", async () => {
      const plaintext = "SECRET-PLAINTEXT-DO-NOT-LEAK";
      const yaml = makeKubeconfigYaml(plaintext);

      const created = await ClusterModel.create({
        name: "leak-guard",
        kubeconfigYaml: yaml,
      });

      const listed = await ClusterModel.list();
      const fetched = await ClusterModel.getById(created.id);

      const listedJson = JSON.stringify(listed);
      const fetchedJson = JSON.stringify(fetched);

      expect(listedJson).not.toContain(plaintext);
      expect(fetchedJson).not.toContain(plaintext);

      // The FK to the secret should still be exposed (callers need it to fetch).
      expect(listedJson).toContain("kubeconfigSecretId");
      expect(fetchedJson).toContain("kubeconfigSecretId");
    });

    test("rotate-and-rename: secret.name reflects the new cluster name after update", async () => {
      const initialYaml = makeKubeconfigYaml("alpha");
      const newYaml = makeKubeconfigYaml("beta");

      const created = await ClusterModel.create({
        name: "alpha",
        kubeconfigYaml: initialYaml,
      });
      const secretId = created.kubeconfigSecretId as string;
      expect(secretId).toBeTruthy();

      const updated = await ClusterModel.update(created.id, {
        name: "beta",
        kubeconfigYaml: newYaml,
      });

      expect(updated?.name).toBe("beta");

      // Resolve the (possibly rotated) secret id from the updated row.
      const currentSecretId = updated?.kubeconfigSecretId as string;
      expect(currentSecretId).toBeTruthy();

      const decrypted = await SecretModel.findById(currentSecretId);
      expect(decrypted).not.toBeNull();

      // Content was rotated to the new YAML.
      const decryptedValues = Object.values(
        decrypted?.secret as Record<string, unknown>,
      );
      expect(decryptedValues).toContain(newYaml);

      // The secret's name field reflects the new cluster name — not stale "alpha".
      expect(decrypted?.name).toBe("cluster-kubeconfig:beta");
      expect(decrypted?.name).not.toBe("cluster-kubeconfig:alpha");
    });
  });

  describe("delete", () => {
    test("deletes a non-default row and cleans up the linked kubeconfig secret", async () => {
      const yaml = makeKubeconfigYaml("doomed");
      const created = await ClusterModel.create({
        name: "doomed-cluster",
        kubeconfigYaml: yaml,
      });
      const secretId = created.kubeconfigSecretId as string;
      expect(secretId).toBeTruthy();

      await ClusterModel.delete(created.id);

      const lookup = await ClusterModel.getById(created.id);
      expect(lookup).toBeNull();

      const orphan = await SecretModel.findById(secretId);
      expect(orphan).toBeNull();
    });

    test("throws when attempting to delete the default row", async () => {
      const def = await ClusterModel.getDefault();

      await expect(ClusterModel.delete(def.id)).rejects.toThrow();

      // Default row must still exist after the failed call.
      const stillThere = await ClusterModel.getById(def.id);
      expect(stillThere?.isDefault).toBe(true);
    });
  });
});
