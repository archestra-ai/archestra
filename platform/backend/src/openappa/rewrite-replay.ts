import { createHash, createHmac, randomUUID } from "node:crypto";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import OpenAppaRewriteModel from "@/models/openappa-rewrite";
import type { EncryptedChatAuditDisposition } from "@/routes/proxy/utils/encrypted-chat-session";
import { ApiError } from "@/types";
import { OPENAPPA_REWRITE_MAX_PAIR_BYTES } from "@/types/openappa-rewrite";
import {
  decryptBytesWithKey,
  deriveKeyFromSecret,
  encryptBytesWithKey,
} from "@/utils/crypto";
import { stripChildTrajectoryReceipts } from "./child-trajectory-receipt";
import { restoreVerifiedDelegationEcho } from "./delegation";
import {
  captureRewriteCalls,
  captureRewriteEcho,
  hasRewriteCarrier,
  isQuotedHistory,
  type RewriteBytes,
  RewriteEchoError,
  type RewriteWireFamily,
  recordedDelegationText,
  recordRewriteCalls,
  recordRewriteText,
  replayCallKey,
  restoreRewriteCalls,
  restoreRewriteText,
  rewriteCallKeys,
  rewriteEchoKeys,
  rewriteTextKey,
  rewriteTextSites,
} from "./rewrite-echo";
import {
  captureRewriteRequest,
  type RewriteHeads,
  RewriteProjectionError,
  rewriteOrigin,
  rewritePolicyEpoch,
} from "./rewrite-projection";
import type { OpenAppaSession } from "./service";
import { stripSessionReceipts } from "./session-token";

export type ControlOutcomeClass =
  | "pending"
  | "denied"
  | "canceled"
  | "applied"
  | "refused";

type AppaReplayCapture = {
  family: RewriteWireFamily;
  hasDeclarations: boolean;
  requestDigest: string;
  projection: ReturnType<typeof captureRewriteRequest>;
  echo: ReturnType<typeof captureRewriteEcho>;
  body: unknown;
};

export function captureAppaReplayRequest(params: {
  family: RewriteWireFamily;
  body: unknown;
}): AppaReplayCapture {
  const tools =
    params.body && typeof params.body === "object"
      ? (params.body as Record<string, unknown>).tools
      : undefined;
  return {
    family: params.family,
    hasDeclarations: Array.isArray(tools) ? tools.length > 0 : Boolean(tools),
    requestDigest: createHash("sha256")
      .update(JSON.stringify(params.body))
      .digest("hex"),
    body: params.body,
    echo: captureRewriteEcho(params),
    projection: captureRewriteRequest(params.body, params.family),
  };
}

/** Per-request facade. The database, not this object or the LRU, owns replay. */
export class AppaRewriteReplay {
  private readonly recordsByOwner = new Map<
    string,
    Map<string, RewriteBytes>
  >();
  private readonly encryptionKey: Buffer;
  private readonly indexKey: Buffer;
  private inheritedScopes: ReplayScope[] | undefined;
  private readonly policyOutputs = new Map<string, unknown>();

  private constructor(
    private readonly input: {
      session: OpenAppaSession;
      capture: AppaReplayCapture;
      scope: ReplayScope;
      encryptedChat: EncryptedChatAuditDisposition;
      wire: string;
    },
  ) {
    if (input.encryptedChat.kind === "redact") throw replayUnavailable();
    if (input.encryptedChat.kind === "encrypt") {
      this.encryptionKey = deriveKeyFromSecret(
        input.encryptedChat.audit.dek.toString("base64"),
        "archestra-appa-replay-encrypted-chat-v1",
      );
    } else {
      const secret = config.secretsManager.encryptionSecret;
      if (!secret)
        throw new ApiError(
          503,
          "OpenAPPA durable replay requires a configured secrets encryption key",
        );
      this.encryptionKey = deriveKeyFromSecret(
        secret,
        "archestra-appa-replay-content-v1",
      );
    }
    this.indexKey = createHmac("sha256", this.encryptionKey)
      .update("archestra-appa-replay-index-v1")
      .digest();
  }

  static async open(params: {
    session: OpenAppaSession;
    capture: AppaReplayCapture;
    encryptedChat: EncryptedChatAuditDisposition;
    compaction?: boolean;
  }): Promise<AppaRewriteReplay> {
    const scope = await OpenAppaRewriteModel.open({
      organizationId: params.session.organization_id,
      sessionId: params.session.session_id,
      protocolVersion: 1,
      ...config.openappa.rewrite,
    });
    return new AppaRewriteReplay({
      ...params,
      scope,
      wire: `${params.capture.family}${params.compaction ? ":compaction" : ""}`,
    });
  }

  get family(): RewriteWireFamily {
    return this.input.capture.family;
  }

  /**
   * Reserve receipt identity and its full admitted ciphertext ceiling before
   * consuming a ruling. This is not an atomic transaction with native grants:
   * runtime IO/crash or an unexpectedly oversized result still fails explicitly.
   */
  static async reserveControlOutcome(params: {
    session: OpenAppaSession;
    toolCallId: string;
    spenderId: string;
    requestIdentity: string;
    encryptedChat?: EncryptedChatAuditDisposition;
  }): Promise<{
    complete: (result: {
      outcome: ControlOutcomeClass;
      bytes: string;
    }) => Promise<void>;
  }> {
    const encryptedChat = params.encryptedChat ?? { kind: "none" };
    if (
      !bindableControlCallId(params.toolCallId) ||
      !bindableControlCallId(params.spenderId) ||
      !/^[0-9a-f]{64}$/.test(params.requestIdentity) ||
      encryptedChat.kind === "redact" ||
      (encryptedChat.kind === "encrypt" &&
        (!encryptedChat.audit.dek || encryptedChat.audit.dek.length === 0))
    )
      throw replayUnavailable();
    await OpenAppaRewriteModel.ancestorSessionIds({
      organizationId: params.session.organization_id,
      sessionId: params.session.session_id,
      callerId: params.session.caller_id,
    });
    const scope = await OpenAppaRewriteModel.open({
      organizationId: params.session.organization_id,
      sessionId: params.session.session_id,
      protocolVersion: 1,
      ...config.openappa.rewrite,
    });
    const replay = AppaRewriteReplay.controlReplay(
      params.session,
      scope,
      encryptedChat,
    );
    const reservationId = randomUUID();
    const key = controlReceiptKey(params.toolCallId);
    const fragmentKey = replay.physicalKey(key);
    const reservedPair = {
      fragmentKey,
      original: replay.encrypt(
        Buffer.from(
          JSON.stringify({
            version: 1,
            callerId: params.session.caller_id ?? null,
            spenderId: params.spenderId,
            requestIdentity: params.requestIdentity,
            toolCallId: params.toolCallId,
            reservationId,
          }),
        ),
        scope,
        fragmentKey,
        "original",
      ),
      rewritten: replay.encrypt(
        Buffer.from("reserved"),
        scope,
        fragmentKey,
        "rewritten",
      ),
    };
    const outcomeHeaderBytes = replay.encrypt(
      Buffer.alloc(0),
      scope,
      fragmentKey,
      "rewritten",
    ).length;
    const outcomeBytes = Math.max(
      ...CONTROL_OUTCOME_CLASSES.map((value) => Buffer.byteLength(value)),
    );
    const reservation = await OpenAppaRewriteModel.reservePair({
      scope,
      pair: reservedPair,
      reservationId,
      maxBytes:
        OPENAPPA_REWRITE_MAX_PAIR_BYTES + outcomeHeaderBytes + outcomeBytes,
    });
    let final:
      | { outcome: ControlOutcomeClass; bytes: string; pair: StoredPair }
      | undefined;
    return {
      complete: async (result) => {
        if (
          !CONTROL_OUTCOME_CLASSES.includes(result.outcome) ||
          result.bytes.length === 0
        )
          throw replayUnavailable();
        if (
          final &&
          (final.outcome !== result.outcome || final.bytes !== result.bytes)
        )
          throw replayUnavailable();
        if (!final) {
          final = {
            ...result,
            pair: {
              fragmentKey,
              original: replay.encrypt(
                Buffer.from(result.bytes, "utf8"),
                scope,
                fragmentKey,
                "original",
              ),
              rewritten: replay.encrypt(
                Buffer.from(result.outcome, "utf8"),
                scope,
                fragmentKey,
                "rewritten",
              ),
            },
          };
        }
        await OpenAppaRewriteModel.completeReservation({
          reservation,
          reservedPair,
          pair: final.pair,
        });
        replay.cacheRows(scope, [final.pair]);
      },
    };
  }

