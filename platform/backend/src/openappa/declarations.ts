import { createHash, randomBytes } from "node:crypto";
import type {
  ComposeBatteryInput,
  ComposedPolicy,
  DispatchPolicy,
  HelperBindingInput,
  BatteryPackage as NativeBatteryPackage,
  PolicyDeclarations,
} from "@archestra/openappa-rs";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import OpenAppaBatteryPackageModel from "@/models/openappa-battery-package";
import { OpenappaCredentialError } from "@/openappa/failure";
import { OPENAPPA_HELPERS_PREFIX } from "@/routes/route-paths";
import { resolveCredentialValue } from "@/services/credentials";
import { ApiError } from "@/types";
import type {
  BatteryPackageFile,
  BatterySource,
} from "@/types/openappa-batteries";
import { mapWithConcurrency } from "@/utils/concurrency";
import { archestraAudience } from "./archestra-audience";

/** One `include` entry, classified by its spelling and resolved to its bytes. */
export type EntryResolution = {
  /** The entry as the root document spells it. */
  entry: string;
  name: string;
  line: number;
  source: BatterySource;
  /** The content hash the entry spells; null for the bundled spelling. */
  packageHash: string | null;
  /** The battery the entry resolves to, null when nothing answers it. */
  battery: NativeBatteryPackage | null;
};

/** One `[server_aliases]` binding as the root authors it. */
export type AliasDeclaration = {
  namespace: string;
  servers: string[];
  line: number;
};

/** What a root document declares about its batteries, resolved against this organization. */
export type PolicyResolution = {
  entries: EntryResolution[];
  aliases: AliasDeclaration[];
  /** The `[credentials]` table: helper variable → runtime credential key. */
  credentials: Record<string, string>;
  /** The annotators the root's own tool rules route calls to. */
  routedAnnotators: string[];
  /**
   * Everything wrong with the declarations themselves: a shape the reader could
   * not make sense of, and an entry spelled outside the two admitted forms.
   */
  errors: string[];
};

/**
 * One credential value reaching one battery's helper sandbox: the battery an
 * include entry resolves to, a variable its manifest declares, and the store key
 * the `[credentials]` table binds to that variable.
 */
type Grant = { battery: string; variable: string; key: string };

/** The grants `next` holds that `previous` did not, key changes included. */
export function addedGrants(
  previous: readonly Grant[],
  next: readonly Grant[],
): Grant[] {
  const before = new Map(previous.map((grant) => [grantKey(grant), grant.key]));
  return next.filter((grant) => before.get(grantKey(grant)) !== grant.key);
}

/** The include entry spelling a bundled battery of this name. */
export function bundledEntry(name: string): string {
  return `batteries/${name}/appa.toml`;
}

/** The include entry spelling one stored package, by the bytes it holds. */
export function uploadedEntry(params: {
  name: string;
  contentHash: string;
}): string {
  return `batteries/${params.name}@sha256-${params.contentHash}/appa.toml`;
}

