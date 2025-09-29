import type {
  ToolInvocationAutonomyPolicy,
  TrustedDataAutonomyPolicy,
} from "./types";

export default {
  toolInvocationAutonomyPolicies: [
    // cannot send emails to @grafana.com domain
    {
      mcpServerName: "gmail",
      toolName: "sendEmail",
      description: "Cannot send emails to @grafana.com domain",
      argumentName: "to",
      operator: "endsWith",
      value: "@grafana.com",
      allow: false,
    },
    // Block a specific file
    // {
    //   mcpServerName: 'file',
    //   toolName: 'readFile',
    //   description: 'Cannot read a specific file',
    //   argumentName: 'path',
    //   operator: 'contains',
    //   value: 'Desktop/some-interesting-file.txt',
    //   allow: false,
    // },
  ] as ToolInvocationAutonomyPolicy[],
  trustedDataAutonomyPolicies: [
    // Emails from @archestra.ai domains are safe
    {
      mcpServerName: "gmail",
      toolName: "getEmails",
      description: "Reading e-mails from @archestra.ai domains are safe",
      attributePath: "emails[*].from",
      operator: "endsWith",
      value: "@archestra.ai",
    },
    // {
    //   mcpServerName: 'gmail',
    //   toolName: 'sendEmail',
    //   description: 'Sending e-mails to @archestra.ai domains are safe',
    //   attributePath: 'to',
    //   operator: 'endsWith',
    //   value: '@archestra.ai',
    // },
    {
      mcpServerName: "file",
      toolName: "readFile",
      description: "Reading files from the desktop is safe",
      attributePath: "path",
      operator: "regex",
      value: ".*/Desktop.*",
    },
  ] as TrustedDataAutonomyPolicy[],
};