  /**
   * Persists a gateway-produced control result before it is returned.
   * The pair is encrypted under the rewrite group's owner, epoch, and
   * session. An expired group is not renewed. A missing native session
   * is not created.
   */
  static async storeControlOutcome(params: {
    session: OpenAppaSession;
    toolCallId: string;
    outcome: ControlOutcomeClass;
    bytes: string;
    encryptedChat?: EncryptedChatAuditDisposition;
  }): Promise<void> {
    const encryptedChat = params.encryptedChat ?? { kind: "none" };
    if (
      encryptedChat.kind === "redact" ||
      (encryptedChat.kind === "encrypt" &&
        (!encryptedChat.audit.dek || encryptedChat.audit.dek.length === 0))
    ) {
      throw new ApiError(409, "OpenAPPA cannot retain this control result");
    }
    if (
      !bindableControlCallId(params.toolCallId) ||
      params.bytes.length === 0
    ) {
      throw new ApiError(409, "OpenAPPA cannot retain this control result");
    }
    if (!CONTROL_OUTCOME_CLASSES.includes(params.outcome)) {
      throw new ApiError(409, "OpenAPPA cannot retain this control result");
    }
    await OpenAppaRewriteModel.ancestorSessionIds({
      organizationId: params.session.organization_id,
      sessionId: params.session.session_id,
      callerId: params.session.caller_id,
    });
    const scope = await OpenAppaRewriteModel.open({
      organizationId: params.session.organization_id,
      sessionId: params.session.session_id,
      protocolVersion: 1,
      ...config.openappa.rewrite,
    });
    const replay = AppaRewriteReplay.controlReplay(
      params.session,
      scope,
      encryptedChat,
    );
    await replay.persist([
      {
        key: controlReceiptKey(params.toolCallId),
        original: Buffer.from(params.bytes, "utf8"),
        rewritten: Buffer.from(params.outcome, "utf8"),
      },
    ]);
  }

  /**
   * One liveness check and one batch read for every control echo in the
   * request. A passed replay is reused. Missing, expired, and foreign
   * scopes return no bytes; they are not reconstructed.
   */
  static async readControlReceipts(params: {
    session: OpenAppaSession;
    toolCallIds: readonly string[];
    replay?: AppaRewriteReplay;
    encryptedChat?: EncryptedChatAuditDisposition;
  }): Promise<Map<string, ControlReceipt>> {
    const ids = uniqueControlIds(params.toolCallIds);
    if (ids.length === 0) return new Map();
    if (params.replay) {
      if (!(await params.replay.mayServeControlRequest(params.session))) {
        return new Map();
      }
      return params.replay.readControlReceipts(ids);
    }
    let scopes: ReplayScope[];
    try {
      scopes = (
        await OpenAppaRewriteModel.loadLineageBatch({
          organizationId: params.session.organization_id,
          sessionId: params.session.session_id,
          callerId: params.session.caller_id,
          keys: [],
        })
      ).map(({ scope }) => scope);
    } catch (error) {
      if (!unavailableReceipt(error)) throw error;
      scopes = await readableControlScopes(params.session);
    }
    if (scopes.length === 0) return new Map();
    try {
      return await AppaRewriteReplay.controlReplay(
        params.session,
        scopes[0],
        params.encryptedChat ?? { kind: "none" },
      ).readControlReceipts(ids, scopes);
    } catch (error) {
      if (unavailableReceipt(error)) return new Map();
      throw error;
    }
  }

  async readControlReceipts(
    toolCallIds: readonly string[],
    scopes?: readonly ReplayScope[],
  ): Promise<Map<string, ControlReceipt>> {
    const ids = uniqueControlIds(toolCallIds);
    if (ids.length === 0) return new Map();
    const verified: ReplayScope[] = [];
    const keys = ids.map(controlReceiptKey);
    const logicalKeys = new Map(
      keys.map((key) => [this.physicalKey(key), key]),
    );
    let batched = false;
    try {
      const owners = await OpenAppaRewriteModel.loadLineageBatch({
        organizationId: this.input.session.organization_id,
        sessionId: this.input.session.session_id,
        callerId: this.input.session.caller_id,
        keys: [...logicalKeys.keys()],
      });
      for (const { scope, pairs } of owners) {
        if (
          scopes &&
          !scopes.some((allowed) => this.sameIdentity(allowed, scope))
        )
          continue;
        this.dropControlCache(scope, logicalKeys);
        const bucket = this.bucket(scope);
        for (const pair of pairs) {
          const key = logicalKeys.get(pair.fragmentKey);
          if (!key) throw replayUnavailable();
          bucket.set(key, this.decodePair(key, pair, scope));
        }
        verified.push(scope);
      }
      batched = true;
    } catch (error) {
      if (
        !unavailableReceipt(error) &&
        !(error instanceof ApiError && error.statusCode === 400)
      )
        throw error;
    }
    if (!batched) {
      verified.length = 0;
      const readable = scopes ?? (await this.liveControlScopes());
      for (const scope of readable) {
        if (await this.loadVerifiedControlScope(keys, scope))
          verified.push(scope);
      }
    }
    const found = new Map<string, ControlReceipt>();
    for (const id of ids) {
      const key = controlReceiptKey(id);
      const pairs = verified
        .map((scope) => this.bucket(scope).get(key))
        .filter((pair): pair is RewriteBytes => pair !== undefined);
      if (
        pairs.length === 0 ||
        !pairs.every((pair) => samePair(pair, pairs[0]))
      ) {
        continue;
      }
      const outcome = pairs[0].rewritten.toString("utf8");
      if (!isControlOutcomeClass(outcome)) continue;
      found.set(id, {
        outcome,
        bytes: pairs[0].original.toString("utf8"),
      });
    }
    return found;
  }

  async mayServeControlRequest(request: OpenAppaSession): Promise<boolean> {
    const bound = this.input.session;
    if (sameControlBinding(bound, request)) return true;
    if (
      bound.organization_id !== request.organization_id ||
      (bound.caller_id ?? "") !== (request.caller_id ?? "")
    ) {
      return false;
    }
    const ancestors = await verifiedControlAncestorIds(request);
    return ancestors?.includes(bound.session_id) ?? false;
  }

  private async liveControlScopes(): Promise<ReplayScope[]> {
    return readableControlScopes(this.input.session);
  }

  addPolicyOutputs(updates: ReadonlyMap<string, unknown>): void {
    for (const [id, content] of updates) this.policyOutputs.set(id, content);
  }

