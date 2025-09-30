import path from "node:path";
import dotenv from "dotenv";
import packageJson from "../package.json";

import type {
  ToolInvocationAutonomyPolicy,
  TrustedDataAutonomyPolicy,
} from "./types";

/**
 * Load .env from platform root
 *
 * This is a bit of a hack for now to avoid having to have a duplicate .env file in the backend subdirectory
 */
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

export default {
  api: {
    host: "0.0.0.0",
    port: 9000,
    name: "Archestra Platform API",
    version: packageJson.version,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
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
  debug: process.env.NODE_ENV === "development",
};
