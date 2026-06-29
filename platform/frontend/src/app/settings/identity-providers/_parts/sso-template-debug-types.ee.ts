"use client";

export type SsoTemplateTestMode = "role" | "team-sync";

export type SsoRoleMappingRule = {
  expression: string;
  role: string;
};