  /** Records APPA-owned non-prompt fields without pinning another plugin's edits. */
  async rewriteEnvelope(params: {
    request: unknown;
    transform: () => Promise<void>;
  }): Promise<void> {
    try {
      await this.ensureLive();
      const before = envelopeFields(params.request);
      await params.transform();
      const after = envelopeFields(params.request);
      for (const field of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ])) {
        if (
          CACHE_ENVELOPE_FIELDS.has(field) ||
          [
            "metadata",
            "client_metadata",
            "tool_choice",
            "parallel_tool_calls",
          ].includes(field)
        ) {
          continue;
        }
        if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
          throw replayUnavailable();
        }
      }
      const transportBefore = envelopeBytes(before, [
        "metadata",
        "client_metadata",
      ]);
      const transportAfter = envelopeBytes(after, [
        "metadata",
        "client_metadata",
      ]);
      const pending: RewriteBytes[] = [];
      if (!transportBefore.equals(transportAfter)) {
        const key = `${this.family}:carrier-envelope:v1:${createHash("sha256").update(transportBefore).digest("hex")}`;
        await this.load([key]);
        const pair = {
          key,
          original: transportBefore,
          rewritten: transportAfter,
        };
        const existing = this.ownRecords().get(key);
        if (existing && !samePair(existing, pair)) throw replayUnavailable();
        if (!existing) pending.push(pair);
      }
      const controlsBefore = envelopeBytes(before, [
        "tool_choice",
        "parallel_tool_calls",
      ]);
      const controlsAfter = envelopeBytes(after, [
        "tool_choice",
        "parallel_tool_calls",
      ]);
      if (!controlsBefore.equals(controlsAfter)) {
        // These fields are live policy decisions, not cached transport hints.
        const policyKey = `${this.family}:policy-envelope:v1:${createHash("sha256").update(controlsBefore).update(controlsAfter).digest("hex")}`;
        await this.load([policyKey]);
        pending.push({
          key: policyKey,
          original: controlsBefore,
          rewritten: controlsAfter,
        });
      }
      await this.persist(pending);
    } catch (error) {
      throw replayUnavailable(error);
    }
  }

  /** Called after lineage admission, before the provider consumes text. */
  async restoreTextEchoes(
    params: { delegationCallIds?: readonly string[] } = {},
  ): Promise<void> {
    try {
      await this.ensureLive();
      const sites = this.input.capture.echo.texts.filter(
        (site) => !site.toolResult && needsTextInverse(site.value),
      );
      if (sites.length === 0) return;
      const nested = sites.flatMap((site) => nestedRewriteTexts(site.value));
      await this.loadWithLineage([
        ...sites.map((site) => rewriteTextKey(site.value)),
        ...nested.map((text) => rewriteTextKey(text)),
      ]);
      const annotationKeys = (params.delegationCallIds ?? []).map((id) =>
        replayCallKey(this.input.capture.family, id),
      );
      await this.loadWithLineage(annotationKeys);
      const texts = this.textRecords();
      const annotations = annotationKeys.flatMap((key) =>
        this.pairsForKey(key).flatMap((pair) => recordedDelegationText(pair)),
      );
      const annotationIndex = indexDelegationAnnotations(annotations);
      const spawnCallIds = new Set(params.delegationCallIds ?? []);
      const holders = new Map<object, ReplayTextSite[]>();
      const origins = new Map<unknown, ReplayTextSite[]>();
      const values = new Map<string, Map<unknown, Set<ReplayTextSite>>>();
      for (const site of rewriteTextSites(this.input.capture.body)) {
        const owned = holders.get(site.holder) ?? [];
        owned.push(site);
        holders.set(site.holder, owned);
        const stamp = (site.holder as Record<symbol, unknown>)[rewriteOrigin];
        if (
          stamp !== undefined &&
          !(typeof stamp === "number" && Number.isNaN(stamp))
        ) {
          const stamped = origins.get(stamp) ?? [];
          stamped.push(site);
          origins.set(stamp, stamped);
        }
        const sameField = values.get(site.field) ?? new Map();
        const sameValue = sameField.get(site.holder[site.field]) ?? new Set();
        sameValue.add(site);
        sameField.set(site.holder[site.field], sameValue);
        values.set(site.field, sameField);
      }
      for (const site of sites) {
        const restored = restoreRewriteText({
          text: site.value,
          recorded: texts,
        });
        if (restored !== undefined) {
          this.restoreTextHolder({
            source: site,
            value: deliveredText(restored),
            holders,
            origins,
            values,
          });
          continue;
        }
        let text = site.value;
        for (const recorded of nestedRewriteTexts(text)) {
          const restored = restoreRewriteText({
            text: recorded,
            recorded: texts,
          });
          if (restored !== undefined)
            text = text.replaceAll(recorded, restored);
        }
        text = restoreDelegationAnnotations({ text, index: annotationIndex });
        if (this.input.session.caller_id) {
          text = restoreVerifiedDelegationEcho({
            text,
            organizationId: this.input.session.organization_id,
            callerId: this.input.session.caller_id,
            spawnerNativeId: nativeSessionId(
              this.input.session,
              this.input.session.parent_id ?? this.input.session.session_id,
            ),
            spawnCallIds,
            recordedMarkers: delegationAnnotationCandidates({
              text,
              index: annotationIndex,
              after: -1,
            }).map((index) => annotations[index].marker),
          });
        }
        if (text.includes("[appa] delegated trajectory "))
          throw replayUnavailable();
        text = unwrapKnownMetadata(text);
        if (hasRewriteCarrier(text)) throw replayUnavailable();
        this.restoreTextHolder({
          source: site,
          value: deliveredText(text),
          holders,
          origins,
          values,
        });
      }
    } catch (error) {
      throw replayUnavailable(error);
    }
  }

  /** Final request boundary: after all plugins and before provider dispatch. */
  async prepareRequest<T>(candidate: T): Promise<T> {
    try {
      const { capture, scope, wire } = this.input;
      const snapshot = await OpenAppaRewriteModel.readProjectionSnapshot({
        scope,
        wire,
        keys: [],
      });
      let needsFinalCheck = !snapshot.readOnlyNoopEligible;
      if (!snapshot.hasAncestors) this.inheritedScopes = [];
      const echoKeys = rewriteEchoKeys({
        family: capture.family,
        request: capture.echo.request,
      });
      if (!this.lineageCached(echoKeys)) {
        await this.loadWithLineage(echoKeys);
        needsFinalCheck = true;
      }
      if (!this.aliasTargetsCached()) {
        await this.loadAliasTargets();
        needsFinalCheck = true;
      }
      const callReferences = restoreRewriteCalls({
        family: capture.family,
        clientRequest: capture.echo.request,
        providerRequest: candidate,
        recorded: this.inverseRecords(capture.echo.sources),
        sources: capture.echo.sources,
      });
      const aliasesByOriginal = new Map<string, string[]>();
      for (const [alias, original] of callReferences) {
        const aliases = aliasesByOriginal.get(original) ?? [];
        aliases.push(alias);
        aliasesByOriginal.set(original, aliases);
      }
      const policySplices = [...this.policyOutputs].flatMap(([id, content]) => {
        const originalId = callReferences.get(id) ?? id;
        const resultIds = new Set([
          id,
          originalId,
          ...(aliasesByOriginal.get(originalId) ?? []),
        ]);
        const epoch = rewritePolicyEpoch(content);
        return [...resultIds].map((toolResultId) => ({
          toolResultId,
          epoch,
          content,
        }));
      });
      const head = snapshot.head;
      const state =
        head.revision === 0
          ? undefined
          : decodeHead(
              this.decrypt(head.state, scope, `head:${wire}`, "state"),
            );
      // A caller edit is the source chain missing a committed head. Missing
      // records and renderer provenance failures are not that signal.
      const callerEdit =
        state?.heads !== undefined &&
        !capture.projection.extendsHeads(state.heads);
      const options = {
        allowInitial: head.revision === 0 || callerEdit,
        heads: callerEdit ? undefined : state?.heads,
        policySplices,
      };
      const prepared = capture.projection.prepareCandidate(candidate, options);
      if (this.loadCached(prepared.keys).length > 0) {
        await this.load(prepared.keys);
        needsFinalCheck = true;
      }
      // Fetch one index level at a time, batching all paths in this history.
      // A missing node is an expired/corrupt record, never an empty override.
      for (let depth = 0; ; depth++) {
        const keys = prepared.referencedSpliceKeys(this.ownRecords());
        if (keys.length === 0) break;
        if (depth > 65) throw replayUnavailable();
        if (this.loadCached(keys).length > 0) {
          await this.load(keys);
          needsFinalCheck = true;
        }
        if (keys.some((key) => !this.ownRecords().has(key)))
          throw replayUnavailable();
      }
      const projected = prepared.project(this.ownRecords());
      const next = Buffer.from(
        JSON.stringify({ version: 1, heads: projected.heads }),
      );
      const previous = state && JSON.stringify(state);
      if (
        !needsFinalCheck &&
        projected.records.length === 0 &&
        previous === next.toString("utf8")
      ) {
        return projected.request as T;
      }
      await this.persist(projected.records, {
        wire,
        expectedRevision: head.revision,
        plaintextState: next,
        ...(previous !== next.toString("utf8")
          ? { state: this.encrypt(next, scope, `head:${wire}`, "state") }
          : {}),
      });
      return projected.request as T;
    } catch (error) {
      throw replayUnavailable(error);
    }
  }

  captureResponse(response: unknown): ReplayResponseCapture {
    return {
      identity: createHash("sha256")
        .update(JSON.stringify(response))
        .digest("hex"),
      calls: captureRewriteCalls({
        family: this.input.capture.family,
        response,
      }),
      texts: rewriteTextSites(response).map((site) => site.value),
    };
  }

  /** Executable call records must commit before any corresponding SSE release. */
  async recordResponse(params: {
    source: ReplayResponseCapture;
    response: unknown;
    emitted: readonly { id: string; wireId?: string }[];
    approvedText?: string;
    callsOnly?: boolean;
    /** These calls were created by an explicit hosted-tool denial. */
    policyCallIds?: readonly string[];
  }): Promise<void> {
    try {
      await this.ensureLive();
      const originals = new Map(params.source.calls);
      if (params.policyCallIds?.length) {
        // The withheld hosted call must not become the bytes a later turn
        // restores. The notice sent to the client is the policy representation.
        const emitted = captureRewriteCalls({
          family: this.family,
          response: params.response,
        });
        for (const id of params.policyCallIds) {
          const wireId =
            params.emitted.find((call) => call.id === id)?.wireId ?? id;
          const value = emitted.get(wireId);
          if (!value) throw replayUnavailable();
          originals.set(id, value);
        }
      }
      await this.load(
        rewriteCallKeys({ family: this.input.capture.family, originals }),
      );
      const pairs = recordRewriteCalls({
        family: this.input.capture.family,
        originals,
        response: params.response,
        emitted: params.emitted,
        recorded: this.ownRecords(),
      });
      if (!params.callsOnly) {
        const texts = rewriteTextSites(params.response);
        const textPairs: RewriteBytes[] = [];
        const sourceTexts = new Set(params.source.texts);
        for (const site of texts) {
          if (!needsTextInverse(site.value)) continue;
          const original = recordedTextOriginal({
            client: site.value,
            sourceTexts,
            ...(params.approvedText !== undefined
              ? { approvedText: params.approvedText }
              : {}),
          });
          if (original === undefined) throw replayUnavailable();
          const pair = recordRewriteText({
            original,
            rewritten: site.value,
          });
          if (pair) textPairs.push(pair);
        }
        await this.load(textPairs.map((pair) => pair.key));
        for (const pair of textPairs) {
          const stored = this.ownRecords().get(pair.key);
          if (stored && !samePair(stored, pair)) {
            logger.warn(
              {
                key: pair.key.split(":")[0],
                originalBytes: pair.original.length,
                rewrittenBytes: pair.rewritten.length,
                storedOriginalBytes: stored.original.length,
                storedRewrittenBytes: stored.rewritten.length,
                callCount: params.emitted.length,
                approved: params.approvedText !== undefined,
              },
              "OpenAPPA text inverse differs from the stored pair",
            );
          }
          if (!stored || !samePair(stored, pair)) pairs.push(pair);
        }
        const manifestKey = `${this.family}:response:v1:${this.input.capture.requestDigest}:${params.source.identity}`;
        await this.load([manifestKey]);
        const manifest = {
          key: manifestKey,
          original: Buffer.from(params.source.identity),
          rewritten: Buffer.from(
            createHash("sha256")
              .update(JSON.stringify(params.response))
              .digest("hex"),
          ),
        };
        const existing = this.ownRecords().get(manifestKey);
        if (existing && !samePair(existing, manifest))
          throw replayUnavailable();
        if (!existing) pairs.push(manifest);
      }
      await this.persist(pairs);
    } catch (error) {
      throw replayUnavailable(error);
    }
  }

  private async load(
    keys: readonly string[],
    scope = this.input.scope,
  ): Promise<void> {
    const uncached = this.loadCached(keys, scope);
    if (uncached.length === 0) return;
    const bucket = this.bucket(scope);
    const logicalKeys = new Map(
      uncached.map((key) => [this.physicalKey(key), key]),
    );
    const rows = await OpenAppaRewriteModel.loadBatch(scope, [
      ...logicalKeys.keys(),
    ]);
    for (const row of rows) {
      const key = logicalKeys.get(row.fragmentKey);
      if (!key) throw replayUnavailable();
      bucket.set(key, this.decodePair(key, row, scope));
    }
    this.cacheRows(scope, rows);
  }

  private loadCached(
    keys: readonly string[],
    scope = this.input.scope,
  ): string[] {
    this.assertReadable(scope);
    const bucket = this.bucket(scope);
    const uncached: string[] = [];
    for (const key of new Set(keys)) {
      if (bucket.has(key)) continue;
      const cached = bytesCache.get(
        this.cacheKey(scope, this.physicalKey(key)),
      );
      if (cached) bucket.set(key, this.decodePair(key, cached, scope));
      else uncached.push(key);
    }
    return uncached;
  }

  private lineageCached(keys: readonly string[]): boolean {
    if (keys.length === 0) return true;
    if (this.inheritedScopes === undefined) return false;
    return this.scopes().every(
      (scope) => this.loadCached(keys, scope).length === 0,
    );
  }

  private aliasTargetsCached(): boolean {
    let complete = true;
    for (const scope of this.scopes()) {
      const aliases = [...this.bucket(scope).values()]
        .filter((pair) => pair.key.startsWith("echo-alias:v1:"))
        .map((pair) => pair.rewritten.toString("utf8"));
      if (this.loadCached(aliases, scope).length > 0) complete = false;
    }
    return complete;
  }

  private async loadWithLineage(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const requested = [...new Set(keys)];
    const discovering = this.inheritedScopes === undefined;
    const missing = new Set<string>();
    for (const scope of this.scopes()) {
      const bucket = this.bucket(scope);
      for (const key of requested) {
        if (bucket.has(key)) continue;
        const cached = bytesCache.get(
          this.cacheKey(scope, this.physicalKey(key)),
        );
        if (cached) bucket.set(key, this.decodePair(key, cached, scope));
        else missing.add(key);
      }
    }
    if (this.inheritedScopes !== undefined && missing.size === 0) return;
    const logicalKeys = new Map(
      [...missing].map((key) => [this.physicalKey(key), key]),
    );
    let owners: Awaited<
      ReturnType<typeof OpenAppaRewriteModel.loadLineageBatch>
    >;
    try {
      owners = await OpenAppaRewriteModel.loadLineageBatch({
        organizationId: this.input.session.organization_id,
        sessionId: this.input.session.session_id,
        callerId: this.input.session.caller_id,
        scope: this.input.scope,
        keys: [...logicalKeys.keys()],
      });
    } catch (error) {
      // Oversized owner/key products retain the bounded per-owner read path.
      if (!(error instanceof ApiError) || error.statusCode !== 400) throw error;
      await this.load(requested);
      await this.ensureInheritedScopes();
      for (const inherited of this.inheritedScopes ?? [])
        await this.load(requested, inherited);
      return;
    }
    this.inheritedScopes = owners
      .map(({ scope }) => scope)
      .filter((scope) => !this.sameScope(scope));
    for (const { scope, pairs } of owners) {
      this.assertReadable(scope);
      this.cacheRows(scope, pairs);
      const bucket = this.bucket(scope);
      for (const pair of pairs) {
        const key = logicalKeys.get(pair.fragmentKey);
        if (key && !bucket.has(key))
          bucket.set(key, this.decodePair(key, pair, scope));
      }
    }
    if (
      discovering &&
      this.inheritedScopes.length > 0 &&
      !this.lineageCached(requested)
    )
      await this.loadWithLineage(requested);
  }

  private async ensureInheritedScopes(): Promise<void> {
    if (this.inheritedScopes !== undefined) return;
    const inheritedScopes: ReplayScope[] = [];
    const { session, scope } = this.input;
    const parents = await OpenAppaRewriteModel.ancestorSessionIds({
      organizationId: session.organization_id,
      sessionId: session.session_id,
      callerId: session.caller_id,
    });
    for (const sessionId of parents) {
      if (sessionId === session.session_id) throw replayUnavailable();
      const inherited = await OpenAppaRewriteModel.openExisting({
        organizationId: session.organization_id,
        sessionId,
        protocolVersion: 1,
      });
      if (
        inherited.organizationId !== session.organization_id ||
        inherited.sessionId !== sessionId ||
        inherited.epoch !== scope.epoch ||
        inherited.groupId !== scope.groupId
      ) {
        throw replayUnavailable();
      }
      inheritedScopes.push(inherited);
    }
    this.inheritedScopes = inheritedScopes;
  }

  private async persist(
    pairs: readonly RewriteBytes[],
    projection?: {
      wire: string;
      expectedRevision: number;
      state?: Buffer;
      plaintextState: Buffer;
    },
  ): Promise<void> {
    if (pairs.length === 0 && !projection) return;
    const byKey = new Map<string, RewriteBytes>();
    for (const pair of pairs) {
      const existing = byKey.get(pair.key) ?? this.ownRecords().get(pair.key);
      if (existing) {
        if (!samePair(existing, pair)) throw replayUnavailable();
      } else byKey.set(pair.key, pair);
    }
    const pending = [...byKey.values()];
    if (pending.length === 0 && !projection) return;
    const { scope } = this.input;
    const encrypted = pending.map((pair) => ({
      fragmentKey: this.physicalKey(pair.key),
      original: this.encrypt(
        pair.original,
        scope,
        this.physicalKey(pair.key),
        "original",
      ),
      rewritten: this.encrypt(
        pair.rewritten,
        scope,
        this.physicalKey(pair.key),
        "rewritten",
      ),
    }));
    try {
      const written = projection
        ? (
            await OpenAppaRewriteModel.commitProjection({
              scope,
              wire: projection.wire,
              expectedRevision: projection.expectedRevision,
              state: projection.state,
              pairs: encrypted,
            })
          ).pairs
        : await OpenAppaRewriteModel.appendBatch(scope, encrypted);
      const logicalKeys = new Map(
        pending.map((pair) => [this.physicalKey(pair.key), pair.key]),
      );
      for (const row of written) {
        const key = logicalKeys.get(row.fragmentKey);
        if (!key) throw replayUnavailable();
        const decoded = this.decodePair(key, row, scope);
        const expected = byKey.get(key);
        if (!expected || !samePair(decoded, expected))
          throw replayUnavailable();
        this.ownRecords().set(key, decoded);
      }
      this.cacheRows(scope, written);
      if (pending.some((pair) => !this.ownRecords().has(pair.key)))
        throw replayUnavailable();
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode !== 409) throw error;
      logger.warn(
        {
          message: error.message,
          keys: pending.map((pair) => ({
            kind: pair.key.split(":")[0],
            originalBytes: pair.original.length,
            rewrittenBytes: pair.rewritten.length,
            loaded: this.ownRecords().has(pair.key),
          })),
        },
        "OpenAPPA rewrite persist conflict",
      );
      // Concurrent identical plaintext has different GCM nonces. Accept the
      // committed winner only after authenticating and comparing both sides.
      for (const pair of pending) {
        bytesCache.delete(this.cacheKey(scope, this.physicalKey(pair.key)));
        this.ownRecords().delete(pair.key);
      }
      await this.load(pending.map((pair) => pair.key));
      if (
        pending.some((pair) => {
          const stored = this.ownRecords().get(pair.key);
          return !stored || !samePair(stored, pair);
        })
      )
        throw replayUnavailable(error);
      if (projection) {
        const current = await OpenAppaRewriteModel.readHead(
          scope,
          projection.wire,
        );
        if (current.revision === projection.expectedRevision) {
          await OpenAppaRewriteModel.commitProjection({
            scope,
            wire: projection.wire,
            expectedRevision: current.revision,
            state: projection.state,
            pairs: [],
          });
        } else if (
          current.revision === 0 ||
          !this.decrypt(
            current.state,
            scope,
            `head:${projection.wire}`,
            "state",
          ).equals(projection.plaintextState)
        ) {
          throw replayUnavailable(error);
        }
      }
    }
  }

  private decodePair(
    key: string,
    pair: StoredPair,
    scope: ReplayScope,
  ): RewriteBytes {
    const physical = this.physicalKey(key);
    return {
      key,
      original: this.decrypt(pair.original, scope, physical, "original"),
      rewritten: this.decrypt(pair.rewritten, scope, physical, "rewritten"),
    };
  }

  private async ensureLive(): Promise<void> {
    try {
      this.input.scope = await OpenAppaRewriteModel.verify(this.input.scope);
    } catch (error) {
      const { scope } = this.input;
      bytesCache.deleteByPrefix(this.cachePrefix(scope));
      this.recordsByOwner.clear();
      this.inheritedScopes = undefined;
      throw error;
    }
  }

  private restoreTextHolder(params: {
    source: ReplayTextSite;
    value: string;
    holders: ReadonlyMap<object, readonly ReplayTextSite[]>;
    origins: ReadonlyMap<unknown, readonly ReplayTextSite[]>;
    values: ReadonlyMap<string, Map<unknown, Set<ReplayTextSite>>>;
  }): void {
    const { source, value, holders, origins, values } = params;
    const stamp = (source.holder as Record<symbol, unknown>)[rewriteOrigin];
    const matches = [
      ...new Set([
        ...(holders.get(source.holder) ?? []),
        ...(stamp !== undefined ? (origins.get(stamp) ?? []) : []),
      ]),
    ].filter((candidate) => candidate.field === source.field);
    const sameField = values.get(source.field);
    let target: ReplayTextSite | undefined = matches[0];
    if (matches.length !== 1) {
      if (sameField?.get(value)?.size) return;
      const pending = sameField?.get(source.holder[source.field]);
      if (pending?.size !== 1) throw replayUnavailable();
      target = pending.values().next().value;
    }
    if (!target || !sameField) throw replayUnavailable();
    // Keep fallback value ownership current as earlier holders are restored.
    const previous = target.holder[target.field];
    const owned = sameField.get(previous);
    owned?.delete(target);
    if (owned?.size === 0) sameField.delete(previous);
    target.holder[target.field] = value;
    const restored = sameField.get(value) ?? new Set<ReplayTextSite>();
    restored.add(target);
    sameField.set(value, restored);
  }

  private physicalKey(key: string): string {
    return createHmac("sha256", this.indexKey).update(key).digest("hex");
  }

  private sameScope(scope: ReplayScope): boolean {
    return (
      scope.organizationId === this.input.scope.organizationId &&
      scope.groupId === this.input.scope.groupId &&
      scope.sessionId === this.input.scope.sessionId &&
      scope.epoch === this.input.scope.epoch
    );
  }

  private ownerKey(scope: ReplayScope): string {
    return JSON.stringify([
      scope.organizationId,
      scope.groupId,
      scope.epoch,
      scope.sessionId,
    ]);
  }

  private bucket(scope: ReplayScope): Map<string, RewriteBytes> {
    const id = this.ownerKey(scope);
    let records = this.recordsByOwner.get(id);
    if (!records) {
      records = new Map();
      this.recordsByOwner.set(id, records);
    }
    return records;
  }

  private ownRecords(): Map<string, RewriteBytes> {
    return this.bucket(this.input.scope);
  }

  private async loadVerifiedControlScope(
    keys: readonly string[],
    scope: ReplayScope,
  ): Promise<boolean> {
    const logicalKeys = new Map(
      keys.map((key) => [this.physicalKey(key), key]),
    );
    this.dropControlCache(scope, logicalKeys);
    try {
      const rows = await OpenAppaRewriteModel.loadBatch(scope, [
        ...logicalKeys.keys(),
      ]);
      const bucket = this.bucket(scope);
      for (const row of rows) {
        const key = logicalKeys.get(row.fragmentKey);
        if (!key) throw replayUnavailable();
        bucket.set(key, this.decodePair(key, row, scope));
      }
      return true;
    } catch (error) {
      this.dropControlCache(scope, logicalKeys);
      if (!unavailableReceipt(error)) throw error;
      return false;
    }
  }

  private dropControlCache(
    scope: ReplayScope,
    logicalKeys: ReadonlyMap<string, string>,
  ): void {
    const bucket = this.recordsByOwner.get(this.ownerKey(scope));
    for (const [physicalKey, logicalKey] of logicalKeys) {
      bucket?.delete(logicalKey);
      bytesCache.delete(this.cacheKey(scope, physicalKey));
    }
  }

  private assertReadable(scope: ReplayScope): void {
    if (this.sameScope(scope)) return;
    if (
      this.inheritedScopes?.some((inherited) =>
        this.sameIdentity(inherited, scope),
      )
    ) {
      return;
    }
    throw replayUnavailable();
  }

  private sameIdentity(left: ReplayScope, right: ReplayScope): boolean {
    return (
      left.organizationId === right.organizationId &&
      left.groupId === right.groupId &&
      left.sessionId === right.sessionId &&
      left.epoch === right.epoch
    );
  }

  private scopes(): ReplayScope[] {
    return [...(this.inheritedScopes ?? []), this.input.scope];
  }

  private pairsForKey(key: string): RewriteBytes[] {
    return this.scopes().flatMap((scope) => {
      const pair = this.bucket(scope).get(key);
      return pair ? [pair] : [];
    });
  }

  private textRecords(): ReadonlyMap<string, RewriteBytes> {
    const merged = new Map<string, RewriteBytes>();
    for (const scope of this.scopes()) {
      for (const [key, pair] of this.bucket(scope)) {
        if (!key.startsWith("echo-text:")) continue;
        const existing = merged.get(key);
        if (existing && !samePair(existing, pair)) throw replayUnavailable();
        merged.set(key, pair);
      }
    }
    return merged;
  }

  private async loadAliasTargets(): Promise<void> {
    for (const scope of this.scopes()) {
      const targets = [...this.bucket(scope).values()]
        .filter((pair) => pair.key.startsWith("echo-alias:v1:"))
        .map((pair) => pair.rewritten.toString("utf8"));
      if (targets.length > 0) await this.load(targets, scope);
    }
  }

  private inverseRecords(
    sources: readonly { id: string; bytes: Buffer }[],
  ): ReadonlyMap<string, RewriteBytes> {
    const merged = new Map<string, RewriteBytes>();
    const echoById = new Map(
      sources.map((source) => [source.id, source.bytes]),
    );
    const echoesByKey = new Map<string, Array<{ id: string; bytes: Buffer }>>();
    for (const source of sources) {
      const key = replayCallKey(this.family, source.id);
      const echoes = echoesByKey.get(key);
      if (echoes) echoes.push(source);
      else echoesByKey.set(key, [source]);
    }
    const aliases = new Map<
      string,
      Array<{ scope: ReplayScope; pair: RewriteBytes }>
    >();
    const calls = new Map<
      string,
      Array<{ scope: ReplayScope; pair: RewriteBytes }>
    >();
    for (const scope of this.scopes()) {
      for (const pair of this.bucket(scope).values()) {
        const owned = { scope, pair };
        if (pair.key.startsWith("echo-alias:v1:")) {
          const list = aliases.get(pair.key) ?? [];
          list.push(owned);
          aliases.set(pair.key, list);
        } else if (pair.key.startsWith("echo-call:v1:")) {
          const list = calls.get(pair.key) ?? [];
          list.push(owned);
          calls.set(pair.key, list);
        }
      }
    }
    for (const owners of aliases.values()) {
      const selected =
        owners.length === 1
          ? owners[0]
          : this.selectAliasOwner(owners, echoById);
      if (!selected) continue;
      const echoed = echoById.has(selected.pair.original.toString("utf8"));
      if (!this.installAlias(merged, selected) && echoed) {
        throw replayUnavailable();
      }
    }
    for (const [key, owners] of calls) {
      const selected = this.selectCallOwner(owners, echoesByKey.get(key) ?? []);
      if (selected) merged.set(key, pairForOriginalIdEcho(selected.pair));
    }
    for (const [key, pair] of this.textRecords()) merged.set(key, pair);
    return merged;
  }

  private selectAliasOwner(
    owners: Array<{ scope: ReplayScope; pair: RewriteBytes }>,
    echoById: ReadonlyMap<string, Buffer>,
  ): { scope: ReplayScope; pair: RewriteBytes } | undefined {
    const id = owners[0]?.pair.original.toString("utf8");
    if (
      !id ||
      owners.some((owner) => owner.pair.original.toString("utf8") !== id)
    ) {
      throw replayUnavailable();
    }
    const echo = echoById.get(id);
    if (!echo) return undefined;
    const matches = owners.filter((owner) => {
      const target = this.bucket(owner.scope).get(
        owner.pair.rewritten.toString("utf8"),
      );
      return (
        target !== undefined &&
        (echo.equals(target.rewritten) || echo.equals(target.original))
      );
    });
    if (matches.length === 1) return matches[0];
    if (
      matches.length > 1 &&
      matches.every((match) => samePair(match.pair, matches[0].pair))
    ) {
      return matches[0];
    }
    if (matches.length > 1) throw replayUnavailable();
    return undefined;
  }

  private selectCallOwner(
    owners: Array<{ scope: ReplayScope; pair: RewriteBytes }>,
    echoes: readonly { id: string; bytes: Buffer }[],
  ): { scope: ReplayScope; pair: RewriteBytes } | undefined {
    if (echoes.length === 0) return owners.length === 1 ? owners[0] : undefined;
    const matches = owners.filter((owner) =>
      echoes.some(
        (echo) =>
          echo.bytes.equals(owner.pair.rewritten) ||
          echo.bytes.equals(owner.pair.original),
      ),
    );
    if (matches.length === 1) return matches[0];
    if (
      matches.length > 1 &&
      matches.every((match) => samePair(match.pair, matches[0].pair))
    ) {
      return matches[0];
    }
    if (matches.length > 1) throw replayUnavailable();
    return owners.length === 1 ? owners[0] : undefined;
  }

  private installAlias(
    merged: Map<string, RewriteBytes>,
    owned: { scope: ReplayScope; pair: RewriteBytes },
  ): boolean {
    const bare = owned.pair.rewritten.toString("utf8");
    const target = this.bucket(owned.scope).get(bare);
    if (!target || target.key !== bare) return false;
    const pointer = `echo-owner:v1:${this.ownerKey(owned.scope)}:${bare}`;
    merged.set(pointer, { ...target, key: pointer });
    merged.set(owned.pair.key, {
      ...owned.pair,
      rewritten: Buffer.from(pointer, "utf8"),
    });
    return true;
  }

  private cacheRows(scope: ReplayScope, rows: readonly StoredPair[]): void {
    if (rows.length === 0) return;
    bytesCache.setMany(
      rows.map((row) => [this.cacheKey(scope, row.fragmentKey), row] as const),
    );
  }

  private cachePrefix(scope: ReplayScope): string {
    return `${this.ownerKey(scope).slice(0, -1)},`;
  }

  private cacheKey(scope: ReplayScope, fragmentKey: string): string {
    return `${this.cachePrefix(scope)}${JSON.stringify(fragmentKey)}]`;
  }

  private encrypt(
    bytes: Buffer,
    scope: ReplayScope,
    key: string,
    side: string,
  ): Buffer {
    return encryptBytesWithKey(
      bytes,
      this.encryptionKey,
      aad(scope, key, side),
    );
  }

  private decrypt(
    bytes: Buffer,
    scope: ReplayScope,
    key: string,
    side: string,
  ): Buffer {
    return decryptBytesWithKey(
      bytes,
      this.encryptionKey,
      aad(scope, key, side),
    );
  }

  private static controlReplay(
    session: OpenAppaSession,
    scope: ReplayScope,
    encryptedChat: EncryptedChatAuditDisposition,
  ): AppaRewriteReplay {
    return new AppaRewriteReplay({
      session,
      capture: captureAppaReplayRequest({
        family: "anthropic:messages",
        body: { messages: [] },
      }),
      scope,
      encryptedChat,
      wire: "control",
    });
  }
}

