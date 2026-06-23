// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import {
  ARCHESTRA_MCP_SERVER_NAME,
  type ArchestraMcpIdentityOptions,
  type ArchestraToolShortName,
  getArchestraMcpCatalogName,
  getArchestraMcpServerName,
  getArchestraToolFullName,
  getArchestraToolPrefix,
  getArchestraToolShortName,
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

  private state: ArchestraBrandingState = {
    appName: null,
    iconLogo: null,
  };
}

export const archestraMcpBranding = new ArchestraMcpBranding();
