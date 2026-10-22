import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  OauthClientLabelModel,
  ServiceAccountLabelModel,
  VirtualApiKeyLabelModel,
} from "@/models/entity-labels";
import TeamLabelModel from "@/models/team-label";
import { expect, test } from "@/test";
import { resolveRequestAttributionLabels } from "./request-attribution-labels";

test("inherits defaults, lets the authenticated key override them, and scopes every label source", async ({
  makeOrganization,
  makeUser,
  makeTeam,
  makeServiceAccount,
  makeVirtualApiKey,
}) => {
  const org = await makeOrganization();
  const other = await makeOrganization();
  const user = await makeUser();
  const team = await makeTeam(org.id, user.id);
  const account = await makeServiceAccount(org.id);
  const key = await makeVirtualApiKey(org.id);
  const foreignKey = await makeVirtualApiKey(other.id);
  await TeamLabelModel.syncTeamLabels(team.id, [
    { key: "cost_center", value: "C100" },
  ]);
  await ServiceAccountLabelModel.syncLabels(account.id, [
    { key: "app", value: "search" },
  ]);
  await VirtualApiKeyLabelModel.syncLabels(key.id, [
    { key: "cost_center", value: "C200" },
  ]);
  await VirtualApiKeyLabelModel.syncLabels(foreignKey.id, [
    { key: "private", value: "foreign" },
  ]);
  const base = {
    organizationId: org.id,
    serviceAccountId: account.id,
    billingTeamId: team.id,
    proxyLabels: [{ key: "environment", value: "test" }],
  };
  expect(
    await resolveRequestAttributionLabels({
      ...base,
      authMethod: "virtual_key",
      virtualKeyId: key.id,
    }),
  ).toEqual({ environment: "test", app: "search", cost_center: "C200" });
  expect(
    await resolveRequestAttributionLabels({
      ...base,
      authMethod: "provider_key",
      passthroughVirtualKeyId: key.id,
    }),
  ).toEqual({ environment: "test", app: "search", cost_center: "C100" });
  expect(
    await resolveRequestAttributionLabels({
      organizationId: org.id,
      authMethod: "virtual_key",
      virtualKeyId: foreignKey.id,
    }),
  ).toEqual({});
  expect(
    await resolveRequestAttributionLabels({
      organizationId: other.id,
      billingTeamId: team.id,
      serviceAccountId: account.id,
    }),
  ).toEqual({});
});

test("OAuth and passthrough keys use the same trusted-label precedence", async ({
  makeOrganization,
  makeUser,
  makeTeam,
  makeOAuthClient,
  makeVirtualApiKey,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const team = await makeTeam(org.id, user.id);
  const client = await makeOAuthClient();
  await db
    .update(schema.oauthClientsTable)
    .set({ metadata: { organizationId: org.id } })
    .where(eq(schema.oauthClientsTable.id, client.id));
  await TeamLabelModel.syncTeamLabels(team.id, [
    { key: "cost_center", value: "C100" },
  ]);
  await OauthClientLabelModel.syncLabels(client.id, [
    { key: "app", value: "worker" },
  ]);
  const key = await makeVirtualApiKey(org.id);
  await VirtualApiKeyLabelModel.syncLabels(key.id, [
    { key: "app", value: "batch" },
  ]);
  expect(
    await resolveRequestAttributionLabels({
      organizationId: org.id,
      authMethod: "oauth_client_credentials",
      oauthClientId: client.id,
      billingTeamId: team.id,
    }),
  ).toEqual({ app: "worker", cost_center: "C100" });
  expect(
    await resolveRequestAttributionLabels({
      organizationId: org.id,
      authMethod: "passthrough_virtual_key",
      passthroughVirtualKeyId: key.id,
      billingTeamId: team.id,
    }),
  ).toEqual({ app: "batch", cost_center: "C100" });
});
