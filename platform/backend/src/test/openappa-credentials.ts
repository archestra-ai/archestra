import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import { openappaBatteriesService } from "@/openappa/batteries";

/** An organization credential with a value, bound to a battery variable. */
export async function bindOrganizationCredential(params: {
  organizationId: string;
  userId: string;
  variable: string;
  key: string;
}) {
  const { organizationId, userId, variable, key } = params;
  await RuntimeCredentialDefinitionModel.create({
    organizationId,
    createdBy: userId,
    definition: {
      key,
      name: key,
      kind: "secret",
      description: "",
      icon: null,
      allowPersonal: false,
      allowOrganization: true,
    },
  });
  await RuntimeCredentialConnectionModel.upsert({
    organizationId,
    scope: "organization",
    userId: null,
    credentialId: key,
    value: `${key}-value`,
  });
  await openappaBatteriesService.setCredentialBinding({
    userId,
    organizationId,
    variable,
    key,
  });
}
