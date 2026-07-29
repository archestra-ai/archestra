// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import {
  ARCHESTRA_MCP_SERVER_NAME,
  ARCHESTRA_TOOL_PREFIX,
  type ArchestraMcpIdentityOptions,
  type ArchestraToolShortName,
  DEFAULT_APP_NAME,
  getArchestraMcpCatalogName,
  getArchestraMcpServerName,
  getArchestraToolFullName,
  getArchestraToolPrefix,
  getArchestraToolShortName,
  isLikelyArchestraToolName,
  POLICY_EVALUATED_ARCHESTRA_TOOL_SHORT_NAMES,
} from "@archestra/shared";
import config from "@/config";
import type { Organization } from "@/types";

type ArchestraBrandingState = {
  appName: string | null;
  iconLogo: string | null;
};

class ArchestraMcpBranding {
  get identity(): ArchestraMcpIdentityOptions {
    return {
      appName: this.state.appName,
      fullWhiteLabeling: config.enterpriseFeatures.fullWhiteLabeling,
    };
  }

  get catalogName(): string {
    return getArchestraMcpCatalogName(this.identity);
  }

  /**
   * The deployment's display name for user-facing copy, honoring the enterprise
   * white-labeling gate — the same value as {@link catalogName}, exposed under
   * the name that reads correctly at call sites that are writing prose rather
   * than naming the built-in MCP catalog (proxy error messages, ChatOps
   * greetings, tool descriptions).
   *
   * Synchronous, so it is usable where `OrganizationModel.getAppName()` cannot
   * be awaited. Like every other branded built-in string, it assumes the
   * singleton has been synced for the target organization (see
   * {@link syncFromOrganization}), which `server.ts` does at startup.
   */
  get appName(): string {
    return getArchestraMcpCatalogName(this.identity);
  }

  get serverName(): string {
    return getArchestraMcpServerName(this.identity);
  }

  get toolPrefix(): string {
    return getArchestraToolPrefix(this.identity);
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  get iconLogo(): string | null {
    return config.enterpriseFeatures.fullWhiteLabeling
      ? this.state.iconLogo
      : null;
  }
  // SPDX-SnippetEnd

  /**
   * Rebrand shipped built-in text — the canonical `Archestra` brand and the
   * default `archestra__` tool-name prefix — to this organization's white-label
   * equivalents. A no-op unless full white-labeling is active (the branded
   * values then equal the canonical ones), so non-branded orgs pay nothing.
   *
   * Both swaps are case-sensitive and the two search tokens never overlap (the
   * prefix is lowercase, the brand capitalized), so ordering is irrelevant and
   * lowercase occurrences — `archestra.ai` URLs, `archestra__` inside a longer
   * identifier, env var names — are left untouched.
   *
   * Only ever applied to text the platform itself ships; user-authored content
   * is stored and served verbatim.
   */
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  brandBuiltInText(text: string): string {
    let out = text;
    if (this.toolPrefix !== ARCHESTRA_TOOL_PREFIX) {
      out = out.split(ARCHESTRA_TOOL_PREFIX).join(this.toolPrefix);
    }
    if (this.appName !== DEFAULT_APP_NAME) {
      out = out.split(DEFAULT_APP_NAME).join(this.appName);
    }
    return out;
  }
  // SPDX-SnippetEnd

  get allowedServerNames(): string[] {
    return Array.from(
      new Set([
        ARCHESTRA_MCP_SERVER_NAME,
        getArchestraMcpServerName(this.identity),
      ]),
    );
  }

  syncFromOrganization(
    organization: Pick<Organization, "appName" | "iconLogo"> | null,
  ): void {
    this.state = {
      appName: organization?.appName ?? null,
      iconLogo: organization?.iconLogo ?? null,
    };
  }

  getToolName(shortName: ArchestraToolShortName): string {
    return getArchestraToolFullName(shortName, this.identity);
  }

  getToolShortName(toolName: string): ArchestraToolShortName | null {
    return getArchestraToolShortName(toolName, {
      ...this.identity,
      includeDefaultPrefix: true,
    });
  }

  isToolName(toolName: string): boolean {
    return this.getToolShortName(toolName) !== null;
  }

  /**
   * Looser recognizer for the LLM-proxy auto-discovery filter ONLY: matches
   * gateway tool names that MCP clients have decorated with their own labels
   * (e.g. `archestra_staging__my_mcp_gateway_1234567__run_tool`), which the
   * strict {@link isToolName} misses. Never use for dispatch, RBAC, or policy
   * decisions — those must stay strict.
   */
  isLikelyToolName(toolName: string): boolean {
    return isLikelyArchestraToolName(toolName, {
      ...this.identity,
      includeDefaultPrefix: true,
    });
  }

  /**
   * True when the tool is a built-in that bypasses tool invocation and
   * trusted data policies. Most built-ins do; the ones in
   * {@link POLICY_EVALUATED_ARCHESTRA_TOOL_SHORT_NAMES} (e.g.
   * `query_knowledge_sources`, whose results can carry prompt injection from
   * knowledge-base content) are evaluated like external tools instead.
   */
  isPolicyBypassedToolName(toolName: string): boolean {
    const shortName = this.getToolShortName(toolName);
    return (
      shortName !== null &&
      !POLICY_EVALUATED_ARCHESTRA_TOOL_SHORT_NAMES.has(shortName)
    );
  }

  private state: ArchestraBrandingState = {
    appName: null,
    iconLogo: null,
  };
}

export const archestraMcpBranding = new ArchestraMcpBranding();
