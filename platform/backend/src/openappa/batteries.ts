import { createHash, randomBytes } from "node:crypto";
import type {
  ComposeBatteryInput,
  BatteryPackage as NativeBatteryPackage,
  ServerAliasInput,
} from "@archestra/openappa-rs";
import { parseFullToolName } from "@archestra/shared";
import { userHasPermission } from "@/auth";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import OpenAppaBatteryPackageModel from "@/models/openappa-battery-package";
import OpenAppaEffectivePolicyModel, {
  type EffectivePolicyValues,
} from "@/models/openappa-effective-policy";
import OrganizationModel from "@/models/organization";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import ToolModel from "@/models/tool";
import { OPENAPPA_HELPERS_PREFIX } from "@/routes/route-paths";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { ApiError, type InternalMcpCatalog } from "@/types";
import type {
  BatteryInstall,
  BatteryInstallStatus,
  BatteryInstallView,
  BatteryMatch,
  BatteryPackageFile,
  BatteryPackageSummary,
  BatterySummary,
  CreateBatteryInstall,
  EffectivePolicy,
  UpdateBatteryInstall,
} from "@/types/openappa-batteries";
import { mapWithConcurrency } from "@/utils/concurrency";
import { matchBatteries, matchesAnyRule } from "./battery-match";

/** The variable a composed policy names for the bridge bearer; its value is per process. */
const OPENAPPA_BRIDGE_TOKEN_ENV = "APPA_ARCHESTRA_BRIDGE_TOKEN";

class OpenAppaBatteriesService {
  /** Presented by the runtime on every helper consult; minted at boot, never stored. */
  readonly bridgeToken = randomBytes(32).toString("hex");
  private readonly recompiling = new Map<string, Slot<Recomposition>>();
  private readonly syncing = new Map<string, Slot<void>>();
  /** Concurrent dispatches of one organization share a single policy read. */
  private readonly reading = new Map<string, Promise<EffectivePolicy>>();
  /** The bundled list is immutable per binary; crossing napi copies every file. */
  private bundled: Promise<NativeBatteryPackage[]> | null = null;
  /** Inspected uploads by content hash: the bytes fix the result. */
  private readonly inspected = new LRUCacheManager<NativeBatteryPackage>({
    maxSize: 32,
    maxBytes: 64 * 1024 * 1024,
    sizeOf: (battery) =>
      battery.files.reduce((total, file) => total + file.text.length, 0),
    defaultTtl: 0,
  });

  /**
   * Publishes the bridge bearer where the runtime reads it, and answers the
   * variable a composition must name for it.
   *
   * Upstream contract: `Config::hosted`/`Config::hosted_composed` resolve every
   * `token_env` a hosted document names with `std::env::var` on this process,
   * and refuse the document when the variable is unset. The addon therefore
   * reads the bearer from the environment both when it composes a policy and
   * when it opens one, and every caller that is about to cross into it
   * publishes the value first instead of relying on this module having been
   * imported earlier.
   */
  publishBridgeToken(): string {
    process.env[OPENAPPA_BRIDGE_TOKEN_ENV] = this.bridgeToken;
    return OPENAPPA_BRIDGE_TOKEN_ENV;
  }