type ReplayScope = Awaited<ReturnType<typeof OpenAppaRewriteModel.open>>;
type StoredPair = Awaited<
  ReturnType<typeof OpenAppaRewriteModel.loadBatch>
>[number];
type ReplayResponseCapture = {
  identity: string;
  calls: ReadonlyMap<string, Buffer>;
  texts: readonly string[];
};
type ReplayTextSite = ReturnType<typeof rewriteTextSites>[number];
type DelegationAnnotation = ReturnType<typeof recordedDelegationText>[number];
type DelegationAnnotationIndex = {
  annotations: readonly DelegationAnnotation[];
  byToken: ReadonlyMap<string, readonly number[]>;
  unindexed: readonly number[];
};

const bytesCache = new LRUCacheManager<StoredPair>({
  maxSize: 4096,
  maxBytes: 32 * 1024 * 1024,
  defaultTtl: 60_000,
  sizeOf: (pair) =>
    pair.original.length + pair.rewritten.length + pair.fragmentKey.length * 2,
});

const MARK_TOP = "▄█▄▄▄█▄";
const MARK_BOTTOM = "██▄█▄██";
const DISPLAY_CODE = "[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}";
const RETURN_MARKER_BODY = `\\n\\n(?:${MARK_TOP}\\n${MARK_BOTTOM} {2})?(?:finished subagent|finished protected subagent|protected subagent session|protected subagent return|protected delegated return)(?: [A-Za-z0-9_:-]{1,512})? ${DISPLAY_CODE}`;
const START_MARKER_BODY = `(?:^|(?<=\\n))(?:${MARK_TOP}\\n${MARK_BOTTOM} {2})?(?:started subagent|started protected subagent|protected delegated session)(?: [A-Za-z0-9_:-]{1,512})? ${DISPLAY_CODE}(?:\\n\\n)?`;
const DELEGATION_BODY =
  "\\n\\n\\[appa\\] delegated trajectory (?:appa-[0-9a-f]{40}|appa2-[A-Za-z0-9_-]+\\.[0-9a-f]{40}) — child of [^\\n]+\\.";
