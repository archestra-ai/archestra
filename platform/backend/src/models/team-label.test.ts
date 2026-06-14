import { describe, expect, test } from "@/test";
import AgentLabelModel from "./agent-label";
import TeamLabelModel from "./team-label";

const label = (key: string, value: string) => ({
  key,
  value,
  keyId: "",
  valueId: "",
});

describe("TeamLabelModel", () => {
  describe("syncTeamLabels", () => {
    test("syncs labels for a team", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);

      await TeamLabelModel.syncTeamLabels(team.id, [
        label("environment", "production"),
        label("region", "us-west-2"),
      ]);

      const labels = await TeamLabelModel.getLabelsForTeam(team.id);

      expect(labels).toHaveLength(2);
      // Labels are returned alphabetically by key.
      expect(labels[0]).toMatchObject({
        key: "environment",
        value: "production",
      });
      expect(labels[1]).toMatchObject({ key: "region", value: "us-west-2" });
      expect(labels[0].keyId).toBeTruthy();
      expect(labels[0].valueId).toBeTruthy();
    });

    test("replaces existing labels when syncing", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);

      await TeamLabelModel.syncTeamLabels(team.id, [
        label("environment", "staging"),
      ]);
      await TeamLabelModel.syncTeamLabels(team.id, [
        label("environment", "production"),
        label("team", "engineering"),
      ]);

      const labels = await TeamLabelModel.getLabelsForTeam(team.id);
      expect(labels).toHaveLength(2);
      expect(labels.map((l) => `${l.key}=${l.value}`)).toEqual([
        "environment=production",
        "team=engineering",
      ]);
    });

    test("clears all labels when syncing an empty array", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);

      await TeamLabelModel.syncTeamLabels(team.id, [label("env", "prod")]);
      await TeamLabelModel.syncTeamLabels(team.id, []);

      const labels = await TeamLabelModel.getLabelsForTeam(team.id);
      expect(labels).toHaveLength(0);
    });
  });

  describe("getLabelsForTeams (batch)", () => {
    test("returns labels keyed by team id and empty arrays for unlabeled teams", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const teamA = await makeTeam(org.id, user.id, { name: "Team A" });
      const teamB = await makeTeam(org.id, user.id, { name: "Team B" });

      await TeamLabelModel.syncTeamLabels(teamA.id, [label("env", "prod")]);

      const map = await TeamLabelModel.getLabelsForTeams([teamA.id, teamB.id]);

      expect(map.get(teamA.id)).toHaveLength(1);
      expect(map.get(teamA.id)?.[0]).toMatchObject({
        key: "env",
        value: "prod",
      });
      expect(map.get(teamB.id)).toEqual([]);
    });

    test("returns an empty map for no team ids", async () => {
      const map = await TeamLabelModel.getLabelsForTeams([]);
      expect(map.size).toBe(0);
    });
  });

  describe("getTeamIdsMatchingLabels", () => {
    test("ANDs across keys and ORs within a key's values", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const prodBackend = await makeTeam(org.id, user.id, { name: "pb" });
      const prodFrontend = await makeTeam(org.id, user.id, { name: "pf" });
      const stagingBackend = await makeTeam(org.id, user.id, { name: "sb" });

      await TeamLabelModel.syncTeamLabels(prodBackend.id, [
        label("env", "prod"),
        label("tier", "backend"),
      ]);
      await TeamLabelModel.syncTeamLabels(prodFrontend.id, [
        label("env", "prod"),
        label("tier", "frontend"),
      ]);
      await TeamLabelModel.syncTeamLabels(stagingBackend.id, [
        label("env", "staging"),
        label("tier", "backend"),
      ]);

      // env=prod AND tier in (backend, frontend) -> both prod teams
      const both = await TeamLabelModel.getTeamIdsMatchingLabels({
        env: ["prod"],
        tier: ["backend", "frontend"],
      });
      expect(new Set(both)).toEqual(new Set([prodBackend.id, prodFrontend.id]));

      // env=prod AND tier=backend -> only prodBackend
      const single = await TeamLabelModel.getTeamIdsMatchingLabels({
        env: ["prod"],
        tier: ["backend"],
      });
      expect(single).toEqual([prodBackend.id]);
    });

    test("returns an empty array when nothing matches", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);
      await TeamLabelModel.syncTeamLabels(team.id, [label("env", "prod")]);

      const ids = await TeamLabelModel.getTeamIdsMatchingLabels({
        env: ["nonexistent"],
      });
      expect(ids).toEqual([]);
    });
  });

  describe("key/value listing scoped to teams", () => {
    test("getAllKeys, getValuesByKey and getAllValues only reflect team labels", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);

      await TeamLabelModel.syncTeamLabels(team.id, [
        label("env", "prod"),
        label("region", "us-east-1"),
      ]);

      expect(await TeamLabelModel.getAllKeys(org.id)).toEqual([
        "env",
        "region",
      ]);
      expect(
        await TeamLabelModel.getValuesByKey({
          organizationId: org.id,
          key: "env",
        }),
      ).toEqual(["prod"]);
      expect(
        await TeamLabelModel.getValuesByKey({
          organizationId: org.id,
          key: "missing",
        }),
      ).toEqual([]);
      expect(await TeamLabelModel.getAllValues(org.id)).toEqual([
        "prod",
        "us-east-1",
      ]);
    });

    test("scopes keys/values to the requested organization", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const user = await makeUser();
      const teamA = await makeTeam(orgA.id, user.id, { name: "A" });
      const teamB = await makeTeam(orgB.id, user.id, { name: "B" });

      await TeamLabelModel.syncTeamLabels(teamA.id, [label("env", "prod")]);
      await TeamLabelModel.syncTeamLabels(teamB.id, [
        label("secret-key", "secret-value"),
      ]);

      // orgA must not see orgB's team label taxonomy.
      expect(await TeamLabelModel.getAllKeys(orgA.id)).toEqual(["env"]);
      expect(await TeamLabelModel.getAllValues(orgA.id)).toEqual(["prod"]);
      expect(
        await TeamLabelModel.getValuesByKey({
          organizationId: orgA.id,
          key: "secret-key",
        }),
      ).toEqual([]);
    });
  });

  describe("pruneKeysAndValues integration", () => {
    test("keeps keys/values still referenced by a team label", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);

      await TeamLabelModel.syncTeamLabels(team.id, [
        label("owned-by-team", "platform"),
      ]);

      const { deletedKeys, deletedValues } =
        await AgentLabelModel.pruneKeysAndValues();
      expect(deletedKeys).toBe(0);
      expect(deletedValues).toBe(0);

      expect(await TeamLabelModel.getAllKeys(org.id)).toContain(
        "owned-by-team",
      );
      expect(await TeamLabelModel.getAllValues(org.id)).toContain("platform");
    });

    test("prunes keys/values once no team label references them", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);

      await TeamLabelModel.syncTeamLabels(team.id, [
        label("ephemeral-key", "ephemeral-value"),
      ]);
      // Removing the label orphans the key/value.
      await TeamLabelModel.syncTeamLabels(team.id, []);

      await AgentLabelModel.pruneKeysAndValues();

      expect(await AgentLabelModel.getAllKeys()).not.toContain("ephemeral-key");
      expect(await AgentLabelModel.getAllValues()).not.toContain(
        "ephemeral-value",
      );
    });
  });
});
