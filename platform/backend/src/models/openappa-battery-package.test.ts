import OpenAppaBatteryPackageModel from "@/models/openappa-battery-package";
import { describe, expect, test } from "@/test";

const files = (text: string) => [{ path: "appa.toml", text }];

describe("OpenAppaBatteryPackageModel", () => {
  test("storing the same hash twice answers the stored row", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const first = await OpenAppaBatteryPackageModel.insert({
      organizationId,
      name: "linear",
      description: "Linear",
      contentHash: "hash-a",
      files: files("first"),
    });
    const again = await OpenAppaBatteryPackageModel.insert({
      organizationId,
      name: "linear",
      description: "Linear, described differently",
      contentHash: "hash-a",
      files: files("second"),
    });

    expect(again.id).toBe(first.id);
    // The bytes under a hash never change: the second upload rewrote nothing.
    expect(again.files).toEqual(files("first"));
    expect(again.description).toBe("Linear");
    expect(await OpenAppaBatteryPackageModel.list(organizationId)).toHaveLength(
      1,
    );
  });

  test("two versions of one name coexist and are found by hash", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    await OpenAppaBatteryPackageModel.insert({
      organizationId,
      name: "linear",
      description: "v1",
      contentHash: "hash-a",
      files: files("first"),
    });
    await OpenAppaBatteryPackageModel.insert({
      organizationId,
      name: "linear",
      description: "v2",
      contentHash: "hash-b",
      files: files("second"),
    });

    expect(
      (
        await OpenAppaBatteryPackageModel.listByName({
          organizationId,
          name: "linear",
        })
      ).map((row) => row.contentHash),
    ).toEqual(expect.arrayContaining(["hash-a", "hash-b"]));
    expect(
      await OpenAppaBatteryPackageModel.findByHash({
        organizationId,
        contentHash: "hash-b",
      }),
    ).toMatchObject({ description: "v2", files: files("second") });

    expect(
      await OpenAppaBatteryPackageModel.delete({
        organizationId,
        contentHash: "hash-a",
      }),
    ).toBe(true);
    expect(
      await OpenAppaBatteryPackageModel.delete({
        organizationId,
        contentHash: "hash-a",
      }),
    ).toBe(false);
    expect(
      (await OpenAppaBatteryPackageModel.list(organizationId)).map(
        (row) => row.contentHash,
      ),
    ).toEqual(["hash-b"]);
  });

  test("one hash may be stored by two organizations", async ({
    makeOrganization,
  }) => {
    const one = (await makeOrganization()).id;
    const other = (await makeOrganization()).id;
    const values = {
      name: "linear",
      description: "Linear",
      contentHash: "hash-a",
      files: files("first"),
    };
    await OpenAppaBatteryPackageModel.insert({
      organizationId: one,
      ...values,
    });
    await OpenAppaBatteryPackageModel.insert({
      organizationId: other,
      ...values,
    });

    expect(
      await OpenAppaBatteryPackageModel.findByHash({
        organizationId: other,
        contentHash: "hash-a",
      }),
    ).not.toBeNull();
    await OpenAppaBatteryPackageModel.delete({
      organizationId: one,
      contentHash: "hash-a",
    });
    expect(
      await OpenAppaBatteryPackageModel.findByHash({
        organizationId: other,
        contentHash: "hash-a",
      }),
    ).not.toBeNull();
  });
});
