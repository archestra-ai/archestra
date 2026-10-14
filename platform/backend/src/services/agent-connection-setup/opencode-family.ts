import {
  OPENCODE_FAMILY,
  type OpenCodeFamilyClientId,
  type OpenCodeFamilyDescriptor,
} from "@archestra/shared/opencode-family";

/**
 * The shared family descriptor plus what only the installer needs: the config
 * schema, the inline-config variable the launch check uses, and whether the
 * plugin API follows the binary's major version.
 */
export interface OpenCodeFamilyClient extends OpenCodeFamilyDescriptor {
  clientId: OpenCodeFamilyClientId;
  schemaUrl: string;
  /** Environment variable the client reads inline config from. */
  inlineConfigEnv: string;
  /**
   * OpenCode 2 changed its plugin API, so its setup reads the installed major
   * version. Kilo Code is numbered 7.x but keeps OpenCode 1's API at every
   * version, so its setup never looks.
   */
  versionedPluginApi: boolean;
}

export const OPENCODE_CLIENT: OpenCodeFamilyClient = {
  ...OPENCODE_FAMILY.opencode,
  clientId: "opencode",
  schemaUrl: "https://opencode.ai/config.json",
  inlineConfigEnv: "OPENCODE_CONFIG_CONTENT",
  versionedPluginApi: true,
};

export const KILO_CLIENT: OpenCodeFamilyClient = {
  ...OPENCODE_FAMILY.kilo,
  clientId: "kilo",
  schemaUrl: "https://app.kilo.ai/config.json",
  inlineConfigEnv: "KILO_CONFIG_CONTENT",
  versionedPluginApi: false,
};
