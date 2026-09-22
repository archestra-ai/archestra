import { createHash } from "node:crypto";
import type {
  ComposeBatteryInput,
  BatteryPackage as NativeBatteryPackage,
  PolicyEditInput,
} from "@archestra/openappa-rs";
import { parseFullToolName } from "@archestra/shared";
import { userHasPermission } from "@/auth";
import config from "@/config";
import logger from "@/logging";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import OpenAppaBatteryPackageModel from "@/models/openappa-battery-package";
import OpenAppaEffectivePolicyModel, {
  type EffectivePolicyValues,
} from "@/models/openappa-effective-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OrganizationModel from "@/models/organization";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import ToolModel from "@/models/tool";
import {
  GUARDRAILS_REVISION_CONFLICT,
  guardrailsPolicyService,
} from "@/services/guardrails-policy";
import { ApiError } from "@/types";
import type { GuardrailsPolicy } from "@/types/guardrails-policy";
import type {
  BatteryCredentialBindings,
  BatteryInstall,
  BatteryInstallRow,
  BatteryInstallStatus,
  BatteryInstallView,
  BatteryMatch,
  BatteryPackageFile,
  BatterySummary,
  CreateBatteryInstall,
  EffectivePolicy,
  PolicyBatteryView,
  PolicyDeclarationsView,
  UpdateBatteryInstall,
  UploadedBatteryPackage,
} from "@/types/openappa-batteries";
import { mapWithConcurrency } from "@/utils/concurrency";
import { matchBatteries } from "./battery-match";
import {
  addedGrants,
  bundledEntry,
  type EntryResolution,
  helperUrlBase,
  openappaDeclarations,
  type PolicyResolution,
  packageContentHash,
  uploadedEntry,
} from "./declarations";

/** A battery after a write, and the derived row that write stands for. */
type BatteryWriteResult = {
  battery: PolicyBatteryView;
  /** Null when the write left the battery governing no catalog. */
  installId: string | null;
};

/**
 * The batteries of an organization's policy: composing the declarations its root
 * document makes, deriving the install rows that composition implies, and writing
 * those declarations on behalf of the panel and the install wizard.
 */
class OpenAppaBatteriesService {
  private readonly recomposing = new Map<string, Slot<Recomposition>>();
  /** Concurrent dispatches of one organization share a single policy read. */
  private readonly reading = new Map<string, Promise<EffectivePolicy>>();

