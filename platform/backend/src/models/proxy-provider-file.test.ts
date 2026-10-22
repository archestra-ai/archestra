import { expect, test } from "@/test";
import ProxyProviderFileModel from "./proxy-provider-file";

test("provider file lifecycle requires matching organization, stable principal, provider and full account binding", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const scope = {
    organizationId: org.id,
    principalKind: "virtual_key",
    principalId: "fixture-key",
    provider: "azure",
    accountBinding: "fixture-account",
  };
  const row = await ProxyProviderFileModel.create({
    ...scope,
    upstreamFileId: "file-native",
    filename: "fixture.bin",
    mimeType: "application/octet-stream",
    sizeBytes: 4,
    purpose: "user_data",
    metadata: { created_at: 1 },
  });
  expect(await ProxyProviderFileModel.findOwned(row.id, scope)).toMatchObject({
    id: row.id,
    upstreamFileId: "file-native",
  });
  for (const field of [
    "organizationId",
    "principalKind",
    "principalId",
    "provider",
    "accountBinding",
  ] as const) {
    const other = { ...scope, [field]: "different" };
    expect(await ProxyProviderFileModel.findOwned(row.id, other)).toBeNull();
    expect(
      await ProxyProviderFileModel.listOwned(other, {
        limit: 10,
        order: "asc",
      }),
    ).toEqual([]);
    await ProxyProviderFileModel.deleteOwned(row.id, other);
    expect(
      await ProxyProviderFileModel.findOwned(row.id, scope),
    ).not.toBeNull();
  }
  await ProxyProviderFileModel.deleteOwned(row.id, scope);
  expect(await ProxyProviderFileModel.findOwned(row.id, scope)).toBeNull();
});

test("expired provider files are unavailable and do not appear in bounded cursor pages", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const scope = {
    organizationId: org.id,
    principalKind: "user",
    principalId: "fixture-user",
    provider: "azure",
    accountBinding: "fixture-account",
  };
  const values = {
    ...scope,
    upstreamFileId: "file-native",
    filename: "fixture.bin",
    mimeType: "application/octet-stream",
    sizeBytes: 4,
    purpose: "user_data",
    metadata: {},
  };
  const expired = await ProxyProviderFileModel.create({
    ...values,
    expiresAt: new Date(Date.now() - 1000),
  });
  const first = await ProxyProviderFileModel.create(values);
  const second = await ProxyProviderFileModel.create(values);
  expect(await ProxyProviderFileModel.findOwned(expired.id, scope)).toBeNull();
  const list = await ProxyProviderFileModel.listOwned(scope, {
    limit: 1,
    order: "asc",
  });
  expect(list).toHaveLength(1);
  const remaining = await ProxyProviderFileModel.listOwned(scope, {
    limit: 10,
    order: "asc",
    after: list[0].id,
  });
  expect([...list, ...remaining].map((row) => row.id).sort()).toEqual(
    [first.id, second.id].sort(),
  );
});