const TRAJECTORY_RECEIPT = `(?:${MARK_TOP}\\n${MARK_BOTTOM} {2})?(?:started subagent|started protected subagent|protected delegated session)(?: [A-Za-z0-9_:-]{1,512})? ${DISPLAY_CODE}\\s*\\n?\\[appa\\] child trajectory appact2-[A-Za-z0-9_-]+\\.[0-9a-f]{64}\\.\\n{0,2}`;
const RETURN_MARKER_SUFFIX = new RegExp(`${RETURN_MARKER_BODY}$`);
const START_MARKER_PREFIX = new RegExp(`^${START_MARKER_BODY}`);
const DELEGATION_SUFFIX = new RegExp(`${DELEGATION_BODY}$`);

function nativeSessionId(session: OpenAppaSession, id: string): string {
  const prefix = session.caller_id ? `${session.caller_id}|` : undefined;
  return prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function indexDelegationAnnotations(
  annotations: readonly DelegationAnnotation[],
): DelegationAnnotationIndex {
  const byToken = new Map<string, number[]>();
  const unindexed: number[] = [];
  for (const [index, annotation] of annotations.entries()) {
    const token = /\[appa\] delegated trajectory ([^\s]+)/.exec(
      annotation.marker,
    )?.[1];
    if (!token) {
      unindexed.push(index);
      continue;
    }
    const owned = byToken.get(token) ?? [];
    owned.push(index);
    byToken.set(token, owned);
  }
  return { annotations, byToken, unindexed };
}

function delegationAnnotationCandidates(params: {
  text: string;
  index: DelegationAnnotationIndex;
  after: number;
}): number[] {
  const candidates = new Set(
    params.index.unindexed.filter((index) => index > params.after),
  );
  for (const match of params.text.matchAll(
    /\[appa\] delegated trajectory ([^\s]+)/g,
  )) {
    for (const index of params.index.byToken.get(match[1]) ?? []) {
      if (index > params.after) candidates.add(index);
    }
  }
  return [...candidates].sort((left, right) => left - right);
}

function restoreDelegationAnnotations(params: {
  text: string;
  index: DelegationAnnotationIndex;
}): string {
  let text = params.text;
  let candidates = delegationAnnotationCandidates({ ...params, after: -1 });
  let cursor = 0;
  while (cursor < candidates.length) {
    const index = candidates[cursor++];
    const annotation = params.index.annotations[index];
    const restored = text.replaceAll(annotation.rewritten, annotation.original);
    if (restored === text) continue;
    text = restored;
    // Preserve ordered replacements: removing a span can expose a later one.
    candidates = delegationAnnotationCandidates({
      text,
      index: params.index,
      after: index,
    });
    cursor = 0;
  }
  return text;
}

function needsTextInverse(text: string): boolean {
  if (isQuotedHistory(text)) return false;
  return (
    hasRewriteCarrier(text) ||
    stripSessionReceipts(text).codes.length > 0 ||
    stripChildTrajectoryReceipts(text).receipts.length > 0 ||
    new RegExp(RETURN_MARKER_BODY).test(text) ||
    new RegExp(START_MARKER_BODY).test(text) ||
    new RegExp(DELEGATION_BODY).test(text)
  );
}

function unwrapKnownMetadata(text: string): string {
  let current = text;
  for (let pass = 0; pass < 8; pass += 1) {
    const stripped = stripEmbeddedKnownMarkers(
      stripTrailingDelegationMarker(
        stripLeadingStartMarker(
          stripTrailingReturnMarker(
            stripEmbeddedTrajectoryReceipts(stripSessionReceipts(current).text),
          ),
        ),
      ),
    );
    if (stripped === current) return current;
    current = stripped;
  }
  return current;
}

function pairForOriginalIdEcho(pair: RewriteBytes): RewriteBytes {
  const original = parseCall(pair.original);
  const rewritten = parseCall(pair.rewritten);
  if (!original || !rewritten) return pair;
  const next = { ...rewritten };
  let changed = false;
  for (const field of ["id", "call_id"] as const) {
    const from = original[field];
    const stamped = rewritten[field];
    if (
      typeof from === "string" &&
      typeof stamped === "string" &&
      from !== stamped
    ) {
      next[field] = from;
      changed = true;
    }
  }
  if (!changed) return pair;
  return {
    ...pair,
    rewritten: Buffer.from(JSON.stringify(next), "utf8"),
  };
}

function parseCall(bytes: Buffer): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function deliveredText(text: string): string {
  if (!/^\s*<task\b[^>]*\bstate\s*=\s*(["'])completed\1[^>]*>/.test(text)) {
    return text;
  }
  const open = "<task_result>";
  const close = "</task_result>";
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end < start) return text;
  return text
    .slice(start + open.length, end)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");
}

function stripEmbeddedTrajectoryReceipts(text: string): string {
  return text.replace(new RegExp(TRAJECTORY_RECEIPT, "g"), "");
}

function stripEmbeddedKnownMarkers(text: string): string {
  return text
    .replace(new RegExp(RETURN_MARKER_BODY, "g"), "")
    .replace(new RegExp(START_MARKER_BODY, "g"), "")
    .replace(new RegExp(DELEGATION_BODY, "g"), "");
}

function stripTrailingReturnMarker(text: string): string {
  return text.replace(RETURN_MARKER_SUFFIX, "");
}

function stripLeadingStartMarker(text: string): string {
  return text.replace(START_MARKER_PREFIX, "");
}

function stripTrailingDelegationMarker(text: string): string {
  return text.replace(DELEGATION_SUFFIX, "");
}

function recordedTextOriginal(params: {
  client: string;
  sourceTexts: ReadonlySet<string>;
  approvedText?: string;
}): string | undefined {
  const unwrapped = unwrapKnownMetadata(params.client);
  if (params.approvedText !== undefined && unwrapped === params.approvedText) {
    return params.approvedText;
  }
  if (params.sourceTexts.has(unwrapped)) return unwrapped;
  if (unwrapped === "") return "";
  return undefined;
}

function nestedRewriteTexts(text: string): string[] {
  return [...text.matchAll(/<result>([\s\S]*?)<\/result>/g)]
    .map((match) => match[1])
    .filter((value) => value.length > 0 && value !== text);
}

function samePair(left: RewriteBytes, right: RewriteBytes): boolean {
  return (
    left.original.equals(right.original) &&
    left.rewritten.equals(right.rewritten)
  );
}

type ControlReceipt = {
  outcome: ControlOutcomeClass;
  bytes: string;
};

const CONTROL_OUTCOME_CLASSES: readonly ControlOutcomeClass[] = [
  "pending",
  "denied",
  "canceled",
  "applied",
  "refused",
];

async function readableControlScopes(
  session: OpenAppaSession,
): Promise<ReplayScope[]> {
  const ancestors = await verifiedControlAncestorIds(session);
  if (!ancestors) return [];
  const scopes: ReplayScope[] = [];
  try {
    scopes.push(
      await OpenAppaRewriteModel.openExisting({
        organizationId: session.organization_id,
        sessionId: session.session_id,
        protocolVersion: 1,
      }),
    );
  } catch (error) {
    if (!unavailableReceipt(error)) throw error;
  }
  for (const sessionId of ancestors) {
    try {
      const inherited = await OpenAppaRewriteModel.openExisting({
        organizationId: session.organization_id,
        sessionId,
        protocolVersion: 1,
      });
      if (
        inherited.organizationId !== session.organization_id ||
        inherited.sessionId !== sessionId
      ) {
        continue;
      }
      scopes.push(inherited);
    } catch (error) {
      if (!unavailableReceipt(error)) throw error;
    }
  }
  return scopes;
}

async function verifiedControlAncestorIds(
  session: OpenAppaSession,
): Promise<string[] | undefined> {
  try {
    return await OpenAppaRewriteModel.ancestorSessionIds({
      organizationId: session.organization_id,
      sessionId: session.session_id,
      callerId: session.caller_id,
    });
  } catch (error) {
    if (unavailableReceipt(error)) return undefined;
    throw error;
  }
}

function sameControlBinding(
  left: OpenAppaSession,
  right: OpenAppaSession,
): boolean {
  return (
    left.organization_id === right.organization_id &&
    left.session_id === right.session_id &&
    (left.caller_id ?? "") === (right.caller_id ?? "")
  );
}

function controlReceiptKey(toolCallId: string): string {
  return `control:v1:${encodeURIComponent(toolCallId)}`;
}

function bindableControlCallId(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    !/\p{Cc}/u.test(value)
  );
}

function uniqueControlIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(bindableControlCallId))];
}

