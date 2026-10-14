// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// Synthetic fixture used to inspect long decoded-token layouts.
export const largeSignIn = {
  iss: "https://idp.example.test",
  sub: "sample-admin",
  aud: "synthetic-client",
  email: "admin@example.test",
  email_verified: true,
  name: "Sample Administrator",
  preferred_username: "sample.admin",
  given_name: "Sample",
  family_name: "Administrator",
  locale: "en-CA",
  zoneinfo: "America/Toronto",
  auth_time: 1791972000,
  iat: 1791972000,
  exp: 1791975600,
  amr: ["pwd", "mfa", "otp"],
  acr: "urn:example:assurance:multi-factor",
  groups: [
    "platform-admins",
    "engineering",
    "security-reviewers",
    "support",
    "analytics",
    "project-editors",
    "cloud-operators",
    "documentation",
  ],
  roles: ["admin", "member", "editor", "auditor", "developer"],
  profile: {
    department: "Engineering",
    title: "Platform Administrator",
    employee_type: "Full time",
    organization: "Example Organization",
    address: {
      country: "CA",
      region: "Ontario",
      formatted: "Synthetic address for preview only",
    },
  },
  session_context: {
    device: { platform: "macOS", managed: true, assurance: "verified" },
    authentication_methods: ["password", "security-key"],
    policy_evaluations: Array.from({ length: 12 }, (_, i) => ({
      policy: `example-policy-${i + 1}`,
      decision: "allow",
      reason: "Synthetic policy evaluation",
    })),
  },
  "https://example.test/claims/permissions": Array.from(
    { length: 60 },
    (_, i) => ({
      resource: `example-resource-${String(i + 1).padStart(3, "0")}`,
      scopes: ["read", "list", "update"],
      conditions: {
        department: "Engineering",
        environment: ["development", "staging"],
        region: ["ca-central", "us-east"],
      },
      metadata: {
        source: "synthetic-preview",
        description:
          "A long nested claim used to inspect wrapping and scrolling in the sign-in data viewer.",
      },
    }),
  ),
  "https://example.test/claims/long-value":
    "Synthetic claim content for layout verification. ".repeat(40),
};
