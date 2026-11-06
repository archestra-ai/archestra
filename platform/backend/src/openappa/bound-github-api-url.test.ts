import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import { boundGithubApiUrl } from "@/openappa/bound-github-api-url";
import { expect, test } from "@/test";

async function githubApp(params: {
  organizationId: string;
  createdBy: string;
  key: string;
  githubUrl: string | null;
}) {
  await RuntimeCredentialDefinitionModel.create({
    organizationId: params.organizationId,
    createdBy: params.createdBy,
    definition: {
      key: params.key,
      name: params.key,
      kind: "github_app",
      description: "",
      icon: null,
      githubUrl: params.githubUrl,
      appId: "123",
      installationId: "456",
      allowPersonal: false,
      allowOrganization: true,
    },
  });
}

test("a GitHub Enterprise App gives its API root, GitHub.com and disagreeing Apps give none", async ({
  makeOrganization,
  makeUser,
}) => {
  const organizationId = (await makeOrganization()).id;
  const createdBy = (await makeUser()).id;
  for (const [key, githubUrl] of [
    ["enterprise", "https://code.example.com/api/v3/"],
    ["other-enterprise", "https://git.example.org/api/v3"],
    ["dotcom", "https://api.github.com"],
    ["dotcom-default", null],
  ] as const)
    await githubApp({ organizationId, createdBy, key, githubUrl });
  const urlFor = (credentialKeys: string[]) =>
    boundGithubApiUrl({ organizationId, credentialKeys });

  expect(await urlFor(["enterprise"])).toBe("https://code.example.com/api/v3");
  expect(await urlFor(["enterprise", "missing"])).toBe(
    "https://code.example.com/api/v3",
  );
  expect(await urlFor(["dotcom"])).toBeNull();
  expect(await urlFor(["dotcom-default"])).toBeNull();
  expect(await urlFor([])).toBeNull();
  expect(await urlFor(["enterprise", "other-enterprise"])).toBeNull();
  expect(await urlFor(["enterprise", "dotcom"])).toBeNull();
});
