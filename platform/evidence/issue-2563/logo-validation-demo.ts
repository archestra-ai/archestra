import { UpdateOrganizationSchema } from "../../backend/src/types/organization";

const basePayload = {
  onboardingComplete: false,
  convertToolResultsToToon: false,
  autoConfigureNewTools: false,
  allowChatFileUploads: true,
  globalToolPolicy: "permissive" as const,
};

const cases = [
  {
    name: "valid image data URL",
    payload: {
      ...basePayload,
      logo: "data:image/png;base64,iVBORw0KGgo=",
    },
  },
  {
    name: "invalid non-image data URL",
    payload: {
      ...basePayload,
      logo: "data:text/plain;base64,SGVsbG8=",
    },
  },
];

for (const testCase of cases) {
  const result = UpdateOrganizationSchema.partial().safeParse(testCase.payload);
  console.log(`CASE: ${testCase.name}`);
  console.log(`SUCCESS: ${result.success}`);
  if (!result.success) {
    console.log(`ERROR: ${result.error.issues[0]?.message ?? "unknown"}`);
  }
  console.log("---");
}