  /** Every battery this organization can include, bundled and uploaded, with its rows. */
  async listBatteries(organizationId: string): Promise<BatterySummary[]> {
    const { installs } = await this.current(organizationId);
    const installsByBattery = new Map<string, BatteryInstallView[]>();
    for (const install of installs) {
      const views = installsByBattery.get(install.batteryName) ?? [];
      views.push(install);
      installsByBattery.set(install.batteryName, views);
    }
    const available = await this.availableBatteries(organizationId);
    return [...available.values()]
      .map(({ source, contentHash, package: battery }) => ({
        name: battery.name,
        description: battery.description,
        source,
        contentHash,
        namespaces: battery.namespaces,
        helpers: battery.helpers,
        credentials: battery.credentials,
        setup: battery.setup ?? null,
        installs: installsByBattery.get(battery.name) ?? [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The batteries a catalog entry stands for and the rows it already has. */
  async matchesForCatalog(params: {
    organizationId: string;
    catalogId: string;
  }): Promise<BatteryMatch[]> {
    const { organizationId, catalogId } = params;
    const catalog = await this.requireCatalog(params);
    const { installs } = await this.current(organizationId);
    const available = await this.availableBatteries(organizationId);
    return matchBatteries(catalog, new Set(available.keys())).map((match) => ({
      ...match,
      install:
        installs.find(
          (install) =>
            install.catalogId === catalogId &&
            install.batteryName === match.battery,
        ) ?? null,
    }));
  }

  /** What the root declares, what came of each declaration, and what holds it back. */
  async policyDeclarations(
    organizationId: string,
  ): Promise<PolicyDeclarationsView> {
    const { policy, batteries, unusedAliases } =
      await this.current(organizationId);
    const sync = await OpenAppaGithubSyncModel.find(organizationId);
    return {
      batteries,
      unusedAliases,
      rootRevision: policy.rootRevision,
      lastError: policy.lastError,
      managedInGithub: sync?.interval != null,
      heldPull:
        sync?.heldContentHash && sync.heldSourceCommit
          ? {
              contentHash: sync.heldContentHash,
              sourceCommit: sync.heldSourceCommit,
              reasons: sync.heldReasons,
            }
          : null,
    };
  }

  /** The policy the runtime opens for this organization, recomposed when it moved. */
  async getEffectivePolicy(organizationId: string): Promise<EffectivePolicy> {
    const inFlight = this.reading.get(organizationId);
    if (inFlight) return inFlight;
    const read = this.readEffectivePolicy(organizationId).finally(() => {
      this.reading.delete(organizationId);
    });
    this.reading.set(organizationId, read);
    return read;
  }

  /**
   * Compose the root with the batteries it declares and store the result. A
   * caller always gets a composition that started after it called: one already
   * running may have read inputs older than the caller's write, so later callers
   * share a single follow-up queued behind it.
   */
  async recompile(organizationId: string): Promise<EffectivePolicy> {
    return (await this.recompose(organizationId)).policy;
  }

  async recompileAll(): Promise<void> {
    await this.recompileOrganizations(await OrganizationModel.findAllIds());
  }

  /**
   * Called after a catalog's tools were synced: the prefixes its tools carry are
   * what alias targets resolve against, so every organization that aliases them
   * recomposes. Never throws; a battery problem must not fail an installation.
   */
  async onCatalogToolsChanged(catalogId: string): Promise<void> {
    if (!config.openappa.enabled) return;
    try {
      const catalog = await InternalMcpCatalogModel.findById(catalogId, {
        expandSecrets: false,
      });
      if (!catalog) return;
      await this.recompileForCatalog(catalog.organizationId);
    } catch (error) {
      logger.warn(
        { catalogId, error },
        "OpenAPPA recompose after a tool sync failed",
      );
    }
  }

  /**
   * Recompose every organization whose policy can alias a catalog's tool
   * prefixes: the catalog's own, or all of them when the catalog is global.
   * A catalog that has just been deleted or restored has no derived rows to
   * name its organizations, so they are read from the catalog itself.
   */
  async recompileForCatalog(organizationId: string | null): Promise<void> {
    if (!config.openappa.enabled) return;
    await this.recompileOrganizations(
      organizationId === null
        ? await OrganizationModel.findAllIds()
        : [organizationId],
    );
  }

  async recompileOrganizations(organizationIds: string[]): Promise<void> {
    if (!config.openappa.enabled) return;
    const results = await mapWithConcurrency(
      organizationIds,
      RECOMPILE_CONCURRENCY,
      (organizationId) => this.recompile(organizationId),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected")
        logger.warn(
          { organizationId: organizationIds[index], error: result.reason },
          "OpenAPPA effective policy recompile failed",
        );
    });
  }

  /**
   * A catalog's tool prefixes moved with its name. Every organization that spells
   * an old prefix in an alias target has it rewritten, unless the repository owns
   * its text — then the recompose that follows shows `server_missing` with the
   * stale target until the repository is updated. One organization's failure
   * stops nothing for the others.
   */
  async onCatalogPrefixesRenamed(params: {
    catalogId: string;
    /** The catalog's organization; null for a global catalog, which serves all. */
    organizationId: string | null;
    userId: string;
    renamedTools: ReadonlyArray<{ oldName: string; newName: string }>;
  }): Promise<void> {
    if (!config.openappa.enabled) return;
    const organizationIds =
      params.organizationId === null
        ? await OrganizationModel.findAllIds()
        : [params.organizationId];
    const renames = prefixRenames(params.renamedTools);
    if (renames.size > 0)
      for (const organizationId of organizationIds)
        await this.reconcileAliases({
          organizationId,
          catalogId: params.catalogId,
          userId: params.userId,
          renames,
        }).catch((error) => {
          logger.warn(
            { organizationId, catalogId: params.catalogId, error },
            "OpenAPPA alias reconciliation after a catalog rename failed",
          );
        });
    await this.recompileOrganizations(organizationIds);
  }

  /** Include a battery and point its namespaces at one catalog's tool prefixes. */
  async createInstall(params: {
    userId: string;
    organizationId: string;
    install: CreateBatteryInstall;
  }): Promise<BatteryWriteResult> {
    const { userId, organizationId, install } = params;
    const catalog = await this.requireCatalog({
      organizationId,
      catalogId: install.catalogId,
    });
    const entry = install.packageHash
      ? uploadedEntry({
          name: install.batteryName,
          contentHash: install.packageHash,
        })
      : bundledEntry(install.batteryName);
    const battery = await openappaDeclarations.resolveInstalled({
      organizationId,
      name: install.batteryName,
      packageHash: install.packageHash,
    });
    if (!battery)
      throw new ApiError(404, `Unknown battery ${install.batteryName}`);
    await this.editRoot({
      organizationId,
      userId,
      edits: async (latest) => {
        const resolution = await openappaDeclarations.resolve({
          organizationId,
          content: latest.content,
        });
        const prefixes = await catalogToolPrefixes(organizationId, {
          targets: [],
          catalogIds: [catalog.id],
        });
        const targets = prefixes.byCatalog.get(catalog.id) ?? new Set<string>();
        return [
          { kind: "addInclude", entry },
          ...bindEdits({ resolution, namespaces: battery.namespaces, targets }),
        ];
      },
    });
    return this.batteryView({
      organizationId,
      name: install.batteryName,
      catalogId: install.catalogId,
    });
  }

  /**
   * Bind or unbind one catalog's prefixes for an included battery, or rebind the
   * credential variables it reads. The include entry stays either way.
   */
  async updateInstall(params: {
    userId: string;
    organizationId: string;
    id: string;
    changes: UpdateBatteryInstall;
  }): Promise<BatteryWriteResult> {
    const { userId, organizationId, id, changes } = params;
    const existing = await OpenAppaBatteryInstallModel.find({
      id,
      organizationId,
    });
    if (!existing) throw new ApiError(404, "Battery install not found");
    const battery = await openappaDeclarations.resolveInstalled({
      organizationId,
      name: existing.batteryName,
      packageHash: existing.packageHash,
    });
    await this.editRoot({
      organizationId,
      userId,
      edits: async (latest) => {
        const resolution = await openappaDeclarations.resolve({
          organizationId,
          content: latest.content,
        });
        const namespaces = battery?.namespaces ?? [];
        const prefixes = await catalogToolPrefixes(organizationId, {
          targets: [],
          catalogIds: [existing.catalogId],
        });
        const targets =
          prefixes.byCatalog.get(existing.catalogId) ?? new Set<string>();
        const edits: PolicyEditInput[] = [];
        if (changes.enabled !== undefined)
          edits.push(
            ...(changes.enabled
              ? bindEdits({ resolution, namespaces, targets })
              : unbindEdits({
                  resolution,
                  namespaces,
                  targets,
                  keep: otherNamespaces(resolution, existing.batteryName),
                })),
          );
        for (const [variable, key] of Object.entries(
          changes.credentialBindings ?? {},
        ))
          edits.push({ kind: "setCredential", variable, key });
        for (const variable of Object.keys(existing.credentialBindings))
          if (
            changes.credentialBindings &&
            !(variable in changes.credentialBindings)
          )
            edits.push({ kind: "setCredential", variable });
        return edits;
      },
    });
    return this.batteryView({
      organizationId,
      name: existing.batteryName,
      catalogId: existing.catalogId,
    });
  }

  /**
   * Stop governing one catalog with a battery: its prefixes leave the battery's
   * namespaces, and the entry itself goes once no target is left for it.
   */
  async deleteInstall(params: {
    userId: string;
    organizationId: string;
    id: string;
  }): Promise<void> {
    const { userId, organizationId, id } = params;
    const existing = await OpenAppaBatteryInstallModel.find({
      id,
      organizationId,
    });
    if (!existing) throw new ApiError(404, "Battery install not found");
    const battery = await openappaDeclarations.resolveInstalled({
      organizationId,
      name: existing.batteryName,
      packageHash: existing.packageHash,
    });
    await this.editRoot({
      organizationId,
      userId,
      edits: async (latest) => {
        const resolution = await openappaDeclarations.resolve({
          organizationId,
          content: latest.content,
        });
        const included = resolution.entries.find(
          (entry) => entry.name === existing.batteryName,
        );
        if (!included) return [];
        const namespaces = battery?.namespaces ?? [];
        const prefixes = await catalogToolPrefixes(organizationId, {
          targets: [],
          catalogIds: [existing.catalogId],
        });
        const targets =
          prefixes.byCatalog.get(existing.catalogId) ?? new Set<string>();
        const remaining = namespaces.some(
          (namespace) =>
            remainingTargets({ resolution, namespace, targets }).length > 0,
        );
        const keep = otherNamespaces(resolution, existing.batteryName);
        return [
          // With no target left anywhere the battery governs nothing, so the
          // entry that declares it goes with its last catalog.
          ...(remaining
            ? []
            : [{ kind: "removeInclude" as const, entry: included.entry }]),
          ...unbindEdits({ resolution, namespaces, targets, keep }),
        ];
      },
    });
    await this.recompile(organizationId);
  }

  /**
   * Store uploaded bytes under their hash and answer the entry that spells them.
   * A battery already included under another spelling has its entry replaced in
   * the same request, since one battery is included once.
   */
  async uploadPackage(params: {
    userId: string;
    organizationId: string;
    name: string;
    files: BatteryPackageFile[];
  }): Promise<UploadedBatteryPackage> {
    const { userId, organizationId, name, files } = params;
    const contentHash = packageContentHash(files);
    let inspected: NativeBatteryPackage;
    try {
      inspected = await openappaDeclarations.inspectFiles({
        contentHash,
        files,
      });
    } catch (error) {
      throw new ApiError(
        400,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (inspected.name !== name)
      throw new ApiError(
        400,
        `The package manifest names the battery ${inspected.name}, not ${name}`,
      );
    // Helper code runs with whatever credentials get bound to it later, so
    // supplying it takes the permission binding a credential takes.
    if (inspected.credentials.length > 0 || inspected.externals.length > 0)
      await requireCredentialUpdate({
        userId,
        organizationId,
        message:
          "Credential update permission is required to upload a battery with helper scripts",
      });
    await OpenAppaBatteryPackageModel.insert({
      organizationId,
      name: inspected.name,
      description: inspected.description,
      contentHash,
      files,
    });
    const entry = uploadedEntry({ name: inspected.name, contentHash });
    await this.editRoot({
      organizationId,
      userId,
      edits: async (latest) => {
        const resolution = await openappaDeclarations.resolve({
          organizationId,
          content: latest.content,
        });
        const included = resolution.entries.find(
          (candidate) => candidate.name === inspected.name,
        );
        if (!included || included.entry === entry) return [];
        return [
          { kind: "removeInclude", entry: included.entry },
          { kind: "addInclude", entry },
        ];
      },
    });
    await this.recompile(organizationId);
    return {
      name: inspected.name,
      description: inspected.description,
      contentHash,
      entry,
      namespaces: inspected.namespaces,
      helpers: inspected.helpers,
      credentials: inspected.credentials,
      setup: inspected.setup ?? null,
    };
  }

  /** Delete stored bytes nothing spells: the policy keeps every version it names. */
  async deletePackage(params: {
    organizationId: string;
    contentHash: string;
  }): Promise<void> {
    const { organizationId, contentHash } = params;
    const spelled = await this.spellsHash({ organizationId, contentHash });
    if (spelled)
      throw new ApiError(
        409,
        `Remove this package from the policy ${spelled} before deleting it`,
      );
    if (!(await OpenAppaBatteryPackageModel.delete(params)))
      throw new ApiError(404, "Battery package not found");
  }

  private async readEffectivePolicy(
    organizationId: string,
  ): Promise<EffectivePolicy> {
    const root = await guardrailsPolicyService.get(organizationId);
    const effective = await OpenAppaEffectivePolicyModel.find(organizationId);
    if (effective && effective.rootRevision === root.revision) return effective;
    return this.recompile(organizationId);
  }

  /** Whether the latest revision, or a held pull, spells these bytes. */
  private async spellsHash(params: {
    organizationId: string;
    contentHash: string;
  }): Promise<string | null> {
    const { organizationId, contentHash } = params;
    const latest = await guardrailsPolicyService.get(organizationId);
    const held = (await OpenAppaGithubSyncModel.find(organizationId))
      ?.heldContent;
    for (const [where, content] of [
      ["policy", latest.content] as const,
      ...(held ? [["held GitHub pull", held] as const] : []),
    ]) {
      const resolution = await openappaDeclarations.resolve({
        organizationId,
        content,
      });
      if (resolution.entries.some((entry) => entry.packageHash === contentHash))
        return where;
    }
    return null;
  }

  private async recompose(organizationId: string): Promise<Recomposition> {
    return coalesce(this.recomposing, organizationId, () =>
      this.recomposeNow(organizationId).catch(async (error) => {
        // Whatever the caller does with the failure, the stored row may be
        // behind the write that triggered this; the next read recomposes.
        await OpenAppaEffectivePolicyModel.invalidate(organizationId).catch(
          (invalidation) => {
            logger.warn(
              { organizationId, error: invalidation },
              "OpenAPPA effective policy could not be marked stale",
            );
          },
        );
        throw error;
      }),
    );
  }

  /**
   * What the panel reads: the stored composition when it still answers the root
   * and the rows it derived, recomposed when it does not. A reading writes
   * nothing - a policy nobody edited is served from what the last write stored.
   */
  private async current(organizationId: string): Promise<Recomposition> {
    const stored = await OpenAppaEffectivePolicyModel.find(organizationId);
    const root = await guardrailsPolicyService.get(organizationId);
    if (!stored || stored.rootRevision !== root.revision)
      return this.recompose(organizationId);
    const installs = await OpenAppaBatteryInstallModel.list(organizationId);
    const planned = await this.plan({
      organizationId,
      root,
      governed: installs.map((install) => install.catalogId),
    });
    const fingerprint = hash(
      JSON.stringify({
        batteries: this.composeInputs({ planned, installs }),
        credentials: planned.resolution.credentials,
      }),
    );
    // Catalogs, credentials or stored packages moved under the policy; only a
    // recomposition can say what the root composes to now.
    if (fingerprint !== stored.installFingerprint)
      return this.recompose(organizationId);
    return { ...planned, policy: stored, installs };
  }

  private async recomposeNow(organizationId: string): Promise<Recomposition> {
    for (let attempt = 0; attempt < RECOMPILE_ATTEMPTS; attempt++) {
      const expected = await OpenAppaEffectivePolicyModel.find(organizationId);
      const root = await guardrailsPolicyService.get(organizationId);
      const previous = await OpenAppaBatteryInstallModel.list(organizationId);
      const planned = await this.plan({
        organizationId,
        root,
        governed: previous.map((install) => install.catalogId),
      });
      // Rows the plan already agrees with are left alone: rewriting them would
      // touch every row of the organization on a call that changed nothing.
      const held = expected?.lastError ?? null;
      const settled = rowsSettled({ previous, rows: planned.rows, held });
      let installs = settled
        ? previous
        : await OpenAppaBatteryInstallModel.replaceAll({
            organizationId,
            rows: planned.rows,
          });
      const composed = this.composeInputs({ planned, installs });
      const installFingerprint = hash(
        JSON.stringify({
          batteries: composed,
          credentials: planned.resolution.credentials,
        }),
      );
      // Same inputs give the same bytes, so the stored row already is the answer.
      if (
        expected &&
        expected.rootRevision === root.revision &&
        expected.installFingerprint === installFingerprint
      ) {
        // A rewrite put the plan's statuses back on rows a stored refusal owns;
        // the composition it refused is still the one held.
        if (held === null || settled)
          return { ...planned, policy: expected, installs };
        await OpenAppaBatteryInstallModel.markRefused({
          organizationId,
          lastError: held,
        });
        return {
          ...planned,
          policy: expected,
          installs: await OpenAppaBatteryInstallModel.list(organizationId),
        };
      }
      const values = await this.compose({
        root,
        composed,
        installFingerprint,
        previousContent: expected?.content ?? null,
      });
      if (values.error === null) {
        // The kept rows still carry the refusal this composition lifts.
        if (settled && held !== null)
          installs = await OpenAppaBatteryInstallModel.replaceAll({
            organizationId,
            rows: planned.rows,
          });
        if (expected)
          this.logGrantGrowth({ organizationId, previous, next: planned.rows });
      } else if (!settled || held !== values.error) {
        await OpenAppaBatteryInstallModel.markRefused({
          organizationId,
          lastError: values.error,
        });
      }
      const policy = await OpenAppaEffectivePolicyModel.save({
        organizationId,
        values,
        expected,
      });
      if (policy)
        return {
          ...planned,
          policy,
          installs:
            values.error === null
              ? installs
              : await OpenAppaBatteryInstallModel.list(organizationId),
        };
      // Another composition stored its result between this attempt's read and
      // its write. Reading again at once tends to lose the same race, so wait
      // first, jittered so simultaneous losers do not line up again. The last
      // attempt waits for nothing: the caller, and the follow-up queued behind
      // it, would only sit out the delay before the refusal.
      if (attempt + 1 < RECOMPILE_ATTEMPTS)
        await sleep(recomposeBackoffMs(attempt));
    }
    // Exhaustion is contention, not a fault: the inputs are fine and the next
    // call composes them. Callers relay this as "retry later", the way every
    // other saturated OpenAPPA path does.
    throw new ApiError(
      503,
      "The effective policy is being recomposed; retry shortly",
    );
  }

  /**
   * A battery composes its own policy only while it is active: a battery held
   * back by a missing credential, an unresolved server or a naming conflict
   * composes as the empty battery, exactly as an unresolved entry does, so the
   * runtime never consults a helper the host cannot serve.
   */
  private composeInputs(params: {
    planned: PlannedComposition;
    installs: BatteryInstall[];
  }): ComposeBatteryInput[] {
    const { planned, installs } = params;
    const tokenEnv = openappaDeclarations.publishBridgeToken();
    const byName = new Map(
      planned.batteries.map((battery) => [battery.name, battery]),
    );
    return openappaDeclarations.composeInputs({
      entries: planned.resolution.entries,
      helpers: (entry) => {
        const planned = byName.get(entry.name);
        if (planned?.status !== "active") return "stub";
        if (!entry.battery || entry.battery.externals.length === 0) return null;
        const owner = helperOwner(installs, entry.name);
        return owner ? { urlBase: helperUrlBase(owner.id), tokenEnv } : "stub";
      },
    });
  }

  private async compose(params: {
    root: GuardrailsPolicy;
    composed: ComposeBatteryInput[];
    installFingerprint: string;
    previousContent: string | null;
  }): Promise<EffectivePolicyValues> {
    const { root, composed, installFingerprint, previousContent } = params;
    const native = await loadNative();
    const result = await native.composeOpenappaPolicy({
      root: root.content,
      batteries: composed,
    });
    // A refused composition carries no document. napi renders that absence as
    // `undefined`, not the `null` the generated typing spells, so normalize it
    // before deciding whether the runtime refused: an identity test against
    // `null` alone silently stores a refusal as a clean composition.
    const accepted = result.content ?? null;
    // The root alone is no longer enforceable — its include entries are the
    // host's to answer — so a refusal keeps the last composition that opened.
    const content = accepted ?? previousContent ?? root.content;
    return {
      content,
      contentHash: hash(content),
      rootRevision: root.revision,
      installFingerprint,
      error: accepted === null ? result.errors.join("\n") : null,
    };
  }

  /**
   * Resolve what the root declares into the batteries it composes and the install
   * rows that composition implies, without writing anything.
   */
  private async plan(params: {
    organizationId: string;
    root: GuardrailsPolicy;
    /** Catalogs the organization already governs; read even if no target names them. */
    governed: readonly string[];
  }): Promise<PlannedComposition> {
    const { organizationId, root, governed } = params;
    const resolution = await openappaDeclarations.resolve({
      organizationId,
      content: root.content,
    });
    const [prefixes, bindable] = await Promise.all([
      catalogToolPrefixes(organizationId, {
        targets: resolution.aliases.flatMap((alias) => alias.servers),
        catalogIds: governed,
      }),
      this.bindableKeys(organizationId),
    ]);
    const aliases = new Map(
      resolution.aliases.map((alias) => [alias.namespace, alias.servers]),
    );
    const readers = new Map<string, string[]>();
    for (const entry of resolution.entries)
      for (const variable of entry.battery?.credentials ?? [])
        readers.set(variable, [...(readers.get(variable) ?? []), entry.name]);
    // Two entries answering one name compose to nothing the runtime accepts and
    // derive one row apiece for the same battery. `validate` refuses such a
    // document; one already stored resolves to nothing rather than to whichever
    // entry happens to be read last.
    const duplicated = new Set(
      resolution.entries
        .filter(
          (entry, index) =>
            resolution.entries.findIndex(
              (other) => other.name === entry.name,
            ) !== index,
        )
        .map((entry) => entry.name),
    );
    const batteries: PlannedBattery[] = [];
    const rows = new Map<string, BatteryInstallRow>();
    for (const entry of resolution.entries) {
      const namespaces = entry.battery?.namespaces ?? [];
      const servers = namespaces
        .flatMap((namespace) => aliases.get(namespace) ?? [])
        .map((target) => ({
          target,
          catalogs: prefixes.byPrefix.get(target) ?? new Set<string>(),
        }));
      const credentials = (entry.battery?.credentials ?? []).map(
        (variable) => ({
          variable,
          key: resolution.credentials[variable] ?? null,
          readers: readers.get(variable) ?? [],
        }),
      );
      const catalogIds = [
        ...new Set(servers.flatMap(({ catalogs }) => [...catalogs])),
      ];
      const status = batteryStatus({
        resolved: entry.battery !== null && !duplicated.has(entry.name),
        credentials,
        bindable,
        servers,
        conflicting: catalogIds.some((catalogId) =>
          prefixes.conflicting.has(catalogId),
        ),
      });
      const bindings: BatteryCredentialBindings = Object.fromEntries(
        credentials
          .filter((credential) => credential.key !== null)
          .map((credential) => [credential.variable, credential.key as string]),
      );
      batteries.push({
        entry: entry.entry,
        name: entry.name,
        source: entry.source,
        packageHash: entry.packageHash,
        line: entry.line,
        status,
        helpers: entry.battery?.helpers ?? [],
        servers: servers.map(({ target, catalogs }) => ({
          target,
          catalogId: catalogs.size === 1 ? ([...catalogs][0] as string) : null,
        })),
        credentials,
      });
      for (const catalogId of catalogIds) {
        const key = `${entry.name}\u0000${catalogId}`;
        if (rows.has(key)) continue;
        rows.set(key, {
          batteryName: entry.name,
          catalogId,
          status,
          packageHash: entry.packageHash,
          lastError: null,
          credentialBindings: bindings,
        });
      }
    }
    const declared = new Set(
      resolution.entries.flatMap((entry) => entry.battery?.namespaces ?? []),
    );
    return {
      resolution,
      batteries,
      rows: [...rows.values()],
      unusedAliases: resolution.aliases.filter(
        (alias) => !declared.has(alias.namespace),
      ),
    };
  }

  /** Keys of the organization's credential definitions holding an organization value. */
  private async bindableKeys(
    organizationId: string,
  ): Promise<ReadonlySet<string>> {
    const [connected, definitions] = await Promise.all([
      RuntimeCredentialConnectionModel.listOrganizationCredentialIds(
        organizationId,
      ),
      RuntimeCredentialDefinitionModel.list(organizationId),
    ]);
    return new Set(
      definitions
        .filter(
          (definition) =>
            definition.allowOrganization && connected.includes(definition.key),
        )
        .map((definition) => definition.key),
    );
  }

  /** Bundled batteries and the newest stored package of every uploaded name. */
  private async availableBatteries(
    organizationId: string,
  ): Promise<AvailableBatteries> {
    const available: AvailableBatteries = new Map();
    for (const bundled of await openappaDeclarations.bundledBatteries())
      available.set(bundled.name, {
        source: "bundled",
        contentHash: null,
        package: bundled,
      });
    // One stored package's bytes say nothing about another's, so the newest
    // version of every name is inspected concurrently, bounded like a recompile.
    const newest =
      await OpenAppaBatteryPackageModel.listNewestPerName(organizationId);
    const inspected = await mapWithConcurrency(
      newest,
      RECOMPILE_CONCURRENCY,
      (stored) =>
        openappaDeclarations.resolveNewestStored({
          organizationId,
          name: stored.name,
          newest: stored.contentHash,
        }),
    );
    inspected.forEach((result, index) => {
      const name = newest[index]?.name;
      if (result.status === "rejected" || !result.value || !name) return;
      available.set(name, {
        source: "upload",
        contentHash: result.value.contentHash,
        package: result.value.battery,
      });
    });
    return available;
  }

  /**
   * The battery as the latest composition sees it, after the write that changed
   * it, with the derived row that write stands for when the composition kept
   * one: the audit trail records the write against that row.
   */
  private async batteryView(params: {
    organizationId: string;
    name: string;
    catalogId: string;
  }): Promise<BatteryWriteResult> {
    const { batteries, installs } = await this.recompose(params.organizationId);
    const battery = batteries.find(
      (candidate) => candidate.name === params.name,
    );
    if (!battery)
      throw new ApiError(404, `The policy does not include ${params.name}`);
    const row = installs.find(
      (install) =>
        install.batteryName === params.name &&
        install.catalogId === params.catalogId,
    );
    return { battery, installId: row?.id ?? null };
  }

  /**
   * Apply declaration edits to the latest revision and save them. A save that
   * lost the revision race re-reads and re-edits, so an edit is never computed
   * against a document that is no longer the latest.
   */
  private async editRoot(params: {
    organizationId: string;
    userId: string;
    edits: (latest: GuardrailsPolicy) => Promise<PolicyEditInput[]>;
  }): Promise<void> {
    const { organizationId, userId } = params;
    const native = await loadNative();
    for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt++) {
      const latest = await guardrailsPolicyService.get(organizationId);
      const edits = await params.edits(latest);
      if (edits.length === 0) return;
      const edited = await native.editOpenappaPolicy(latest.content, edits);
      if (edited.content === undefined || edited.content === null)
        throw new ApiError(400, edited.errors.join("\n"));
      // The editor is idempotent: a document that already says what the edits
      // ask for comes back byte for byte and needs no revision.
      if (edited.content === latest.content) return;
      try {
        await guardrailsPolicyService.update({
          organizationId,
          userId,
          content: edited.content,
          expectedRevision: latest.revision,
        });
        return;
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          error.internalCode !== GUARDRAILS_REVISION_CONFLICT
        )
          throw error;
      }
    }
    throw new ApiError(
      409,
      "This policy is being changed by someone else. Retry shortly.",
    );
  }

  private async reconcileAliases(params: {
    organizationId: string;
    catalogId: string;
    userId: string;
    renames: ReadonlyMap<string, string>;
  }): Promise<void> {
    const { organizationId, catalogId, userId, renames } = params;
    const latest = await guardrailsPolicyService.get(organizationId);
    const resolution = await openappaDeclarations.resolve({
      organizationId,
      content: latest.content,
    });
    const stale = resolution.aliases.filter((alias) =>
      alias.servers.some((target) => renames.has(target)),
    );
    if (stale.length === 0) return;
    if ((await OpenAppaGithubSyncModel.find(organizationId))?.interval) {
      logger.warn(
        {
          organizationId,
          catalogId,
          staleTargets: stale.flatMap((alias) =>
            alias.servers.filter((target) => renames.has(target)),
          ),
        },
        "OpenAPPA alias targets still spell a renamed catalog; the repository owns this policy",
      );
      return;
    }
    try {
      await this.editRoot({
        organizationId,
        userId,
        edits: async (current) => {
          const declarations = await openappaDeclarations.resolve({
            organizationId,
            content: current.content,
          });
          return declarations.aliases
            .filter((alias) =>
              alias.servers.some((target) => renames.has(target)),
            )
            .map((alias) => ({
              kind: "bindServers",
              namespace: alias.namespace,
              servers: [
                ...new Set(
                  alias.servers.map((target) => renames.get(target) ?? target),
                ),
              ],
            }));
        },
      });
    } catch (error) {
      logger.warn(
        {
          organizationId,
          catalogId,
          staleTargets: stale.flatMap((alias) =>
            alias.servers.filter((target) => renames.has(target)),
          ),
          error,
        },
        "OpenAPPA alias targets could not follow a catalog rename",
      );
    }
  }

  /**
   * A bundled battery's bytes move with the platform, not with the text, so a
   * pin bump can widen what an included battery reads with no user write. Every
   * grant the new composition holds that the previous one did not is logged, so
   * the growth is in the audit trail even though no one authored it.
   */
  private logGrantGrowth(params: {
    organizationId: string;
    previous: BatteryInstall[];
    next: BatteryInstallRow[];
  }): void {
    const grants = (
      rows: ReadonlyArray<{
        batteryName: string;
        credentialBindings: BatteryCredentialBindings;
      }>,
    ) =>
      [
        ...new Map(
          rows.flatMap((row) =>
            Object.entries(row.credentialBindings).map(
              ([variable, key]) =>
                [
                  JSON.stringify([row.batteryName, variable]),
                  { battery: row.batteryName, variable, key },
                ] as const,
            ),
          ),
        ).values(),
      ].sort((a, b) => a.battery.localeCompare(b.battery));
    const added = addedGrants(grants(params.previous), grants(params.next));
    if (added.length === 0) return;
    logger.warn(
      { organizationId: params.organizationId, grants: added },
      "OpenAPPA composition grants credentials the previous composition did not",
    );
  }

  private async requireCatalog(params: {
    organizationId: string;
    catalogId: string;
  }) {
    const catalog = await InternalMcpCatalogModel.findById(params.catalogId, {
      expandSecrets: false,
    });
    if (
      !catalog ||
      (catalog.organizationId !== null &&
        catalog.organizationId !== params.organizationId)
    )
      throw new ApiError(404, "MCP catalog entry not found");
    return catalog;
  }
}

export const openappaBatteriesService = new OpenAppaBatteriesService();

/**
 * Every tool prefix the organization's catalogs carry: which catalog carries a
 * prefix, and which catalogs a composed alias could not tell apart.
 */
export async function catalogToolPrefixes(
  organizationId: string,
  /**
   * What the reading needs to cover: the alias targets a policy declares and the
   * catalogs it already governs. Without it every visible catalog is read, which
   * only the migration step and a bare listing need.
   */
  scope?: { targets: readonly string[]; catalogIds: readonly string[] },
): Promise<CatalogPrefixes> {
  const visible =
    await InternalMcpCatalogModel.findIdsVisibleToOrganization(organizationId);
  return prefixesOf(
    await ToolModel.getToolNamesByCatalogIds(
      scope ? await scopedCatalogIds({ visible, scope }) : visible,
    ),
  );
}

/**
 * The catalogs a scoped reading covers: those carrying a tool under one of the
 * declared targets, plus the ones already governed. Whether a catalog is a
 * naming conflict depends on every tool it carries, so the catalogs are settled
 * first and their tools read afterwards.
 */
async function scopedCatalogIds(params: {
  visible: string[];
  scope: { targets: readonly string[]; catalogIds: readonly string[] };
}): Promise<string[]> {
  const { visible, scope } = params;
  const governed = scope.catalogIds.filter((catalogId) =>
    visible.includes(catalogId),
  );
  const matched = await ToolModel.getToolNamesByPrefixes({
    scopeCatalogIds: visible,
    prefixes: [...scope.targets],
    catalogIds: governed,
  });
  return [...new Set([...matched.map((tool) => tool.catalogId), ...governed])];
}

/**
 * Whether the stored rows already are what the plan derives. A refusal the
 * stored policy holds is the truth of every row while it holds, so rows
 * carrying it answer a plan they differ from only in status.
 */
function rowsSettled(params: {
  previous: BatteryInstall[];
  rows: readonly BatteryInstallRow[];
  held: string | null;
}): boolean {
  const { previous, rows, held } = params;
  if (previous.length !== rows.length) return false;
  const stored = new Map(previous.map((row) => [rowKey(row), row]));
  return rows.every((row) => {
    const seen = stored.get(rowKey(row));
    if (!seen || !seen.enabled) return false;
    if (seen.packageHash !== row.packageHash) return false;
    if (
      JSON.stringify(sortedBindings(seen.credentialBindings)) !==
      JSON.stringify(sortedBindings(row.credentialBindings))
    )
      return false;
    return held === null
      ? seen.status === row.status && seen.lastError === null
      : seen.status === "refused" && seen.lastError === held;
  });
}

function rowKey(row: { batteryName: string; catalogId: string }): string {
  return `${row.batteryName}\u0000${row.catalogId}`;
}

function sortedBindings(
  bindings: BatteryCredentialBindings,
): Array<[string, string]> {
  return Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b));
}

function prefixesOf(
  toolNames: ReadonlyArray<{ name: string; catalogId: string }>,
): CatalogPrefixes {
  const byCatalog = new Map<string, Set<string>>();
  const byPrefix = new Map<string, Set<string>>();
  const conflicting = new Set<string>();
  for (const tool of toolNames) {
    const { serverName } = parseFullToolName(tool.name);
    if (serverName === null) continue;
    // The adapter splits a spelled name at its last `__`; a namespace holding
    // one is no connection identity the runtime accepts as an alias target, so
    // it is never bound and the catalog carrying it is refused.
    if (serverName.includes("__")) {
      conflicting.add(tool.catalogId);
      continue;
    }
    byCatalog.set(
      tool.catalogId,
      (byCatalog.get(tool.catalogId) ?? new Set()).add(serverName),
    );
    byPrefix.set(
      serverName,
      (byPrefix.get(serverName) ?? new Set()).add(tool.catalogId),
    );
  }
  return { byCatalog, byPrefix, conflicting };
}

type AvailableBatteries = Map<
  string,
  {
    source: BatterySummary["source"];
    contentHash: string | null;
    package: NativeBatteryPackage;
  }
>;

type CatalogPrefixes = {
  byCatalog: Map<string, Set<string>>;
  byPrefix: Map<string, Set<string>>;
  /** Catalogs whose prefix holds `__`, which a composed alias cannot tell apart. */
  conflicting: Set<string>;
};

type PlannedBattery = PolicyBatteryView;

type PlannedComposition = {
  resolution: PolicyResolution;
  batteries: PlannedBattery[];
  rows: BatteryInstallRow[];
  unusedAliases: PolicyDeclarationsView["unusedAliases"];
};

type Recomposition = PlannedComposition & {
  policy: EffectivePolicy;
  installs: BatteryInstall[];
};

type Slot<T> = { running: Promise<T>; queued: Promise<T> | null };

/**
 * The status precedence of the design: an entry that resolves to nothing first,
 * then a variable no key can be bound to, then an ambiguous prefix, then a target
 * no catalog carries.
 */
function batteryStatus(params: {
  resolved: boolean;
  credentials: ReadonlyArray<{ variable: string; key: string | null }>;
  bindable: ReadonlySet<string>;
  servers: ReadonlyArray<{ target: string; catalogs: ReadonlySet<string> }>;
  conflicting: boolean;
}): BatteryInstallStatus {
  const { resolved, credentials, bindable, servers, conflicting } = params;
  if (!resolved) return "unavailable";
  if (
    credentials.some(
      (credential) => !credential.key || !bindable.has(credential.key),
    )
  )
    return "missing_credentials";
  if (conflicting || servers.some((server) => server.catalogs.size > 1))
    return "naming_conflict";
  if (
    servers.length === 0 ||
    servers.some((server) => server.catalogs.size === 0)
  )
    return "server_missing";
  return "active";
}

/** The row whose helpers a battery's composed externals consult: its earliest one. */
function helperOwner(
  installs: BatteryInstall[],
  name: string,
): BatteryInstall | null {
  return (
    installs
      .filter((install) => install.batteryName === name)
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      )[0] ?? null
  );
}

/** The alias edits that add `targets` to every namespace, keeping what is bound. */
function bindEdits(params: {
  resolution: PolicyResolution;
  namespaces: readonly string[];
  targets: ReadonlySet<string>;
}): PolicyEditInput[] {
  const { resolution, namespaces, targets } = params;
  if (targets.size === 0) return [];
  return namespaces.map((namespace) => ({
    kind: "bindServers",
    namespace,
    servers: [
      ...new Set([...boundTargets({ resolution, namespace }), ...targets]),
    ],
  }));
}

/**
 * The alias edits that take `targets` out of every namespace. An alias another
 * included battery declares is that battery's server list too, so emptying it
 * would silently un-govern it: such a namespace is left as it stands.
 */
function unbindEdits(params: {
  resolution: PolicyResolution;
  namespaces: readonly string[];
  targets: ReadonlySet<string>;
  /** Namespaces another included battery declares; never unbound. */
  keep?: ReadonlySet<string>;
}): PolicyEditInput[] {
  const { resolution, namespaces, targets, keep } = params;
  const edits: PolicyEditInput[] = [];
  const emptied: string[] = [];
  for (const namespace of namespaces) {
    const bound = boundTargets({ resolution, namespace });
    const remaining = bound.filter((target) => !targets.has(target));
    if (remaining.length === bound.length) continue;
    if (remaining.length === 0) {
      if (!keep?.has(namespace)) emptied.push(namespace);
    } else edits.push({ kind: "bindServers", namespace, servers: remaining });
  }
  if (emptied.length > 0)
    edits.push({ kind: "unbindServers", namespaces: emptied });
  return edits;
}

/** The namespaces the included batteries other than `name` declare. */
function otherNamespaces(
  resolution: PolicyResolution,
  name: string,
): ReadonlySet<string> {
  return new Set(
    resolution.entries
      .filter((entry) => entry.name !== name)
      .flatMap((entry) => entry.battery?.namespaces ?? []),
  );
}

function remainingTargets(params: {
  resolution: PolicyResolution;
  namespace: string;
  targets: ReadonlySet<string>;
}): string[] {
  return boundTargets(params).filter((target) => !params.targets.has(target));
}

function boundTargets(params: {
  resolution: PolicyResolution;
  namespace: string;
}): string[] {
  return (
    params.resolution.aliases.find(
      (alias) => alias.namespace === params.namespace,
    )?.servers ?? []
  );
}

/** Which tool prefix each renamed tool left behind and which one it carries now. */
function prefixRenames(
  renamedTools: ReadonlyArray<{ oldName: string; newName: string }>,
): Map<string, string> {
  const renames = new Map<string, string>();
  for (const { oldName, newName } of renamedTools) {
    const before = parseFullToolName(oldName).serverName;
    const after = parseFullToolName(newName).serverName;
    if (before !== null && after !== null && before !== after)
      renames.set(before, after);
  }
  return renames;
}

async function requireCredentialUpdate(params: {
  userId: string;
  organizationId: string;
  message: string;
}): Promise<void> {
  if (
    !(await userHasPermission(
      params.userId,
      params.organizationId,
      "credential",
      "update",
    ))
  )
    throw new ApiError(403, params.message);
}

/**
 * Runs `work` for `key` unless a run is in flight. A call during a run queues
 * exactly one follow-up, which starts after the run ends and so sees every
 * write made before the call; a caller never joins a run that began before
 * its own write.
 */
function coalesce<T>(
  slots: Map<string, Slot<T>>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const slot = slots.get(key);
  if (slot) {
    slot.queued ??= slot.running
      .catch(() => undefined)
      .then(() => coalesce(slots, key, work));
    return slot.queued;
  }
  const running = work().finally(() => {
    slots.delete(key);
  });
  slots.set(key, { running, queued: null });
  return running;
}

const loadNative = () => import("@archestra/openappa-rs");

const RECOMPILE_ATTEMPTS = 3;
const RECOMPILE_CONCURRENCY = 4;
/** One read-edit-save, plus the two retries a lost revision race is allowed. */
const EDIT_ATTEMPTS = 3;
/** Base wait after a lost store, doubled per attempt and jittered on top. */
const RECOMPILE_BACKOFF_MS = 25;

function recomposeBackoffMs(attempt: number): number {
  const delay = RECOMPILE_BACKOFF_MS * 2 ** attempt;
  return delay + Math.random() * delay;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