/** The identity of a package's bytes; the store is unique by it per organization. */
export function packageContentHash(files: BatteryPackageFile[]): string {
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

/**
 * The battery declarations of a root document: reading them, resolving every
 * include entry to the exact bytes it spells, and turning the resolution into the
 * inputs the addon composes from.
 *
 * Resolution is exact. A bundled spelling resolves to the bundled battery of that
 * name at the current pin and to nothing else; a hashed spelling resolves to the
 * organization's stored package with exactly that content hash, whose manifest must
 * name the same battery. There is no by-name fallback and an upload never shadows a
 * bundled battery.
 */
class OpenAppaDeclarations {
  /** Presented by the runtime on every helper consult; minted at boot, never stored. */
  readonly bridgeToken = randomBytes(32).toString("hex");
  /** The bundled list is immutable per binary; crossing napi copies every file. */
  private bundled: Promise<NativeBatteryPackage[]> | null = null;
  /** Inspected packages by content hash: the bytes fix the result. */
  private readonly inspected = new LRUCacheManager<NativeBatteryPackage>({
    maxSize: 32,
    maxBytes: 64 * 1024 * 1024,
    sizeOf: (battery) =>
      battery.files.reduce((total, file) => total + file.text.length, 0),
    defaultTtl: 0,
  });
  /** Declarations of effective documents by content hash: the bytes fix the result. */
  private readonly effective = new LRUCacheManager<PolicyDeclarations>({
    maxSize: 64,
    defaultTtl: 0,
  });

  /**
   * Publishes the bridge bearer where the runtime reads it, and answers the
   * variable a composition must name for it.
   *
   * The addon resolves the host's own `APPA_ARCHESTRA_*` variables from this
   * process's environment and refuses a document whose variable is unset, so
   * every caller about to cross into the addon publishes the value first
   * instead of relying on an earlier import.
   */
  publishBridgeToken(): string {
    process.env[OPENAPPA_BRIDGE_TOKEN_ENV] = this.bridgeToken;
    return OPENAPPA_BRIDGE_TOKEN_ENV;
  }

  /** Read a root document's declarations and resolve every include entry. */
  async resolve(params: {
    organizationId: string;
    content: string;
  }): Promise<PolicyResolution> {
    const native = await loadNative();
    const declarations = await native.parseOpenappaDeclarations(params.content);
    const errors = [...declarations.errors];
    const declared: Array<{
      entry: string;
      line: number;
      spelling: EntrySpelling;
    }> = [];
    for (const include of declarations.include) {
      const spelling = classify(include.entry);
      if (!spelling) {
        errors.push(
          `include (line ${include.line}): ${JSON.stringify(include.entry)} is neither batteries/<name>/appa.toml nor batteries/<name>@sha256-<hash>/appa.toml`,
        );
        continue;
      }
      declared.push({ entry: include.entry, line: include.line, spelling });
    }
    // Entries resolve against the bundle and the package store independently,
    // so they are resolved together, a few at a time: each is a store read and
    // a native inspection. The document's order is what is returned.
    const settled = await mapWithConcurrency(
      declared,
      RESOLVE_CONCURRENCY,
      ({ spelling }) =>
        this.resolveSpelling({
          organizationId: params.organizationId,
          ...spelling,
        }),
    );
    const batteries = settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const entries: EntryResolution[] = declared.map(
      ({ entry, line, spelling }, index) => ({
        entry,
        line,
        ...spelling,
        battery: batteries[index] ?? null,
      }),
    );
    return {
      entries,
      aliases: declarations.serverAliases,
      credentials: Object.fromEntries(
        declarations.credentials.map(({ variable, key }) => [variable, key]),
      ),
      routedAnnotators: declarations.routedAnnotators,
      errors,
    };
  }

  /**
   * The battery an install row serves, by the bytes the row records: a row with no
   * package hash serves the bundled battery of its name.
   */
  async resolveInstalled(params: {
    organizationId: string;
    name: string;
    packageHash: string | null;
  }): Promise<NativeBatteryPackage | null> {
    return this.resolveSpelling({
      organizationId: params.organizationId,
      name: params.name,
      source: params.packageHash === null ? "bundled" : "upload",
      packageHash: params.packageHash,
    });
  }

  /**
   * The newest stored version of a battery name that still validates. A version
   * whose bytes no longer inspect is not the organization's battery any more, so
   * the search walks back through the older versions rather than reporting the
   * name as having no package at all.
   */
  async resolveNewestStored(params: {
    organizationId: string;
    name: string;
    /** The newest version, when the caller already knows it; tried first. */
    newest?: string;
  }): Promise<{ contentHash: string; battery: NativeBatteryPackage } | null> {
    const { organizationId, name } = params;
    const tried = new Set<string>();
    const attempt = async (contentHash: string) => {
      tried.add(contentHash);
      const battery = await this.resolveSpelling({
        organizationId,
        name,
        source: "upload",
        packageHash: contentHash,
      });
      return battery ? { contentHash, battery } : null;
    };
    if (params.newest) {
      const resolved = await attempt(params.newest);
      if (resolved) return resolved;
    }
    for (const stored of await OpenAppaBatteryPackageModel.listByName({
      organizationId,
      name,
    })) {
      if (tried.has(stored.contentHash)) continue;
      const resolved = await attempt(stored.contentHash);
      if (resolved) return resolved;
    }
    return null;
  }

  /**
   * The batteries to compose for a resolution: every entry in the order the root
   * spells it, an entry that resolves to nothing — or to a battery the host holds
   * back — composing as an empty battery under its name so one stale entry never
   * takes the whole policy down.
   */
  composeInputs(params: {
    entries: readonly EntryResolution[];
    /** The helper endpoint for a battery, or null to compose it as the stub. */
    helpers: (entry: EntryResolution) => HelperBindingInput | null | "stub";
  }): ComposeBatteryInput[] {
    return params.entries.map((entry) => {
      const helpers = entry.battery ? params.helpers(entry) : "stub";
      return helpers === "stub" || !entry.battery
        ? { entry: entry.entry, name: entry.name, policy: STUB_POLICY }
        : {
            entry: entry.entry,
            name: entry.name,
            policy: entry.battery.policy,
            ...(helpers === null ? {} : { helpers }),
          };
    });
  }

  /**
   * Compose a document for its own sake: the same composition the recompose makes,
   * with the helper endpoints pointed at a placeholder, since a document that is
   * only being checked has no derived install row to serve its helpers from. A
   * composition that returns content is a successful validation.
   */
  async composeForCheck(params: {
    root: string;
    resolution: PolicyResolution;
  }): Promise<ComposedPolicy> {
    const native = await loadNative();
    const tokenEnv = this.publishBridgeToken();
    return native.composeOpenappaPolicy({
      root: params.root,
      batteries: this.composeInputs({
        entries: params.resolution.entries,
        helpers: (entry) =>
          entry.battery && entry.battery.externals.length > 0
            ? { urlBase: helperUrlBase(CHECKED_HELPER_OWNER), tokenEnv }
            : null,
      }),
    });
  }

  /**
   * The document with the values of the credentials the runtime reads itself:
   * the `[credentials]` variables an external or profile names as its
   * `token_env`, resolved for the organization now, so a value set, rotated or
   * removed since the last dispatch reaches this one. A variable with no
   * binding or no organization value is left out; a bound one that cannot be
   * resolved rejects.
   */
  async dispatchPolicy(params: {
    organizationId: string;
    content: string;
  }): Promise<DispatchPolicy> {
    const { organizationId, content } = params;
    const contentHash = createHash("sha256").update(content).digest("hex");
    let declarations = this.effective.get(contentHash);
    if (!declarations) {
      const native = await loadNative();
      declarations = await native.parseOpenappaDeclarations(content);
      this.effective.set(contentHash, declarations);
    }
    const keys = new Map(
      declarations.credentials.map(({ variable, key }) => [variable, key]),
    );
    const resolved = await Promise.all(
      declarations.runtimeCredentials.map(async (variable) => {
        const key = keys.get(variable);
        if (!key) return null;
        try {
          const value = await resolveCredentialValue({
            organizationId,
            credentialId: key,
            scope: "organization",
          });
          return value === null ? null : ([variable, value] as const);
        } catch (error) {
          // A bound credential that cannot be read fails the dispatch rather
          // than running it as though the credential were unset. Only a
          // refused binding is the organization's to fix; any other failure
          // stays retryable.
          logger.warn(
            { organizationId, variable, error },
            "OpenAPPA runtime credential could not be resolved",
          );
          if (error instanceof ApiError && error.statusCode === 400)
            throw new OpenappaCredentialError(variable, error);
          throw error;
        }
      }),
    );
    return {
      content,
      credentials: Object.fromEntries(
        resolved.filter((entry) => entry !== null),
      ),
    };
  }

  /** Every grant a resolution holds: resolved batteries × declared variables × the table. */
  grants(resolution: PolicyResolution): Grant[] {
    const grants: Grant[] = [];
    for (const entry of resolution.entries) {
      if (!entry.battery) continue;
      for (const variable of entry.battery.credentials) {
        const key = resolution.credentials[variable];
        if (key) grants.push({ battery: entry.name, variable, key });
      }
    }
    return grants;
  }

  /**
   * The batteries bundled with the pinned OpenAPPA checkout. One whose helpers
   * the platform answers itself reads no credential and needs no setup.
   */
  async bundledBatteries(): Promise<NativeBatteryPackage[]> {
    const native = await loadNative();
    this.bundled ??= native
      .listBundledOpenappaBatteries()
      .then((batteries) =>
        batteries.map((battery) =>
          archestraAudience.servesBattery({
            batteryName: battery.name,
            packageHash: null,
          })
            ? { ...battery, credentials: [], setup: undefined }
            : battery,
        ),
      )
      .catch((error) => {
        this.bundled = null;
        throw error;
      });
    return this.bundled;
  }

  /** Validate uploaded bytes natively and remember the result under their hash. */
  async inspectFiles(params: {
    contentHash: string;
    files: BatteryPackageFile[];
  }): Promise<NativeBatteryPackage> {
    const native = await loadNative();
    const inspected = await native.inspectOpenappaBattery(params.files);
    this.inspected.set(params.contentHash, inspected);
    return inspected;
  }

  private async resolveSpelling(params: {
    organizationId: string;
    name: string;
    source: BatterySource;
    packageHash: string | null;
  }): Promise<NativeBatteryPackage | null> {
    const { organizationId, name, source, packageHash } = params;
    if (source === "bundled")
      return (
        (await this.bundledBatteries()).find(
          (battery) => battery.name === name,
        ) ?? null
      );
    if (packageHash === null) return null;
    // Bytes under a hash never change, so an inspected package is reusable; the
    // files column is only read when nothing inspected them yet.
    const cached = this.inspected.get(packageHash);
    if (cached)
      return cached.name === name &&
        (await OpenAppaBatteryPackageModel.existsByHash({
          organizationId,
          contentHash: packageHash,
        }))
        ? cached
        : null;
    const stored = await OpenAppaBatteryPackageModel.findByHash({
      organizationId,
      contentHash: packageHash,
    });
    if (!stored) return null;
    const inspected = await this.inspectStored({
      organizationId,
      contentHash: packageHash,
      files: stored.files,
    });
    // The bytes a hash names must carry the battery the entry names; a package
    // renamed in its manifest answers its own spelling, never another's.
    return inspected?.name === name ? inspected : null;
  }

  private async inspectStored(params: {
    organizationId: string;
    contentHash: string;
    files: BatteryPackageFile[];
  }): Promise<NativeBatteryPackage | null> {
    const cached = this.inspected.get(params.contentHash);
    if (cached) return cached;
    try {
      return await this.inspectFiles(params);
    } catch (error) {
      logger.warn(
        {
          organizationId: params.organizationId,
          contentHash: params.contentHash,
          error,
        },
        "Stored OpenAPPA battery package no longer validates; ignoring it",
      );
      return null;
    }
  }
}

export const openappaDeclarations = new OpenAppaDeclarations();

/** The endpoint a battery's `command` helpers are served under, by owning row. */
export function helperUrlBase(installId: string): string {
  return `http://127.0.0.1:${config.api.port}${OPENAPPA_HELPERS_PREFIX}/${installId}`;
}

/** The battery an entry that resolves to nothing composes as, under its own name. */
const STUB_POLICY = "[policy]\nversion = 2\n";

/** The variable a composed policy names for the bridge bearer; its value is per process. */
const OPENAPPA_BRIDGE_TOKEN_ENV = "APPA_ARCHESTRA_BRIDGE_TOKEN";

/**
 * The owner a document being checked names for its helpers. No install row has
 * this id, so a composition made only to be checked cannot be consulted.
 */
const CHECKED_HELPER_OWNER = "checked";

const BUNDLED_SPELLING = /^batteries\/([a-z0-9][a-z0-9-]*)\/appa\.toml$/;
const UPLOADED_SPELLING =
  /^batteries\/([a-z0-9][a-z0-9-]*)@sha256-([0-9a-f]{64})\/appa\.toml$/;

/** What a spelling says about the battery it names. */
type EntrySpelling = {
  name: string;
  source: BatterySource;
  packageHash: string | null;
};

/** Which of the two admitted spellings an entry is, or nothing when it is neither. */
function classify(entry: string): EntrySpelling | null {
  const bundled = BUNDLED_SPELLING.exec(entry);
  if (bundled)
    return { name: bundled[1], source: "bundled", packageHash: null };
  const uploaded = UPLOADED_SPELLING.exec(entry);
  if (uploaded)
    return { name: uploaded[1], source: "upload", packageHash: uploaded[2] };
  return null;
}

/** What identifies a grant across revisions: the battery and the variable, not the key. */
export function grantKey(grant: Pick<Grant, "battery" | "variable">): string {
  return JSON.stringify([grant.battery, grant.variable]);
}

const loadNative = () => import("@archestra/openappa-rs");

const RESOLVE_CONCURRENCY = 4;
