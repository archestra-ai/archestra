import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0253_rename-github-repository-files-flag.sql"),
  "utf-8",
);

test("renames GitHub repository file indexing config flag", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();

  const [githubConnector] = await db
    .insert(schema.knowledgeBaseConnectorsTable)
    .values({
      organizationId: org.id,
      name: "GitHub Connector",
      connectorType: "github",
      config: {
        type: "github",
        githubUrl: "https://api.github.com",
        owner: "test-org",
        includeMarkdownFiles: true,
        fileTypes: [".yaml"],
      } as never,
    })
    .returning();

  const [gitlabConnector] = await db
    .insert(schema.knowledgeBaseConnectorsTable)
    .values({
      organizationId: org.id,
      name: "GitLab Connector",
      connectorType: "gitlab",
      config: {
        type: "gitlab",
        gitlabUrl: "https://gitlab.example.com",
        includeMarkdownFiles: true,
      },
    })
    .returning();

  await db.execute(sql.raw(migrationSql));

  const [updatedGithubConnector] = await db
    .select({ config: schema.knowledgeBaseConnectorsTable.config })
    .from(schema.knowledgeBaseConnectorsTable)
    .where(eq(schema.knowledgeBaseConnectorsTable.id, githubConnector.id));

  expect(updatedGithubConnector.config).toMatchObject({
    includeRepositoryFiles: true,
    fileTypes: [".yaml"],
  });
  expect(updatedGithubConnector.config).not.toHaveProperty(
    "includeMarkdownFiles",
  );

  const [updatedGitlabConnector] = await db
    .select({ config: schema.knowledgeBaseConnectorsTable.config })
    .from(schema.knowledgeBaseConnectorsTable)
    .where(eq(schema.knowledgeBaseConnectorsTable.id, gitlabConnector.id));

  expect(updatedGitlabConnector.config).toMatchObject({
    includeMarkdownFiles: true,
  });
});