  /** Every battery this organization can install, bundled and uploaded, with its installs. */
  async listBatteries(organizationId: string): Promise<BatterySummary[]> {
    const plan = await this.plan(organizationId);
    const installsByBattery = new Map<string, BatteryInstallView[]>();
    for (const install of plan.installs) {
      const views = installsByBattery.get(install.batteryName) ?? [];
      views.push(install);
      installsByBattery.set(install.batteryName, views);
    }
    return [...plan.batteries.values()]
      .map(({ source, package: battery }) => ({
        name: battery.name,
        description: battery.description,
        source,
        namespaces: battery.namespaces,
        helpers: battery.helpers,
        credentials: battery.credentials,
        setup: battery.setup ?? null,
        installs: installsByBattery.get(battery.name) ?? [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The batteries a catalog entry stands for and the installs it already has. */
  async matchesForCatalog(params: {
    organizationId: string;
    catalogId: string;
  }): Promise<BatteryMatch[]> {
    const { organizationId, catalogId } = params;
    const catalog = await InternalMcpCatalogModel.findById(catalogId, {
      expandSecrets: false,
    });
    if (
      !catalog ||
      (catalog.organizationId !== null &&
        catalog.organizationId !== organizationId)
    )
      throw new ApiError(404, "MCP catalog entry not found");
    const plan = await this.plan(organizationId);
    return matchBatteries(catalog, new Set(plan.batteries.keys())).map(
      (match) => ({
        ...match,
        install:
          plan.installs.find(
            (install) =>
              install.catalogId === catalogId &&
              install.batteryName === match.battery,
          ) ?? null,
      }),
    );
  }

  /** The policy the runtime opens for this organization, recomposed when the root moved. */
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
   * Compose root + installed batteries and store the result. A composition the
   * runtime refuses stores the root alone with the refusal, so the runtime never
   * runs a stale document and the refusal is one-shot per root revision.
   * A caller always gets a composition that started after it called: one that
   * is already running may have read inputs older than the caller's write, so
   * later callers share a single follow-up queued behind it. A composition
   * that lost to a newer store is redone from fresh inputs.
   */
  async recompile(organizationId: string): Promise<EffectivePolicy> {
    return (await this.recompose(organizationId)).policy;
  }

  async recompileAll(): Promise<void> {
    await this.recompileOrganizations(await OrganizationModel.findAllIds());
  }

  /**
   * Called after a catalog's tools were synced: attaches the batteries the
   * catalog stands for and recomposes every organization the catalog serves.
   * Never throws; a battery problem must not fail an MCP server installation.
   */
  async onCatalogToolsChanged(catalogId: string): Promise<void> {
    if (!config.openappa.enabled) return;
    // A reinstall syncs every install of a catalog at once: overlapping syncs
    // of one catalog share a sweep, and one more follows for the writes since.
    return coalesce(this.syncing, catalogId, () => this.syncCatalog(catalogId));
  }

  private async syncCatalog(catalogId: string): Promise<void> {
    try {
      const catalog = await InternalMcpCatalogModel.findById(catalogId, {
        expandSecrets: false,
      });
      if (!catalog) return;
      const organizationIds = new Set(
        await OpenAppaBatteryInstallModel.organizationIdsForCatalog(catalogId),
      );
      // Most catalogs stand for no battery at all and skip the sweep.
      let served: string[] = [];
      if (matchesAnyRule(catalog))
        served =
          catalog.organizationId === null
            ? await OrganizationModel.findAllIds()
            : [catalog.organizationId];
      const attached = await mapWithConcurrency(
        served,
        RECOMPILE_CONCURRENCY,
        (organizationId) => this.attachMatching({ organizationId, catalog }),
      );
      attached.forEach((result, index) => {
        if (result.status === "rejected")
          logger.warn(
            { catalogId, organizationId: served[index], error: result.reason },
            "OpenAPPA battery attachment after tool sync failed",
          );
        else if (result.value) organizationIds.add(served[index] as string);
      });
      await this.recompileOrganizations([...organizationIds]);
    } catch (error) {
      logger.warn(
        { catalogId, error },
        "OpenAPPA battery attachment after tool sync failed",
      );
    }
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

  async createInstall(params: {
    userId: string;
    organizationId: string;
    install: CreateBatteryInstall;
  }): Promise<BatteryInstallView> {
    const { userId, organizationId, install } = params;
    const battery = await this.requireBattery(
      organizationId,
      install.batteryName,
    );
    const catalog = await InternalMcpCatalogModel.findById(install.catalogId, {
      expandSecrets: false,
    });
    if (
      !catalog ||
      (catalog.organizationId !== null &&
        catalog.organizationId !== organizationId)
    )
      throw new ApiError(404, "MCP catalog entry not found");
    await this.requireBindableCredentials({
      userId,
      organizationId,
      battery,
      bindings: install.credentialBindings,
    });
    if (install.enabled)
      await this.requireSoleHelperOwner({ organizationId, battery, id: null });
    const created = await OpenAppaBatteryInstallModel.createIfAbsent({
      organizationId,
      ...install,
    });
    if (!created)
      throw new ApiError(
        409,
        "This battery is already installed for that catalog entry",
      );
    return this.claimedView({
      organizationId,
      id: created.id,
      withdraw: async () => {
        await OpenAppaBatteryInstallModel.delete({
          id: created.id,
          organizationId,
        });
      },
    });
  }

  async updateInstall(params: {
    userId: string;
    organizationId: string;
    id: string;
    changes: UpdateBatteryInstall;
  }): Promise<BatteryInstallView> {
    const { userId, organizationId, id, changes } = params;
    const existing = await OpenAppaBatteryInstallModel.find({
      id,
      organizationId,
    });
    if (!existing) throw new ApiError(404, "Battery install not found");
    const battery = await this.requireBattery(
      organizationId,
      existing.batteryName,
    );
    if (changes.credentialBindings)
      await this.requireBindableCredentials({
        userId,
        organizationId,
        battery,
        bindings: changes.credentialBindings,
      });
    const claimsHelpers =
      (changes.enabled ?? existing.enabled) &&
      (changes.enabled === true || changes.credentialBindings !== undefined);
    if (claimsHelpers)
      await this.requireSoleHelperOwner({ organizationId, battery, id });
    await OpenAppaBatteryInstallModel.update({
      id,
      organizationId,
      ...changes,
    });
    if (!claimsHelpers) return this.installView(organizationId, id);
    return this.claimedView({
      organizationId,
      id,
      withdraw: async () => {
        await OpenAppaBatteryInstallModel.update({
          id,
          organizationId,
          enabled: existing.enabled,
          credentialBindings: existing.credentialBindings,
        });
      },
    });
  }

  async deleteInstall(params: {
    organizationId: string;
    id: string;
  }): Promise<void> {
    if (!(await OpenAppaBatteryInstallModel.delete(params)))
      throw new ApiError(404, "Battery install not found");
    await this.recompile(params.organizationId);
  }

  /** Validate an uploaded package natively and store it under its manifest name. */
  async uploadPackage(params: {
    userId: string;
    organizationId: string;
    name: string;
    files: BatteryPackageFile[];
  }): Promise<BatterySummary> {
    const native = await loadNative();
    const contentHash = hash(JSON.stringify(params.files));
    let inspected: NativeBatteryPackage;
    try {
      inspected = await native.inspectOpenappaBattery(params.files);
    } catch (error) {
      throw new ApiError(
        400,
        error instanceof Error ? error.message : String(error),
      );
    }
    this.inspected.set(contentHash, inspected);
    if (inspected.name !== params.name)
      throw new ApiError(
        400,
        `The package manifest names the battery ${inspected.name}, not ${params.name}`,
      );
    // Helper code runs with whatever credentials get bound to it later, so
    // supplying it takes the permission binding a credential takes.
    if (
      (inspected.credentials.length > 0 || inspected.externals.length > 0) &&
      !(await userHasPermission(
        params.userId,
        params.organizationId,
        "credential",
        "update",
      ))
    )
      throw new ApiError(
        403,
        "Credential update permission is required to upload a battery with helper scripts",
      );
    await OpenAppaBatteryPackageModel.upsert({
      organizationId: params.organizationId,
      name: inspected.name,
      description: inspected.description,
      contentHash,
      files: params.files,
    });
    await this.recompile(params.organizationId);
    const summary = (await this.listBatteries(params.organizationId)).find(
      (battery) => battery.name === inspected.name,
    );
    if (!summary) throw new ApiError(500, "The uploaded battery is not listed");
    return summary;
  }

  async deletePackage(params: {
    organizationId: string;
    name: string;
  }): Promise<void> {
    if (
      await OpenAppaBatteryInstallModel.existsForBattery({
        ...params,
        batteryName: params.name,
      })
    )
      throw new ApiError(
        409,
        "Uninstall this battery before deleting its package",
      );
    if (!(await OpenAppaBatteryPackageModel.delete(params)))
      throw new ApiError(404, "Battery package not found");
    await this.recompile(params.organizationId);
  }

  /** The package an organization's battery of this name resolves to, uploaded over bundled. */
  async resolveBattery(
    organizationId: string,
    name: string,
  ): Promise<NativeBatteryPackage | null> {
    const uploaded = await OpenAppaBatteryPackageModel.findSummary({
      organizationId,
      name,
    });
    const inspected = uploaded ? await this.inspect(uploaded) : null;
    return (
      inspected ??
      (await this.bundledBatteries()).find(
        (battery) => battery.name === name,
      ) ??
      null
    );
  }

  /** Attach every battery the catalog stands for; true when a new install was created. */
  private async attachMatching(params: {
    organizationId: string;
    catalog: InternalMcpCatalog;
  }): Promise<boolean> {
    const { organizationId, catalog } = params;
    const available = new Set(
      (await this.availableBatteries(organizationId)).keys(),
    );
    let created = false;
    for (const { battery, evidence } of matchBatteries(catalog, available)) {
      // Concurrent syncs of one catalog race here; the unique index decides.
      // A name alone is a suggestion: the install waits disabled for review.
      // One battery's failure is logged so the ones already attached compose.
      try {
        const attached = await OpenAppaBatteryInstallModel.createIfAbsent({
          organizationId,
          batteryName: battery,
          catalogId: catalog.id,
          enabled: evidence !== "name",
          credentialBindings: {},
        });
        if (!attached) continue;
        created = true;
        logger.info(
          {
            organizationId,
            catalogId: catalog.id,
            batteryName: battery,
            evidence,
            installId: attached.id,
            enabled: attached.enabled,
          },
          "OpenAPPA battery attached to a matching MCP catalog entry",
        );
      } catch (error) {
        logger.warn(
          {
            organizationId,
            catalogId: catalog.id,
            batteryName: battery,
            error,
          },
          "OpenAPPA battery could not be attached to a matching MCP catalog entry",
        );
      }
    }
    return created;
  }

  private async readEffectivePolicy(
    organizationId: string,
  ): Promise<EffectivePolicy> {
    const root = await guardrailsPolicyService.get(organizationId);
    const effective = await OpenAppaEffectivePolicyModel.find(organizationId);
    if (effective && effective.rootRevision === root.revision) return effective;
    return this.recompile(organizationId);
  }

  /** `recompile`, also yielding the install views the stored composition was planned from. */
  private async recompose(organizationId: string): Promise<Recomposition> {
    return coalesce(this.recompiling, organizationId, () =>
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

  private async recomposeNow(organizationId: string): Promise<Recomposition> {
    for (let attempt = 0; attempt < RECOMPILE_ATTEMPTS; attempt++) {
      const expected = await OpenAppaEffectivePolicyModel.find(organizationId);
      const root = await guardrailsPolicyService.get(organizationId);
      const plan = await this.plan(organizationId);
      const installFingerprint = hash(
        JSON.stringify({
          serverAliases: plan.serverAliases,
          batteries: plan.composed,
        }),
      );
      // Same inputs give the same bytes, so the stored row already is the answer.
      if (
        expected &&
        expected.rootRevision === root.revision &&
        expected.installFingerprint === installFingerprint
      )
        return { policy: expected, installs: plan.installs };
      const policy = await OpenAppaEffectivePolicyModel.save({
        organizationId,
        values: await this.compose({ root, plan, installFingerprint }),
        expected,
      });
      if (policy) return { policy, installs: plan.installs };
      // Another composition stored its result between this attempt's read and
      // its write. Reading again at once tends to lose the same race, so wait
      // first, jittered so simultaneous losers do not line up again.
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

  private async compose(params: {
    root: { content: string; revision: number };
    plan: CompositionPlan;
    installFingerprint: string;
  }): Promise<EffectivePolicyValues> {
    const { root, plan, installFingerprint } = params;
    const native = await loadNative();
    const composed = await native.composeOpenappaPolicy({
      root: root.content,
      serverAliases: plan.serverAliases,
      batteries: plan.composed,
    });
    const content = composed.content ?? root.content;
    return {
      content,
      contentHash: hash(content),
      rootRevision: root.revision,
      installFingerprint,
      error: composed.content === null ? composed.errors.join("\n") : null,
    };
  }

  /**
   * Resolve what would be composed for an organization: which batteries exist,
   * which installs are active, and the alias and battery inputs for the runtime.
   */
  private async plan(organizationId: string): Promise<CompositionPlan> {
    const [batteries, installs, connected, definitions] = await Promise.all([
      this.availableBatteries(organizationId),
      OpenAppaBatteryInstallModel.list(organizationId),
      RuntimeCredentialConnectionModel.listOrganizationCredentialIds(
        organizationId,
      ),
      RuntimeCredentialDefinitionModel.list(organizationId),
    ]);
    const catalogIds = [
      ...new Set(installs.map((install) => install.catalogId)),
    ];
    const toolNames = await ToolModel.getToolNamesByCatalogIds(catalogIds);
    const prefixesByCatalog = new Map<string, Set<string>>();
    const conflictingCatalogs = new Set<string>();
    for (const tool of toolNames) {
      const { serverName } = parseFullToolName(tool.name);
      if (serverName === null) continue;
      // The adapter splits a spelled name at its last `__`; a namespace holding
      // one would make the composed aliases ambiguous, so the catalog is refused.
      if (serverName.includes("__")) conflictingCatalogs.add(tool.catalogId);
      const prefixes =
        prefixesByCatalog.get(tool.catalogId) ?? new Set<string>();
      prefixes.add(serverName);
      prefixesByCatalog.set(tool.catalogId, prefixes);
    }
    const bindable = new Set(
      definitions
        .filter(
          (definition) =>
            definition.allowOrganization && connected.includes(definition.key),
        )
        .map((definition) => definition.key),
    );
    const views: BatteryInstallView[] = installs.map((install) => ({
      ...install,
      status: installStatus({
        install,
        battery: batteries.get(install.batteryName)?.package ?? null,
        conflicting: conflictingCatalogs.has(install.catalogId),
        bindable,
      }),
    }));
    // Helper consults name one install per battery: the earliest active one
    // owns them and any later one is superseded.
    const helperOwners = new Set<string>();
    for (const view of views) {
      if (view.status !== "active") continue;
      const battery = batteries.get(view.batteryName)?.package;
      if (!battery || battery.externals.length === 0) continue;
      if (helperOwners.has(battery.name)) view.status = "superseded";
      else helperOwners.add(battery.name);
    }
    // Batteries may share a namespace; its alias then targets all their catalogs.
    const targetsByAlias = new Map<string, Set<string>>();
    const composed: ComposeBatteryInput[] = [];
    for (const [name, { package: battery }] of [...batteries].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const active = views.filter(
        (view) => view.batteryName === name && view.status === "active",
      );
      if (active.length === 0) continue;
      for (const namespace of battery.namespaces) {
        const targets = targetsByAlias.get(namespace) ?? new Set<string>();
        for (const view of active)
          for (const prefix of prefixesByCatalog.get(view.catalogId) ?? [])
            targets.add(prefix);
        targetsByAlias.set(namespace, targets);
      }
      const owner = battery.externals.length > 0 ? active[0] : null;
      composed.push({
        name,
        policy: battery.policy,
        helpers: owner
          ? {
              urlBase: `http://127.0.0.1:${config.api.port}${OPENAPPA_HELPERS_PREFIX}/${owner.id}`,
              // The value must already be in the environment the addon reads;
              // naming it and publishing it are the same step.
              tokenEnv: this.publishBridgeToken(),
            }
          : undefined,
      });
    }
    const serverAliases: ServerAliasInput[] = [...targetsByAlias]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([alias, targets]) => ({ alias, targets: [...targets].sort() }));
    return { batteries, installs: views, serverAliases, composed };
  }

  private async availableBatteries(
    organizationId: string,
  ): Promise<AvailableBatteries> {
    const batteries: AvailableBatteries = new Map();
    for (const bundled of await this.bundledBatteries())
      batteries.set(bundled.name, { source: "bundled", package: bundled });
    // Each cache miss reads a package's files and validates them natively;
    // independent packages overlap instead of queueing behind one another.
    const inspections = await mapWithConcurrency(
      await OpenAppaBatteryPackageModel.listSummaries(organizationId),
      RECOMPILE_CONCURRENCY,
      (uploaded) => this.inspect(uploaded),
    );
    for (const inspection of inspections) {
      if (inspection.status === "rejected") throw inspection.reason;
      const inspected = inspection.value;
      if (inspected)
        batteries.set(inspected.name, {
          source: "organization",
          package: inspected,
        });
    }
    return batteries;
  }

  private async bundledBatteries(): Promise<NativeBatteryPackage[]> {
    const native = await loadNative();
    this.bundled ??= native.listBundledOpenappaBatteries().catch((error) => {
      this.bundled = null;
      throw error;
    });
    return this.bundled;
  }

  /**
   * The inspected form of a stored package, from the cache or from its files.
   * A package that no longer validates is logged and treated as absent.
   */
  private async inspect(
    uploaded: BatteryPackageSummary,
  ): Promise<NativeBatteryPackage | null> {
    const cached = this.inspected.get(uploaded.contentHash);
    if (cached) return cached;
    const stored = await OpenAppaBatteryPackageModel.find(uploaded);
    if (!stored) return null;
    const native = await loadNative();
    try {
      const inspected = await native.inspectOpenappaBattery(stored.files);
      this.inspected.set(stored.contentHash, inspected);
      return inspected;
    } catch (error) {
      logger.warn(
        {
          organizationId: uploaded.organizationId,
          battery: uploaded.name,
          error,
        },
        "Stored OpenAPPA battery package no longer validates; ignoring it",
      );
      return null;
    }
  }

  private async requireBattery(
    organizationId: string,
    name: string,
  ): Promise<NativeBatteryPackage> {
    const battery = await this.resolveBattery(organizationId, name);
    if (!battery) throw new ApiError(404, `Unknown battery ${name}`);
    return battery;
  }

  /**
   * A battery with helper scripts consults one install, so a second one may not
   * become active while another is. An install that is enabled but not active
   * (auto-attached, credentials unbound) holds nothing and blocks nothing.
   */
  private async requireSoleHelperOwner(params: {
    organizationId: string;
    battery: NativeBatteryPackage;
    /** The install being changed, exempt from the check. */
    id: string | null;
  }): Promise<void> {
    const { organizationId, battery, id } = params;
    if (battery.externals.length === 0) return;
    const active = (await this.plan(organizationId)).installs.some(
      (other) =>
        other.batteryName === battery.name &&
        other.status === "active" &&
        other.id !== id,
    );
    if (active)
      throw new ApiError(
        409,
        "A battery with helper scripts can be active for one catalog entry at a time",
      );
  }

  /**
   * Binding hands the credential's organization value to the battery's helper,
   * so binding takes the permission that sets an organization credential's
   * value, not only the one that manages the organization.
   */
  private async requireBindableCredentials(params: {
    userId: string;
    organizationId: string;
    battery: NativeBatteryPackage;
    bindings: Record<string, string>;
  }): Promise<void> {
    const { userId, organizationId, battery, bindings } = params;
    const entries = Object.entries(bindings);
    if (
      entries.length > 0 &&
      !(await userHasPermission(userId, organizationId, "credential", "update"))
    )
      throw new ApiError(
        403,
        "Credential update permission is required to bind runtime credentials",
      );
    for (const [credential, key] of entries) {
      if (!battery.credentials.includes(credential))
        throw new ApiError(
          400,
          `The battery declares no credential ${credential}`,
        );
      const definition = await RuntimeCredentialDefinitionModel.find({
        organizationId,
        key,
      });
      if (!definition)
        throw new ApiError(400, `Unknown runtime credential ${key}`);
      if (!definition.allowOrganization)
        throw new ApiError(
          400,
          `Runtime credential ${key} has no organization-level value`,
        );
    }
  }

  /** Recompose after a write and answer with the install as the stored composition saw it. */
  /**
   * The view of an install that claimed a battery's helpers. Two claims at
   * once both pass the sole-owner check; the composition then names one owner,
   * and the install it supersedes is withdrawn and its caller told to retry.
   */
  private async claimedView(params: {
    organizationId: string;
    id: string;
    withdraw: () => Promise<void>;
  }): Promise<BatteryInstallView> {
    const { organizationId, id, withdraw } = params;
    const view = await this.installView(organizationId, id);
    if (view.status !== "superseded") return view;
    await withdraw();
    await this.recompile(organizationId);
    throw new ApiError(
      409,
      "Another install of this battery became active at the same time",
    );
  }

  private async installView(
    organizationId: string,
    id: string,
  ): Promise<BatteryInstallView> {
    const { installs } = await this.recompose(organizationId);
    const view = installs.find((install) => install.id === id);
    if (!view) throw new ApiError(404, "Battery install not found");
    return view;
  }
}

export const openappaBatteriesService = new OpenAppaBatteriesService();

type AvailableBatteries = Map<
  string,
  { source: BatterySummary["source"]; package: NativeBatteryPackage }
>;

type CompositionPlan = {
  batteries: AvailableBatteries;
  installs: BatteryInstallView[];
  serverAliases: ServerAliasInput[];
  composed: ComposeBatteryInput[];
};

type Recomposition = {
  policy: EffectivePolicy;
  installs: BatteryInstallView[];
};

type Slot<T> = { running: Promise<T>; queued: Promise<T> | null };

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
/** Base wait after a lost store, doubled per attempt and jittered on top. */
const RECOMPILE_BACKOFF_MS = 25;

function recomposeBackoffMs(attempt: number): number {
  const delay = RECOMPILE_BACKOFF_MS * 2 ** attempt;
  return delay + Math.random() * delay;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An install's status on its own; ownership among active installs is settled by the plan. */
function installStatus(params: {
  install: BatteryInstall;
  battery: NativeBatteryPackage | null;
  conflicting: boolean;
  /** Keys of the organization's credential definitions holding an organization-level value. */
  bindable: ReadonlySet<string>;
}): Exclude<BatteryInstallStatus, "superseded"> {
  const { install, battery, conflicting, bindable } = params;
  if (!battery) return "unavailable";
  if (!install.enabled) return "disabled";
  if (conflicting) return "naming_conflict";
  for (const credential of battery.credentials) {
    const key = install.credentialBindings[credential];
    if (!key || !bindable.has(key)) return "missing_credentials";
  }
  return "active";
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