function isControlOutcomeClass(value: string): value is ControlOutcomeClass {
  return CONTROL_OUTCOME_CLASSES.includes(value as ControlOutcomeClass);
}

function unavailableReceipt(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.statusCode === 409 || error.statusCode === 410)
  );
}

function aad(scope: ReplayScope, key: string, side: string): string {
  return JSON.stringify([
    "appa-replay-v1",
    scope.organizationId,
    scope.groupId,
    scope.epoch,
    scope.sessionId,
    key,
    side,
  ]);
}

function decodeHead(bytes: Buffer): {
  version: 1;
  heads: RewriteHeads;
} {
  const state = JSON.parse(bytes.toString("utf8"));
  if (
    state?.version !== 1 ||
    !state.heads ||
    typeof state.heads !== "object" ||
    Array.isArray(state.heads)
  )
    throw replayUnavailable();
  for (const key of Object.keys(state.heads)) {
    if (
      !["item", "envelope", "tool", "splice"].includes(key) ||
      typeof state.heads[key] !== "string"
    )
      throw replayUnavailable();
  }
  return state;
}

function replayUnavailable(error?: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof RewriteProjectionError)
    return new ApiError(
      409,
      `OpenAPPA exact replay rejected incompatible content (${error.code})`,
    );
  if (error instanceof RewriteEchoError) {
    logger.warn({ code: error.code }, "OpenAPPA exact replay rejected");
  }
  return new ApiError(
    409,
    "OpenAPPA cannot verify exact replay for this session. Start a new session instead of reconstructing missing content.",
  );
}

const CACHE_ENVELOPE_FIELDS = new Set([
  "cache_control",
  "prompt_cache_key",
  "prompt_cache_retention",
]);

function envelopeFields(request: unknown): Record<string, unknown> {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw replayUnavailable();
  return JSON.parse(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(request).filter(
          ([key]) =>
            ![
              "messages",
              "input",
              "contents",
              "tools",
              "system",
              "instructions",
              "systemInstruction",
            ].includes(key),
        ),
      ),
    ),
  );
}

function envelopeBytes(
  fields: Record<string, unknown>,
  names: readonly string[],
): Buffer {
  return Buffer.from(
    JSON.stringify(
      names.map((name) =>
        fields[name] === undefined ? [name, false] : [name, true, fields[name]],
      ),
    ),
  );
}
