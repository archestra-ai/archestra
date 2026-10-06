import { createHash } from "node:crypto";
import { isOmitted, markOmitted } from "./provenance";
import { parseTrajectoryStamp } from "./trajectory-stamp";

/** @public — enumerable origin stamp; object spread keeps it, JSON.stringify drops it. */
export const rewriteOrigin: unique symbol = Symbol("openappa.rewriteOrigin");

const REWRITE_WIRE_FAMILIES = [
  "anthropic:messages",
  "openai:chatCompletions",
  "openai:responses",
] as const;

type RewriteWireFamily = (typeof REWRITE_WIRE_FAMILIES)[number];

type RewriteFragmentPair = {
  original: Buffer;
  rewritten: Buffer;
};

type RewriteRecord = RewriteFragmentPair & {
  key: string;
};

export type RewriteHeads = {
  /** Reset with envelope, tool, and splice for an explicit new generation. */
  item?: string;
  /** Reset with item, tool, and splice for an explicit new generation. */
  envelope?: string;
  /** Reset with item, envelope, and splice for an explicit new generation. */
  tool?: string;
  /**
   * Content hash of the splice-index root. Absent means no overrides and no
   * extra reads. Reset it with the chain heads on a caller history-edit
   * generation. unrecorded is that edit; reordered and lost-source are not.
   */
  splice?: string;
};

type PolicySplice = {
  id?: string;
  /** Service alias for id. Epoch is informational; the stored key is the content digest. */
  toolResultId?: string;
  content?: unknown;
  epoch?: string;
};

type ProjectOptions = {
  policyToolResultIds?: readonly string[];
  policySplices?: readonly PolicySplice[];
  /** Authoritative tool-result content. The splice epoch is this value's digest. */
  toolResultUpdates?: ReadonlyMap<string, unknown>;
  /** Empty record map may create the first projection. Never overwrites a hit. */
  allowInitial?: boolean;
  /** Last committed chain hash per domain. A missing hash is divergence, not a rebuild. */
  heads?: RewriteHeads;
};

type RewriteProjection = {
  records: readonly RewriteRecord[];
  request: unknown;
  keys: readonly string[];
  heads: RewriteHeads;
};

type RewriteProjectionErrorCode =
  | "lost-source"
  | "reordered"
  | "unrecorded"
  | "incompatible"
  | "ambiguous"
  | "unknown-provenance";

/** @public — generic failure. `message` is fixed and never includes fragment text. */
export class RewriteProjectionError extends Error {
  readonly code: RewriteProjectionErrorCode;

  constructor(code: RewriteProjectionErrorCode) {
    super("rewrite projection rejected");
    this.name = "RewriteProjectionError";
    this.code = code;
  }
}

type RewriteCapture = {
  readonly family: RewriteWireFamily;
  readonly keys: readonly string[];
  /** Call after plugin mutations and inverse restoration, before awaiting reads. */
  prepareCandidate(
    candidateBody: unknown,
    options?: ProjectOptions,
  ): {
    readonly keys: readonly string[];
    referencedSpliceKeys(
      records: ReadonlyMap<string, RewriteFragmentPair>,
    ): readonly string[];
    project(
      records: ReadonlyMap<string, RewriteFragmentPair>,
    ): RewriteProjection;
  };
  candidateKeys(
    candidateBody: unknown,
    options?: ProjectOptions,
  ): readonly string[];
  candidateSpliceIds(
    candidateBody: unknown,
    options?: ProjectOptions,
  ): readonly string[];
  /**
   * Next batched logical keys for this capture's canonical tool-result ids.
   * Empty when heads.splice is absent. One level per call.
   */
  referencedSpliceKeys(
    records: ReadonlyMap<string, RewriteFragmentPair>,
    heads?: RewriteHeads,
  ): readonly string[];
  /**
   * Source chains only. True when every set item/envelope/tool head still
   * appears in that domain. A removed domain is an edit. Splice is ignored.
   */
  extendsHeads(heads: RewriteHeads): boolean;
  project(
    candidateBody: unknown,
    records: ReadonlyMap<string, RewriteFragmentPair>,
    options?: ProjectOptions,
  ): RewriteProjection;
};

/** @public — frozen v1 content epoch. Parent must not reimplement this digest. */
export function rewritePolicyEpoch(content: unknown): string {
  return digestHex(content);
}

/** @public — exact splice key. Parent loads this key; there is no prefix scan. */
export function rewriteSpliceKey(
  family: RewriteWireFamily,
  toolResultId: string,
  content: unknown,
): string {
  return spliceKey(family, toolResultId, rewritePolicyEpoch(content));
}

/** @public — call before any APPA input mutation. */
export function captureRewriteRequest(
  body: unknown,
  family: RewriteWireFamily,
): RewriteCapture {
  if (!isFamily(family)) fail("incompatible");
  const root = asRecord(body);
  if (!root) fail("incompatible");

  let bakedPolicy = new Map<string, unknown>();
  let bakedPolicyByIdentity = new Map<string, unknown>();
  let splicesByIdentity = new Map<string, unknown>();
  const tagged = new Set<number>();
  const containerStamps = new Map<string, Set<number>>();
  const toolIds = new Set<number>();
  let nextId = 1;
  const atoms: Atom[] = [];
  const chains: Record<Domain, string | undefined> = {
    item: undefined,
    envelope: undefined,
    tool: undefined,
  };
  const sourceChains: Record<Domain, Set<string>> = {
    item: new Set(),
    envelope: new Set(),
    tool: new Set(),
  };
  const sourceMarkers: MarkerSite[] = [];
  const stampToAtom = new Map<number, string>();

  const tag = (
    node: object,
    chainHash: string,
    tool = false,
    container?: string,
  ): number => {
    const existing = readStamp(node);
    if (existing) {
      stampToAtom.set(existing.id, chainHash);
      if (container) noteStamp(container, existing.id);
      return existing.id;
    }
    const id = nextId;
    nextId += 1;
    Object.defineProperty(node, rewriteOrigin, {
      value: { v: 1, id },
      enumerable: true,
      configurable: true,
      writable: false,
    });
    tagged.add(id);
    stampToAtom.set(id, chainHash);
    if (tool) toolIds.add(id);
    if (container) noteStamp(container, id);
    return id;
  };

  const push = (
    domain: Domain,
    fragment: Fragment,
    structural: unknown,
  ): Atom => {
    const digest = sha256(serialize(fragment));
    const chainHash = rolling(
      chains[domain],
      family,
      domain,
      serialize(structural),
    );
    chains[domain] = chainHash;
    sourceChains[domain].add(chainHash);
    const atom: Atom = {
      domain,
      key: `${family}:${domain}:${chainHash}`,
      chainHash,
      digest,
      fragment,
      toolResultIds: resultIdsIn(fragment.body),
    };
    atoms.push(atom);
    return atom;
  };

  const historyContainer = family === "openai:responses" ? "input" : "messages";
  const envelopeContainer =
    family === "anthropic:messages" ? "system" : "instructions";
  captureEnvelope(
    root,
    family,
    push,
    (node, chainHash, tool) => tag(node, chainHash, tool, envelopeContainer),
    sourceMarkers,
  );
  captureHistory(
    root,
    family,
    push,
    (node, chainHash, tool) => tag(node, chainHash, tool, historyContainer),
    sourceMarkers,
  );
  captureTools(root, family, push, tag, sourceMarkers);

  const domainAtoms: Record<Domain, Atom[]> = {
    item: atoms.filter((atom) => atom.domain === "item"),
    envelope: atoms.filter((atom) => atom.domain === "envelope"),
    tool: atoms.filter((atom) => atom.domain === "tool"),
  };
  const itemById = new Map<number, Atom>();
  const resultAtoms = new Map<string, Atom>();
  for (const atom of atoms) {
    if (
      atom.domain === "item" &&
      atom.nodeId !== undefined &&
      !itemById.has(atom.nodeId)
    ) {
      itemById.set(atom.nodeId, atom);
    }
    for (const id of atom.toolResultIds) {
      if (!resultAtoms.has(id)) resultAtoms.set(id, atom);
    }
  }

  const sourceLayoutDigest =
    sourceMarkers.length === 0 ? undefined : sha256(serialize(sourceMarkers));
  const cacheKey = sourceLayoutDigest
    ? `${family}:cache:${sourceLayoutDigest.toString("hex")}`
    : undefined;
  const keys = atoms.map((atom) => atom.key);
  if (cacheKey) keys.push(cacheKey);

  const capture: RewriteCapture = {
    family,
    keys,
    prepareCandidate,
    candidateKeys(candidateBody, options) {
      return exactKeys(candidateBody, options ?? {});
    },
    candidateSpliceIds(_candidateBody, options) {
      return [...authorizedIds(options ?? {})];
    },
    referencedSpliceKeys(records, heads) {
      return nextSpliceKeys(
        family,
        records,
        heads?.splice,
        canonicalResultIds(),
      );
    },
    extendsHeads(heads) {
      for (const domain of ["item", "envelope", "tool"] as const) {
        const head = heads[domain];
        if (head === undefined) continue;
        if (!sourceChains[domain].has(head)) return false;
      }
      return true;
    },
    project(candidateBody, records, options) {
      const projected = prepareCandidate(candidateBody, options).project(
        records,
      );
      stripSymbols(body);
      if (candidateBody !== root) stripSymbols(candidateBody);
      return projected;
    },
  };

  return capture;

  function exactKeys(
    candidateBody: unknown,
    options: ProjectOptions,
    ids = authorizedIds(options),
    inserts = policyInserts(candidateBody, ids),
    epoch = rewritePolicyEpoch,
  ): string[] {
    const out = [...keys];
    const policy = new Map<string, PolicySplice>();
    for (const splice of options.policySplices ?? []) {
      const id = spliceIdentity(splice);
      if (id !== undefined && !policy.has(id)) policy.set(id, splice);
    }
    const contents =
      ids.size > 0
        ? indexResultContents(candidateBody)
        : new Map<string, unknown>();
    for (const id of ids) {
      const splice = policy.get(id);
      const content = options.toolResultUpdates?.has(id)
        ? options.toolResultUpdates.get(id)
        : splice && "content" in splice
          ? splice.content
          : contents.get(resultIdentity(id));
      if (content !== undefined)
        out.push(spliceKey(family, id, epoch(content)));
    }
    for (const insert of inserts) out.push(insert.key);
    if (toolAtoms().length === 0 && hasToolContainer(candidateBody)) {
      out.push(toolHeadKey());
    }
    if (options.heads?.splice) {
      out.push(spliceIndexKey(family, options.heads.splice));
    }
    return out;
  }

  function prepareCandidate(
    candidateBody: unknown,
    suppliedOptions: ProjectOptions = {},
  ): ReturnType<RewriteCapture["prepareCandidate"]> {
    const copies = new WeakMap<object, unknown>();
    const candidate = asRecord(snapshotValue(candidateBody, copies));
    if (!candidate) fail("incompatible");
    const options: ProjectOptions = {
      ...suppliedOptions,
      heads: suppliedOptions.heads ? { ...suppliedOptions.heads } : undefined,
      policyToolResultIds: suppliedOptions.policyToolResultIds?.slice(),
      policySplices: suppliedOptions.policySplices?.map(
        (splice) => snapshotValue(splice, copies) as PolicySplice,
      ),
      toolResultUpdates: suppliedOptions.toolResultUpdates
        ? new Map(
            [...suppliedOptions.toolResultUpdates].map(([id, content]) => [
              id,
              snapshotValue(content, copies),
            ]),
          )
        : undefined,
    };
    verifyStamps(candidate);
    const ids = authorizedIds(options);
    const inserts = policyInserts(candidate, ids);
    const epochs = new Map<unknown, string>();
    const epoch = (content: unknown) => {
      const found = epochs.get(content);
      if (found !== undefined) return found;
      const hash = rewritePolicyEpoch(content);
      epochs.set(content, hash);
      return hash;
    };
    const readKeys = Object.freeze(
      exactKeys(candidate, options, ids, inserts, epoch),
    );
    const viewFor = candidateViews(candidate);
    const injections = candidateInjections(candidate, ids);
    const explicit = explicitPolicy(options, new Set(resultAtoms.keys()));
    let layout: MarkerSite[] | undefined;
    let tools: unknown[] | undefined;
    const material: CandidateMaterial = {
      candidate,
      options,
      readKeys,
      inserts,
      viewFor,
      injections,
      explicit,
      epoch,
      layout: () => (layout ??= collectCandidateMarkers(candidate)),
      tools: () => (tools ??= untaggedTools(candidate)),
    };
    return Object.freeze({
      keys: readKeys,
      referencedSpliceKeys(records: ReadonlyMap<string, RewriteFragmentPair>) {
        return capture.referencedSpliceKeys(records, options.heads);
      },
      project(records: ReadonlyMap<string, RewriteFragmentPair>) {
        return projectBody(material, records);
      },
    });
  }

  function projectBody(
    material: CandidateMaterial,
    records: ReadonlyMap<string, RewriteFragmentPair>,
  ): RewriteProjection {
    const { candidate, options } = material;
    const created: RewriteRecord[] = [];
    const planned = planPolicy(records, options, created, material);
    bakedPolicyByIdentity = indexResultIdentities(bakedPolicy);
    splicesByIdentity = indexResultIdentities(planned.splices);
    const decisions = new Map<string, Payload>();
    const heads = commitDomains(
      records,
      options,
      decisions,
      created,
      material,
      new Set([...planned.splices.keys(), ...planned.replayed]),
    );
    if (planned.spliceHead) heads.splice = planned.spliceHead;
    const inserts = commitInserts(material.inserts, records, options, created);
    const layout = commitCache(material, records, created);
    const request = assemble(
      candidate,
      decisions,
      planned.splices,
      inserts,
      layout,
    );
    return {
      records: created,
      request: parseJson(serialize(request)),
      keys: material.readKeys,
      heads,
    };
  }

  function verifyStamps(candidate: Record<string, unknown>): void {
    const foundAll: number[] = [];
    collectStamps(candidate, foundAll);
    for (const id of foundAll) {
      if (!tagged.has(id)) fail("unknown-provenance");
    }
    for (const [container, expectedIds] of containerStamps) {
      const expected = [...expectedIds];
      const found: number[] = [];
      for (const entry of containerEntries(candidate, container)) {
        collectStamps(entry, found);
      }
      let cursor = 0;
      for (const id of found) {
        if (!expectedIds.has(id)) continue;
        while (cursor < expected.length && expected[cursor] !== id) cursor += 1;
        if (cursor >= expected.length) fail("reordered");
        cursor += 1;
      }
      const foundSet = new Set(found);
      for (const id of expected) {
        if (foundSet.has(id) || toolIds.has(id)) continue;
        fail("lost-source");
      }
    }
  }

  function noteStamp(container: string, id: number): void {
    const list = containerStamps.get(container) ?? new Set<number>();
    list.add(id);
    containerStamps.set(container, list);
  }

  function commitDomains(
    records: ReadonlyMap<string, RewriteFragmentPair>,
    options: ProjectOptions,
    decisions: Map<string, Payload>,
    created: RewriteRecord[],
    material: CandidateMaterial,
    covered: ReadonlySet<string>,
  ): RewriteHeads {
    const heads: RewriteHeads = {};
    for (const domain of DOMAINS) {
      const mine = domainAtoms[domain];
      const head = options.heads?.[domain];
      if (mine.length === 0) {
        if (head) heads[domain] = head;
        continue;
      }
      const prefix = prefixLength(domain, mine, records, options, head);
      for (let index = 0; index < mine.length; index += 1) {
        const atom = mine[index];
        if (index < prefix) {
          decisions.set(atom.key, loadPayload(atom, records, covered));
          continue;
        }
        const payload = payloadForNew(
          atom,
          material.viewFor,
          material.injections,
        );
        created.push(storePayload(atom.key, atom.digest, payload));
        decisions.set(atom.key, roundTrip(payload));
      }
      heads[domain] = mine[mine.length - 1].chainHash;
    }
    if (toolAtoms().length === 0) {
      const headKey = toolHeadKey();
      const existing = records.get(headKey);
      const injected = existing ? [] : material.tools();
      if (injected.length > 0 || existing) {
        const payload = records.has(headKey)
          ? decodePayload(records.get(headKey) as RewriteFragmentPair)
          : {
              v: 1 as const,
              before: [],
              after: [],
              self: injected,
            };
        if (!records.has(headKey)) {
          created.push(
            storePayload(headKey, sha256(serialize(injected)), payload),
          );
        }
        decisions.set(
          headKey,
          records.has(headKey) ? payload : roundTrip(payload),
        );
      }
    }
    return heads;
  }

  function prefixLength(
    domain: Domain,
    domainAtoms: Atom[],
    records: ReadonlyMap<string, RewriteFragmentPair>,
    options: ProjectOptions,
    head: string | undefined,
  ): number {
    if (head) {
      const index = domainAtoms.findIndex((atom) => atom.chainHash === head);
      if (index < 0) fail("unrecorded");
      for (let cursor = 0; cursor <= index; cursor += 1) {
        if (!records.has(domainAtoms[cursor].key)) fail("unrecorded");
      }
      for (let cursor = index + 1; cursor < domainAtoms.length; cursor += 1) {
        if (records.has(domainAtoms[cursor].key)) fail("reordered");
      }
      return index + 1;
    }
    let prefix = 0;
    while (
      prefix < domainAtoms.length &&
      records.has(domainAtoms[prefix].key)
    ) {
      prefix += 1;
    }
    for (let cursor = prefix; cursor < domainAtoms.length; cursor += 1) {
      if (records.has(domainAtoms[cursor].key)) fail("reordered");
    }
    if (prefix === 0 && !options.allowInitial) fail("unrecorded");
    if (prefix === 0 && hasDomainRecord(records, domain)) fail("unrecorded");
    return prefix;
  }

  function loadPayload(
    atom: Atom,
    records: ReadonlyMap<string, RewriteFragmentPair>,
    covered: ReadonlySet<string>,
  ): Payload {
    const pair = records.get(atom.key);
    if (!pair) fail("unrecorded");
    const decoded = decodePair(pair);
    if (!decoded.digest.equals(atom.digest)) {
      const coveredChange =
        resultContentOnlyChange(atom, decoded.payload) &&
        atom.toolResultIds.every((id) => covered.has(id));
      if (!coveredChange) fail("incompatible");
    }
    return decoded.payload;
  }

  function resultContentOnlyChange(atom: Atom, payload: Payload): boolean {
    if (atom.toolResultIds.length === 0) return false;
    const recorded = payload.self ?? atom.fragment.body;
    return (
      serialize(blankResults(normalizeResultIds(atom.fragment.body))) ===
      serialize(blankResults(normalizeResultIds(recorded)))
    );
  }

  function payloadForNew(
    atom: Atom,
    viewFor: (atom: Atom) => unknown,
    injections: Map<string, { before: unknown[]; after: unknown[] }>,
  ): Payload {
    const view = viewFor(atom);
    const extra = injections.get(atom.key) ?? { before: [], after: [] };
    if (view === OMIT) {
      return { v: 1, before: [], after: [], self: null, omit: true };
    }
    const projected = bakeResults(
      view === undefined ? atom.fragment.body : view,
      bakedPolicy,
      bakedPolicyByIdentity,
    );
    const bodySame =
      serialize(projected) === serialize(atom.fragment.body) &&
      !atom.toolResultIds.some((id) => bakedPolicy.has(id));
    const anchored = extra.before.length > 0 || extra.after.length > 0;
    if (bodySame && !anchored && atom.toolResultIds.length === 0) {
      return { v: 1, before: [], after: [], self: null };
    }
    if (bodySame && atom.toolResultIds.length > 0) {
      return {
        v: 1,
        before: extra.before.map((entry) => parseJson(serialize(entry))),
        after: extra.after.map((entry) => parseJson(serialize(entry))),
        self: blankResults(atom.fragment.body),
        contentIdentity: true,
      };
    }
    return {
      v: 1,
      before: extra.before.map((entry) => parseJson(serialize(entry))),
      after: extra.after.map((entry) => parseJson(serialize(entry))),
      self: bodySame ? null : projected,
      contentIdentity: false,
    };
  }

  function candidateViews(
    candidate: Record<string, unknown>,
  ): (atom: Atom) => unknown {
    const views = new Map<string, unknown>();
    const indexed = indexStamps(candidate);
    return (atom) => {
      if (views.has(atom.key)) return views.get(atom.key);
      let view: unknown;
      if (atom.nodeId === undefined) {
        const field = atom.fragment.container;
        view = field
          ? candidate[field] === undefined
            ? atom.fragment.body
            : cloneValue(candidate[field])
          : undefined;
      } else {
        const node = indexed.get(atom.nodeId);
        if (!node) {
          view = atom.domain === "tool" ? OMIT : undefined;
        } else if (isOmitted(node)) {
          view = OMIT;
        } else if (atom.domain === "tool") {
          const tool = canonicalizeTool(node);
          if (atom.fragment.shape === "shell" && atom.fragment.memberKey) {
            tool[atom.fragment.memberKey] = [];
          }
          view = tool;
        } else {
          const message = canonicalizeMessage(node, family);
          view = isEmptiedHolder(message) ? OMIT : message;
        }
      }
      views.set(atom.key, view);
      return view;
    };
  }

  function candidateInjections(
    candidate: Record<string, unknown>,
    ids: ReadonlySet<string>,
  ): Map<string, { before: unknown[]; after: unknown[] }> {
    const map = new Map<string, { before: unknown[]; after: unknown[] }>();
    const ensure = (key: string) => {
      const found = map.get(key);
      if (found) return found;
      const created = { before: [] as unknown[], after: [] as unknown[] };
      map.set(key, created);
      return created;
    };
    anchorList(historyOf(candidate), itemAtoms(), ensure, ids);
    anchorList(
      envelopeOf(candidate),
      envelopeAtoms().filter((atom) => atom.fragment.shape !== "field"),
      ensure,
      ids,
    );
    for (const container of toolContainerList(candidate)) {
      anchorList(
        container.entries,
        toolAtoms().filter((atom) => atom.fragment.container === container.id),
        ensure,
        ids,
      );
    }
    return map;
  }

  function anchorList(
    entries: unknown[],
    owned: Atom[],
    ensure: (key: string) => { before: unknown[]; after: unknown[] },
    ids: ReadonlySet<string>,
  ): void {
    if (owned.length === 0) return;
    let last = owned[0].key;
    let seen = false;
    const owners = new Map<number, Atom>();
    for (const atom of owned) {
      if (atom.nodeId !== undefined && !owners.has(atom.nodeId)) {
        owners.set(atom.nodeId, atom);
      }
    }
    for (const entry of entries) {
      const stamp = readStamp(entry);
      const match = stamp ? owners.get(stamp.id) : undefined;
      if (!match) {
        if (isPolicyInsert(entry, ids)) continue;
        const slot = seen ? "after" : "before";
        const key = seen ? last : owned[0].key;
        ensure(key)[slot].push(cloneValue(entry));
        continue;
      }
      seen = true;
      last = match.key;
    }
  }

  function canonicalResultIds(): string[] {
    return [...resultAtoms.keys()];
  }

  function planPolicy(
    records: ReadonlyMap<string, RewriteFragmentPair>,
    options: ProjectOptions,
    created: RewriteRecord[],
    material: CandidateMaterial,
  ): {
    splices: Map<string, unknown>;
    replayed: Set<string>;
    spliceHead?: string;
  } {
    const atomIds = new Set(canonicalResultIds());
    const indexed = options.heads?.splice
      ? readOverrides(family, records, options.heads.splice, [...atomIds])
      : new Map<string, unknown>();
    const effective = new Map(indexed);
    const updates: Array<{ id: string; content: unknown }> = [];
    const replayed = new Set<string>();
    const emissions = new Map<string, Map<string, unknown> | null>();
    bakedPolicy = new Map();
    for (const [id, content] of material.explicit) {
      const atom = resultAtoms.get(id);
      if (!atom || !records.has(atom.key)) {
        bakedPolicy.set(id, content);
        continue;
      }
      const current = effective.get(id);
      if (
        current !== undefined &&
        material.epoch(current) === material.epoch(content)
      ) {
        continue;
      }
      if (
        current === undefined &&
        recordedEmits(atom, records, id, content, emissions, material.epoch)
      ) {
        // The fragment already emits this admission. A later client resend
        // may change only the result text; that digest mismatch is covered
        // without writing a second splice.
        replayed.add(id);
        continue;
      }
      updates.push({ id, content });
      effective.set(id, content);
    }
    const splices = new Map<string, unknown>();
    for (const [id, content] of effective) {
      if (bakedPolicy.has(id)) continue;
      const key = spliceKey(family, id, material.epoch(content));
      const existing = records.get(key);
      if (existing) {
        splices.set(id, decodeSplice(existing));
        continue;
      }
      const payload: Payload = { v: 1, before: [], after: [], self: content };
      created.push(
        storePayload(key, Buffer.from(material.epoch(content), "hex"), payload),
      );
      splices.set(id, roundTrip(payload).self);
    }
    let spliceHead = options.heads?.splice;
    if (updates.length > 0) {
      spliceHead = writeSpliceIndex(
        family,
        records,
        spliceHead,
        updates,
        created,
        material.epoch,
      );
    }
    return { splices, replayed, spliceHead };
  }

  function commitInserts(
    inserts: readonly Insert[],
    records: ReadonlyMap<string, RewriteFragmentPair>,
    options: ProjectOptions,
    created: RewriteRecord[],
  ): Insert[] {
    return inserts.map((insert) => {
      const existing = records.get(insert.key);
      if (existing) {
        return {
          ...insert,
          message: decodePayload(existing).self,
        };
      }
      const message = withAuthoritative(insert.message, options);
      const payload: Payload = { v: 1, before: [], after: [], self: message };
      created.push(
        storePayload(insert.key, sha256(serialize(message)), payload),
      );
      return { ...insert, message: roundTrip(payload).self };
    });
  }

  function commitCache(
    material: CandidateMaterial,
    records: ReadonlyMap<string, RewriteFragmentPair>,
    created: RewriteRecord[],
  ): MarkerSite[] {
    if (!cacheKey || !sourceLayoutDigest) return [];
    const existing = records.get(cacheKey);
    if (existing) return decodeMarkers(existing);
    const layout = material.layout();
    const payload: Payload = { v: 1, before: [], after: [], self: layout };
    created.push(storePayload(cacheKey, sourceLayoutDigest, payload));
    const decoded = roundTrip(payload).self;
    return Array.isArray(decoded) ? (decoded as MarkerSite[]) : [];
  }

  function collectCandidateMarkers(
    candidate: Record<string, unknown>,
  ): MarkerSite[] {
    const sites: MarkerSite[] = [];
    for (const entry of historyOf(candidate)) {
      const record = asRecord(entry);
      const stamp = readStamp(entry);
      if (!record || !stamp) continue;
      const atom = stampToAtom.get(stamp.id);
      if (atom) noteMessageMarkers(record, atom, sites);
    }
    for (const block of envelopeOf(candidate)) {
      const record = asRecord(block);
      const stamp = readStamp(block);
      if (!record || !stamp) continue;
      const atom = stampToAtom.get(stamp.id);
      if (atom) noteMarker(record, atom, "", sites);
    }
    for (const container of toolContainerList(candidate)) {
      for (const tool of container.entries) {
        const record = asRecord(tool);
        const stamp = readStamp(tool);
        if (!record || !stamp) continue;
        const atom = stampToAtom.get(stamp.id);
        if (!atom) continue;
        noteMarker(record, atom, "", sites);
        noteNestedMarker(record, atom, sites);
        const group = groupInfo(record);
        if (!group) continue;
        for (const member of group.members) {
          const memberRecord = asRecord(member);
          const memberStamp = readStamp(member);
          if (!memberRecord || !memberStamp) continue;
          const memberAtom = stampToAtom.get(memberStamp.id);
          if (memberAtom) noteMarker(memberRecord, memberAtom, "", sites);
        }
      }
    }
    return sites;
  }

  function assemble(
    candidate: Record<string, unknown>,
    decisions: Map<string, Payload>,
    splices: Map<string, unknown>,
    inserts: Insert[],
    layout: MarkerSite[],
  ): Record<string, unknown> {
    const replacements = new Map<string, unknown>();
    const emitted = new Map<string, Record<string, unknown>>();
    const historyKey = family === "openai:responses" ? "input" : "messages";
    if (itemAtoms().some((atom) => atom.fragment.shape === "field")) {
      replacements.set(
        historyKey,
        emitField(itemAtoms()[0], decisions, splices),
      );
    } else if (itemAtoms().length > 0 || inserts.length > 0) {
      replacements.set(
        historyKey,
        emitHistory(decisions, splices, inserts, emitted),
      );
    }
    for (const field of ["system", "instructions"] as const) {
      const mine = envelopeAtoms().filter(
        (atom) => atom.fragment.container === field,
      );
      if (mine.length === 0) continue;
      replacements.set(field, emitEnvelope(mine, decisions, emitted));
    }
    const toolGroups = emitTools(decisions, emitted);
    for (const [container, value] of toolGroups) {
      if (container === "tools" || container === "additional_tools") {
        replacements.set(container, value);
      }
    }
    const request = applyReplacements(candidate, replacements, toolGroups);
    applyLayout(emitted, layout);
    return request;
  }

  function emitField(
    atom: Atom,
    decisions: Map<string, Payload>,
    splices: Map<string, unknown>,
  ): unknown {
    const payload = decisions.get(atom.key);
    if (!payload || payload.self === null || payload.self === undefined) {
      return applySpliceValue(
        cloneValue(atom.fragment.body),
        splices,
        splicesByIdentity,
      );
    }
    return applySpliceValue(
      cloneValue(payload.self),
      splices,
      splicesByIdentity,
    );
  }

  function emitHistory(
    decisions: Map<string, Payload>,
    splices: Map<string, unknown>,
    inserts: Insert[],
    emitted: Map<string, Record<string, unknown>>,
  ): unknown[] {
    const messages: unknown[] = [];
    const byAnchor = new Map<string, Insert[]>();
    for (const insert of inserts) {
      const group = byAnchor.get(insert.anchor) ?? [];
      group.push(insert);
      byAnchor.set(insert.anchor, group);
    }
    for (const insert of byAnchor.get("head") ?? []) {
      messages.push(cloneValue(insert.message));
    }
    for (const atom of itemAtoms()) {
      const payload = decisions.get(atom.key);
      if (!payload || payload.omit) continue;
      for (const entry of payload.before) messages.push(cloneValue(entry));
      const body = emittedBody(atom, payload, splices);
      if (isRecord(body)) emitted.set(atom.chainHash, body);
      messages.push(body);
      for (const entry of payload.after) messages.push(cloneValue(entry));
      for (const insert of byAnchor.get(atom.chainHash) ?? []) {
        messages.push(cloneValue(insert.message));
      }
    }
    return messages;
  }

  function emitEnvelope(
    mine: Atom[],
    decisions: Map<string, Payload>,
    emitted: Map<string, Record<string, unknown>>,
  ): unknown {
    if (mine.length === 1 && mine[0].fragment.shape === "field") {
      const payload = decisions.get(mine[0].key);
      if (!payload || payload.self === null || payload.self === undefined) {
        return cloneValue(mine[0].fragment.body);
      }
      return cloneValue(payload.self);
    }
    return mine.flatMap((atom) => {
      const payload = decisions.get(atom.key);
      if (!payload || payload.omit) return [];
      const body =
        payload.self === null || payload.self === undefined
          ? cloneValue(atom.fragment.body)
          : cloneValue(payload.self);
      if (isRecord(body)) emitted.set(atom.chainHash, body);
      return [...payload.before, body, ...payload.after];
    });
  }

  function emitTools(
    decisions: Map<string, Payload>,
    emitted: Map<string, Record<string, unknown>>,
  ): Map<string, unknown[]> {
    const groups = new Map<string, unknown[]>();
    const ensure = (id: string) => {
      const found = groups.get(id);
      if (found) return found;
      const created: unknown[] = [];
      groups.set(id, created);
      return created;
    };
    let open: { key: string; members: unknown[] } | undefined;
    for (const atom of toolAtoms()) {
      const payload = decisions.get(atom.key);
      if (!payload || payload.omit) continue;
      const container = atom.fragment.container;
      if (!container) continue;
      for (const entry of payload.before)
        ensure(container).push(cloneValue(entry));
      const body =
        payload.self === null || payload.self === undefined
          ? cloneValue(atom.fragment.body)
          : cloneValue(payload.self);
      if (!isRecord(body)) continue;
      emitted.set(atom.chainHash, body);
      if (atom.fragment.shape === "shell" && atom.fragment.memberKey) {
        body[atom.fragment.memberKey] = [];
        open = {
          key: atom.fragment.memberKey,
          members: body[atom.fragment.memberKey] as unknown[],
        };
        ensure(container).push(body);
        for (const entry of payload.after)
          ensure(container).push(cloneValue(entry));
        continue;
      }
      if (atom.fragment.inGroup && open) {
        open.members.push(body);
        continue;
      }
      open = undefined;
      ensure(container).push(body);
      for (const entry of payload.after)
        ensure(container).push(cloneValue(entry));
    }
    const head = decisions.get(toolHeadKey());
    if (head && Array.isArray(head.self)) ensure("tools").push(...head.self);
    return groups;
  }

  function emittedBody(
    atom: Atom,
    payload: Payload,
    splices: Map<string, unknown>,
  ): unknown {
    if (
      payload.contentIdentity ||
      payload.self === null ||
      payload.self === undefined
    ) {
      const base = cloneValue(atom.fragment.body);
      return substituteResults(
        base,
        splices,
        atom.fragment.body,
        splicesByIdentity,
      );
    }
    return substituteResults(
      cloneValue(payload.self),
      splices,
      atom.fragment.body,
      splicesByIdentity,
    );
  }

  function policyInserts(
    candidateBody: unknown,
    authorized: ReadonlySet<string>,
  ): Insert[] {
    const candidate = asRecord(candidateBody);
    if (!candidate) return [];
    if (authorized.size === 0) return [];
    const inserts: Insert[] = [];
    let anchor = "head";
    for (const entry of historyOf(candidate)) {
      const stamp = readStamp(entry);
      if (stamp) {
        const owned = itemById.get(stamp.id);
        if (owned) anchor = owned.chainHash;
        continue;
      }
      const id = toolResultIdOf(entry, family);
      if (!id || !authorized.has(id) || resultAtoms.has(id)) continue;
      inserts.push({
        key: `${family}:insert:${anchor}:${encodeURIComponent(id)}`,
        anchor,
        message: entry,
      });
    }
    return inserts;
  }

  function toolAtoms(): Atom[] {
    return domainAtoms.tool;
  }

  function itemAtoms(): Atom[] {
    return domainAtoms.item;
  }

  function envelopeAtoms(): Atom[] {
    return domainAtoms.envelope;
  }

  function toolHeadKey(): string {
    return `${family}:tool:head`;
  }

  function isPolicyInsert(entry: unknown, ids: ReadonlySet<string>): boolean {
    const id = toolResultIdOf(entry, family);
    if (!id || !ids.has(id)) return false;
    return !resultAtoms.has(id);
  }
}

function captureEnvelope(
  root: Record<string, unknown>,
  family: RewriteWireFamily,
  push: (domain: Domain, fragment: Fragment, structural: unknown) => Atom,
  tag: (node: object, chainHash: string, tool?: boolean) => number,
  markers: MarkerSite[],
): void {
  const field = family === "anthropic:messages" ? "system" : "instructions";
  if (family === "openai:chatCompletions") return;
  const value = root[field];
  // Empty source envelopes still own guidance injected by the renderer.
  if (
    value === undefined ||
    typeof value === "string" ||
    (Array.isArray(value) && value.length === 0)
  ) {
    const fragment = fieldFragment(field, value);
    push("envelope", fragment, fragment);
    return;
  }
  if (!Array.isArray(value)) fail("incompatible");
  for (const block of value) {
    const record = asRecord(block);
    if (!record) fail("incompatible");
    const body = canonicalizeBlock(record);
    const fragment: Fragment = {
      break: true,
      shape: "block",
      body,
      container: field,
    };
    const atom = push("envelope", fragment, fragment);
    const id = tag(record, atom.chainHash);
    atom.nodeId = id;
    noteMarker(record, atom.chainHash, "", markers);
  }
}

function captureHistory(
  root: Record<string, unknown>,
  family: RewriteWireFamily,
  push: (domain: Domain, fragment: Fragment, structural: unknown) => Atom,
  tag: (node: object, chainHash: string, tool?: boolean) => number,
  markers: MarkerSite[],
): void {
  if (family === "openai:responses" && typeof root.input === "string") {
    const fragment = fieldFragment("input", root.input);
    push("item", fragment, fragment);
    return;
  }
  const history = root[family === "openai:responses" ? "input" : "messages"];
  if (history === undefined) return;
  if (!Array.isArray(history)) fail("incompatible");
  for (const entry of history) {
    const record = asRecord(entry);
    if (!record) fail("incompatible");
    const body = canonicalizeMessage(record, family);
    const fragment: Fragment = { break: true, shape: "message", body };
    const structural = blankResults(body);
    const atom = push("item", fragment, structural);
    const id = tag(record, atom.chainHash);
    atom.nodeId = id;
    tagContentHolders(record, atom.chainHash, tag);
    noteMessageMarkers(record, atom.chainHash, markers);
  }
}

function captureTools(
  root: Record<string, unknown>,
  family: RewriteWireFamily,
  push: (domain: Domain, fragment: Fragment, structural: unknown) => Atom,
  tag: (
    node: object,
    chainHash: string,
    tool?: boolean,
    container?: string,
  ) => number,
  markers: MarkerSite[],
): void {
  for (const container of toolContainerList(root)) {
    if (
      family === "openai:responses" &&
      container.id.startsWith("input:") &&
      typeof root.input === "string"
    ) {
      continue;
    }
    for (const tool of container.entries) {
      const record = asRecord(tool);
      if (!record) fail("incompatible");
      const group = groupInfo(record);
      if (!group) {
        const body = canonicalizeTool(record);
        const fragment: Fragment = {
          break: true,
          shape: "tool",
          body,
          container: container.id,
        };
        const atom = push("tool", fragment, fragment);
        tag(record, atom.chainHash, true, container.id);
        atom.nodeId = stampId(record);
        noteMarker(record, atom.chainHash, "", markers);
        noteNestedMarker(record, atom.chainHash, markers);
        continue;
      }
      const shell = canonicalizeTool(record);
      shell[group.key] = [];
      const shellFragment: Fragment = {
        break: true,
        shape: "shell",
        body: shell,
        container: container.id,
        memberKey: group.key,
      };
      const shellAtom = push("tool", shellFragment, shellFragment);
      tag(record, shellAtom.chainHash, true, container.id);
      shellAtom.nodeId = stampId(record);
      for (const member of group.members) {
        const memberRecord = asRecord(member);
        if (!memberRecord) fail("incompatible");
        const body = canonicalizeTool(memberRecord);
        const fragment: Fragment = {
          break: false,
          shape: "tool",
          body,
          container: container.id,
          inGroup: true,
        };
        const atom = push("tool", fragment, fragment);
        tag(memberRecord, atom.chainHash, true, container.id);
        atom.nodeId = stampId(memberRecord);
        noteMarker(memberRecord, atom.chainHash, "", markers);
      }
    }
  }
}

const DOMAINS = ["item", "envelope", "tool"] as const;
const SCHEMA_KEYS = new Set([
  "input",
  "arguments",
  "parameters",
  "input_schema",
  "schema",
  "properties",
  "items",
  "additionalProperties",
  "$defs",
  "definitions",
]);
const OMIT = Symbol("omit");

type Domain = (typeof DOMAINS)[number];

type Fragment = {
  break: boolean;
  shape: "field" | "block" | "message" | "tool" | "shell";
  body: unknown;
  container?: string;
  memberKey?: string;
  inGroup?: boolean;
};

type Atom = {
  domain: Domain;
  key: string;
  chainHash: string;
  digest: Buffer;
  fragment: Fragment;
  nodeId?: number;
  toolResultIds: string[];
};

type MarkerSite = {
  atom: string;
  path: string;
  marker: unknown;
};

type Payload = {
  v: 1;
  before: unknown[];
  after: unknown[];
  self: unknown;
  omit?: boolean;
  contentIdentity?: boolean;
};

type Insert = {
  key: string;
  anchor: string;
  message: unknown;
};

type CandidateMaterial = {
  candidate: Record<string, unknown>;
  options: ProjectOptions;
  readKeys: readonly string[];
  inserts: readonly Insert[];
  viewFor: (atom: Atom) => unknown;
  injections: Map<string, { before: unknown[]; after: unknown[] }>;
  explicit: ReadonlyMap<string, unknown>;
  epoch: (content: unknown) => string;
  layout: () => MarkerSite[];
  tools: () => unknown[];
};

function spliceIdentity(entry: {
  id?: string;
  toolResultId?: string;
}): string | undefined {
  return entry.id ?? entry.toolResultId;
}

function explicitPolicy(
  options: ProjectOptions,
  atomIds: ReadonlySet<string>,
): Map<string, unknown> {
  const policy = new Map<string, unknown>();
  if (!options.toolResultUpdates?.size && !options.policySplices?.length) {
    return policy;
  }
  const byIdentity = new Map<string, string>();
  for (const id of atomIds) {
    const identity = resultIdentity(id);
    if (!byIdentity.has(identity)) byIdentity.set(identity, id);
  }
  const atomIdForPolicy = (id: string) =>
    atomIds.has(id) ? id : byIdentity.get(resultIdentity(id));
  for (const [id, content] of options.toolResultUpdates ?? []) {
    const atomId = atomIdForPolicy(id);
    if (atomId) policy.set(atomId, content);
  }
  for (const splice of options.policySplices ?? []) {
    const id = spliceIdentity(splice);
    const atomId = id ? atomIdForPolicy(id) : undefined;
    if (!atomId || !("content" in splice)) continue;
    policy.set(atomId, splice.content);
  }
  return policy;
}

function recordedEmits(
  atom: Atom,
  records: ReadonlyMap<string, RewriteFragmentPair>,
  id: string,
  content: unknown,
  emissions: Map<string, Map<string, unknown> | null>,
  epoch: (content: unknown) => string,
): boolean {
  if (!emissions.has(atom.key)) {
    const pair = records.get(atom.key);
    if (!pair) return false;
    const payload = decodePair(pair).payload;
    const source =
      payload.contentIdentity ||
      payload.self === null ||
      payload.self === undefined
        ? atom.fragment.body
        : payload.self;
    emissions.set(atom.key, payload.omit ? null : indexResultContents(source));
  }
  const contents = emissions.get(atom.key);
  if (!contents) return false;
  return epoch(contents.get(resultIdentity(id))) === epoch(content);
}

function indexResultContents(value: unknown): Map<string, unknown> {
  const contents = new Map<string, unknown>();
  walk(value, (node) => {
    const id = toolResultIdOf(node, undefined);
    const record = asRecord(node);
    if (!id || !record) return;
    const identity = resultIdentity(id);
    if (contents.has(identity)) return;
    const content =
      record.type === "function_call_output" ||
      record.type === "custom_tool_call_output"
        ? record.output
        : record.content;
    if (content !== undefined) contents.set(identity, content);
  });
  return contents;
}

function bakeResults(
  value: unknown,
  baked: ReadonlyMap<string, unknown>,
  byIdentity: ReadonlyMap<string, unknown>,
): unknown {
  if (baked.size === 0) return value;
  return substituteResults(cloneValue(value), baked, value, byIdentity);
}

function containerEntries(
  candidate: Record<string, unknown>,
  container: string,
): unknown[] {
  if (container === "toolConfig") {
    const tools = asRecord(candidate.toolConfig)?.tools;
    return Array.isArray(tools) ? tools : tools ? [tools] : [];
  }
  const value = candidate[container];
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? [value] : [];
}

function tagContentHolders(
  record: Record<string, unknown>,
  chainHash: string,
  tag: (node: object, chainHash: string) => number,
): void {
  if (record.type === "compaction") tag(record, chainHash);
  if (!Array.isArray(record.content)) return;
  for (const value of record.content) {
    const block = asRecord(value);
    if (!block) continue;
    if (isTextOrCompactionHolder(block) || block.type === "tool_result") {
      tag(block, chainHash);
    }
    if (block.type !== "tool_result" || !Array.isArray(block.content)) continue;
    for (const part of block.content) {
      const child = asRecord(part);
      if (child?.type === "text") tag(child, chainHash);
    }
  }
}

function isTextOrCompactionHolder(record: Record<string, unknown>): boolean {
  return (
    record.type === "text" ||
    record.type === "input_text" ||
    record.type === "output_text" ||
    record.type === "compaction"
  );
}

function fieldFragment(container: string, body: unknown): Fragment {
  return { break: true, shape: "field", body: cloneValue(body), container };
}

function noteMarker(
  record: Record<string, unknown>,
  atom: string,
  path: string,
  markers: MarkerSite[],
): void {
  const marker = takeMarker(record);
  if (marker) markers.push({ atom, path, marker });
}

function noteNestedMarker(
  record: Record<string, unknown>,
  atom: string,
  markers: MarkerSite[],
): void {
  for (const key of ["function", "custom", "toolSpec"] as const) {
    const nested = asRecord(record[key]);
    if (nested) noteMarker(nested, atom, key, markers);
  }
}

function noteMessageMarkers(
  record: Record<string, unknown>,
  atom: string,
  markers: MarkerSite[],
): void {
  noteMarker(record, atom, "", markers);
  const content = record.content;
  if (Array.isArray(content)) {
    content.forEach((block, index) => {
      const blockRecord = asRecord(block);
      if (blockRecord)
        noteMarker(blockRecord, atom, `content/${index}`, markers);
    });
  }
  const calls = record.tool_calls;
  if (Array.isArray(calls)) {
    calls.forEach((call, index) => {
      const callRecord = asRecord(call);
      if (callRecord)
        noteMarker(callRecord, atom, `tool_calls/${index}`, markers);
    });
  }
}

function historyOf(body: Record<string, unknown>): unknown[] {
  if (typeof body.input === "string") return [];
  if (Array.isArray(body.input)) return body.input;
  return Array.isArray(body.messages) ? body.messages : [];
}

function envelopeOf(body: Record<string, unknown>): unknown[] {
  if (Array.isArray(body.system)) return body.system;
  if (Array.isArray(body.instructions)) return body.instructions;
  return [];
}

function toolContainerList(
  body: Record<string, unknown>,
): Array<{ id: string; entries: unknown[] }> {
  const containers: Array<{ id: string; entries: unknown[] }> = [];
  for (const key of ["tools", "additional_tools"] as const) {
    if (body[key] !== undefined)
      containers.push({ id: key, entries: listOf(body[key]) });
  }
  const toolConfig = asRecord(body.toolConfig);
  if (toolConfig?.tools !== undefined) {
    containers.push({ id: "toolConfig", entries: listOf(toolConfig.tools) });
  }
  return containers;
}

function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? [value] : [];
}

function groupInfo(
  tool: Record<string, unknown>,
): { key: string; members: unknown[] } | undefined {
  if (tool.type === "namespace" && Array.isArray(tool.tools)) {
    return { key: "tools", members: tool.tools };
  }
  if (Array.isArray(tool.functionDeclarations)) {
    return { key: "functionDeclarations", members: tool.functionDeclarations };
  }
  return undefined;
}

function canonicalizeMessage(
  record: Record<string, unknown>,
  family: RewriteWireFamily,
): unknown {
  if (family === "openai:chatCompletions" && record.role === "tool") {
    return copyHolder(record, true);
  }
  return copyHolder(record, true);
}

function canonicalizeBlock(record: Record<string, unknown>): unknown {
  return copyHolder(record, true);
}

function canonicalizeTool(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return copyHolder(record, true) as Record<string, unknown>;
}

function retainedHolders(value: unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const entry of value) {
    const child = asRecord(entry);
    if (child && isOmitted(child)) continue;
    kept.push(child ? copyHolder(child, true) : cloneValue(entry));
  }
  return kept;
}

function isEmptiedHolder(view: unknown): boolean {
  const record = asRecord(view);
  if (!record) return false;
  return Object.keys(record).every((key) => key === "role" || key === "type");
}

function copyHolder(record: Record<string, unknown>, holder: boolean): unknown {
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(record)) {
    if (holder && key === "cache_control") continue;
    const value = record[key];
    if (SCHEMA_KEYS.has(key)) {
      out[key] = cloneValue(value);
      continue;
    }
    if (key === "function" || key === "custom" || key === "toolSpec") {
      const nested = asRecord(value);
      out[key] = nested ? copyHolder(nested, true) : cloneValue(value);
      continue;
    }
    if (
      key === "content" ||
      key === "tool_calls" ||
      key === "tools" ||
      key === "functionDeclarations"
    ) {
      if (!Array.isArray(value)) {
        out[key] = cloneValue(value);
        continue;
      }
      const kept = retainedHolders(value);
      if (kept.length === 0 && value.length > 0) continue;
      out[key] = kept;
      continue;
    }
    out[key] = cloneValue(value);
  }
  return out;
}

function blankResults(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => blankResults(entry));
  const record = asRecord(value);
  if (!record) return cloneValue(value);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(record)) {
    if (isResultContentKey(record, key)) {
      out[key] = null;
      continue;
    }
    out[key] = blankResults(record[key]);
  }
  return out;
}

function isResultContentKey(
  record: Record<string, unknown>,
  key: string,
): boolean {
  if (record.type === "tool_result" && key === "content") return true;
  if (
    (record.type === "function_call_output" ||
      record.type === "custom_tool_call_output") &&
    key === "output"
  ) {
    return true;
  }
  if (record.role === "tool" && key === "content") return true;
  return false;
}

function substituteResults(
  value: unknown,
  splices: ReadonlyMap<string, unknown>,
  source: unknown,
  byIdentity: ReadonlyMap<string, unknown>,
): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const id = toolResultIdOf(record, undefined);
  const spliced = id ? spliceContent(splices, id, byIdentity) : undefined;
  if (id && spliced !== undefined) {
    const content = cloneValue(spliced);
    if (record.role === "tool" || record.type === "tool_result")
      record.content = content;
    if (
      record.type === "function_call_output" ||
      record.type === "custom_tool_call_output"
    ) {
      record.output = content;
    }
  }
  if (
    Array.isArray(record.content) &&
    Array.isArray(asRecord(source)?.content)
  ) {
    record.content = record.content.map((entry) =>
      substituteResults(entry, splices, entry, byIdentity),
    );
  }
  return record;
}

function applySpliceValue(
  value: unknown,
  splices: ReadonlyMap<string, unknown>,
  byIdentity: ReadonlyMap<string, unknown>,
): unknown {
  return substituteResults(value, splices, value, byIdentity);
}

function resultIdsIn(value: unknown): string[] {
  const ids: string[] = [];
  walk(value, (node) => {
    const id = toolResultIdOf(node, undefined);
    if (id) ids.push(id);
  });
  return ids;
}

function toolResultIdOf(
  value: unknown,
  _family: RewriteWireFamily | undefined,
): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (record.type === "tool_result" && typeof record.tool_use_id === "string") {
    return record.tool_use_id;
  }
  if (
    (record.type === "function_call_output" ||
      record.type === "custom_tool_call_output") &&
    typeof record.call_id === "string"
  ) {
    return record.call_id;
  }
  if (record.role === "tool" && typeof record.tool_call_id === "string") {
    return record.tool_call_id;
  }
  return undefined;
}

function withAuthoritative(message: unknown, options: ProjectOptions): unknown {
  const copy = cloneValue(message);
  walk(copy, (node) => {
    const id = toolResultIdOf(node, undefined);
    if (!id || !options.toolResultUpdates?.has(id)) return;
    const record = asRecord(node);
    if (!record) return;
    const content = cloneValue(options.toolResultUpdates.get(id));
    if ("output" in record) record.output = content;
    else record.content = content;
  });
  return copy;
}

function authorizedIds(options: ProjectOptions): Set<string> {
  const ids = new Set<string>();
  for (const id of options.toolResultUpdates?.keys() ?? []) ids.add(id);
  for (const id of options.policyToolResultIds ?? []) ids.add(id);
  for (const splice of options.policySplices ?? []) {
    const id = spliceIdentity(splice);
    if (id) ids.add(id);
  }
  return ids;
}

function hasToolContainer(value: unknown): boolean {
  const record = asRecord(value);
  return record
    ? toolContainerList(record).some(
        (container) => container.entries.length > 0,
      )
    : false;
}

function untaggedTools(candidate: Record<string, unknown>): unknown[] {
  const tools: unknown[] = [];
  for (const container of toolContainerList(candidate)) {
    for (const tool of container.entries) {
      if (!readStamp(tool)) tools.push(canonicalizeTool(asRecord(tool) ?? {}));
    }
  }
  return tools;
}

function hasDomainRecord(
  records: ReadonlyMap<string, RewriteFragmentPair>,
  domain: Domain,
): boolean {
  for (const key of records.keys()) {
    if (key.includes(`:${domain}:`)) return true;
  }
  return false;
}

function applyReplacements(
  candidate: Record<string, unknown>,
  replacements: Map<string, unknown>,
  toolGroups: Map<string, unknown[]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(candidate)) {
    if (key === "toolConfig") {
      const config = asRecord(candidate.toolConfig);
      const tools = toolGroups.get("toolConfig");
      if (config && tools) {
        const copy = cloneValue(config) as Record<string, unknown>;
        copy.tools = tools;
        out.toolConfig = copy;
        continue;
      }
    }
    if (replacements.has(key)) {
      out[key] = replacements.get(key);
      continue;
    }
    out[key] = cloneValue(candidate[key]);
  }
  for (const [key, value] of replacements) {
    if (!(key in out)) out[key] = value;
  }
  if (Array.isArray(out.input)) {
    out.input = out.input.map((item, index) => {
      const tools = toolGroups.get(`input:${index}`);
      const record = asRecord(item);
      if (!tools || !record) return item;
      const copy = cloneValue(record) as Record<string, unknown>;
      copy.tools = tools;
      return copy;
    });
  }
  return out;
}

function applyLayout(
  emitted: Map<string, Record<string, unknown>>,
  layout: MarkerSite[],
): void {
  for (const site of layout) {
    const target = emitted.get(site.atom);
    if (!target || !site.marker || typeof site.marker !== "object") continue;
    setMarker(target, site.path, cloneValue(site.marker));
  }
}

function setMarker(
  target: Record<string, unknown>,
  path: string,
  marker: unknown,
): void {
  if (!path) {
    target.cache_control = marker;
    return;
  }
  const [head, index] = path.split("/");
  if (head === "function" || head === "custom" || head === "toolSpec") {
    const nested = asRecord(target[head]);
    if (nested) nested.cache_control = marker;
    return;
  }
  const list = target[head];
  const entry = Array.isArray(list) ? asRecord(list[Number(index)]) : undefined;
  if (entry) entry.cache_control = marker;
}

function collectStamps(value: unknown, found: number[]): void {
  const record = asRecord(value);
  if (!record) {
    if (!Array.isArray(value)) return;
    for (const entry of value) collectStamps(entry, found);
    return;
  }
  const stamp = readStamp(record);
  if (stamp) found.push(stamp.id);
  for (const key of Object.keys(record)) {
    if (SCHEMA_KEYS.has(key)) continue;
    collectStamps(record[key], found);
  }
}

function indexStamps(value: unknown): Map<number, Record<string, unknown>> {
  const map = new Map<number, Record<string, unknown>>();
  const visit = (node: unknown) => {
    const record = asRecord(node);
    const stamp = record ? readStamp(record) : undefined;
    if (record && stamp && !map.has(stamp.id)) map.set(stamp.id, record);
  };
  walk(value, visit);
  // Responses history lives on `input`, which is also a tool-argument schema
  // key and is otherwise skipped.
  const root = asRecord(value);
  if (Array.isArray(root?.input)) {
    for (const entry of root.input) walk(entry, visit);
  }
  return map;
}

function walk(value: unknown, visit: (node: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const key of Object.keys(record)) {
    if (SCHEMA_KEYS.has(key)) continue;
    walk(record[key], visit);
  }
}

function readStamp(value: unknown): { v: 1; id: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as { [rewriteOrigin]?: unknown })[rewriteOrigin];
  if (raw === undefined) return undefined;
  const record = asRecord(raw);
  if (!record || record.v !== 1 || typeof record.id !== "number")
    fail("incompatible");
  return { v: 1, id: record.id };
}

function stampId(value: object): number | undefined {
  return readStamp(value)?.id;
}

function storePayload(
  key: string,
  digest: Buffer,
  payload: Payload,
): RewriteRecord {
  const identity =
    payload.self === null &&
    payload.before.length === 0 &&
    payload.after.length === 0 &&
    !payload.omit &&
    !payload.contentIdentity;
  return {
    key,
    original: encodeOriginal(digest),
    rewritten: identity
      ? encodeKind(0x49)
      : payload.omit
        ? encodeKind(0x4f)
        : encodeProjected(payload),
  };
}

function roundTrip(payload: Payload): Payload {
  const record = storePayload("round", sha256("x"), payload);
  return decodePair(record).payload;
}

function decodePayload(pair: RewriteFragmentPair): Payload {
  return decodePair(pair).payload;
}

function decodeSplice(pair: RewriteFragmentPair): unknown {
  return decodePair(pair).payload.self;
}

function decodeMarkers(pair: RewriteFragmentPair): MarkerSite[] {
  const self = decodePair(pair).payload.self;
  return Array.isArray(self) ? (self as MarkerSite[]) : [];
}

function decodePair(pair: RewriteFragmentPair): {
  digest: Buffer;
  payload: Payload;
} {
  if (!Buffer.isBuffer(pair.original) || !Buffer.isBuffer(pair.rewritten)) {
    fail("incompatible");
  }
  assertHeader(pair.original);
  assertHeader(pair.rewritten);
  if (pair.original[4] !== 0x49 || pair.original.length !== 37)
    fail("incompatible");
  const digest = Buffer.from(pair.original.subarray(5, 37));
  const kind = pair.rewritten[4];
  if (kind === 0x49) {
    if (pair.rewritten.length !== 5) fail("incompatible");
    return { digest, payload: { v: 1, before: [], after: [], self: null } };
  }
  if (kind === 0x4f) {
    if (pair.rewritten.length !== 5) fail("incompatible");
    return {
      digest,
      payload: { v: 1, before: [], after: [], self: null, omit: true },
    };
  }
  if (kind !== 0x50 || pair.rewritten.length < 9) fail("incompatible");
  const length = pair.rewritten.readUInt32BE(5);
  if (pair.rewritten.length !== 9 + length) fail("incompatible");
  const parsed = parseJson(
    pair.rewritten.subarray(9, 9 + length).toString("utf8"),
  );
  const payload = asRecord(parsed);
  if (
    !payload ||
    payload.v !== 1 ||
    !Array.isArray(payload.before) ||
    !Array.isArray(payload.after)
  ) {
    fail("incompatible");
  }
  return {
    digest,
    payload: {
      v: 1,
      before: payload.before as unknown[],
      after: payload.after as unknown[],
      self: payload.self ?? null,
      omit: payload.omit === true,
      contentIdentity: payload.contentIdentity === true,
    },
  };
}

function encodeOriginal(digest: Buffer): Buffer {
  if (digest.length !== 32) fail("incompatible");
  return Buffer.concat([encodeKind(0x49), digest]);
}

function encodeKind(kind: number): Buffer {
  return Buffer.from([0x52, 0x50, 0x31, 1, kind]);
}

function encodeProjected(payload: Payload): Buffer {
  const json = Buffer.from(serialize(payload), "utf8");
  const header = Buffer.alloc(9);
  header.write("RP1", 0, "ascii");
  header[3] = 1;
  header[4] = 0x50;
  header.writeUInt32BE(json.length, 5);
  return Buffer.concat([header, json]);
}

function assertHeader(buffer: Buffer): void {
  if (
    buffer.length < 5 ||
    buffer[0] !== 0x52 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x31 ||
    buffer[3] !== 1
  ) {
    fail("incompatible");
  }
}

function rolling(
  prev: string | undefined,
  family: string,
  domain: Domain,
  material: string,
): string {
  return createHash("sha256")
    .update(family)
    .update("\u0000")
    .update(domain)
    .update("\u0000")
    .update(prev ?? "")
    .update("\u0000")
    .update(material)
    .digest("hex");
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

const SPLICE_FANOUT = 16;
const SPLICE_LEAF_MAX = 8;
const SPLICE_DEPTH_MAX = 64;

type SpliceLeafEntry = {
  id: string;
  epoch: string;
  key: string;
  content: unknown;
};

type SpliceIndexNode =
  | { v: 1; kind: "leaf"; entries: SpliceLeafEntry[] }
  | { v: 1; kind: "branch"; depth: number; slots: Array<string | null> };

function spliceIndexKey(family: string, hash: string): string {
  return `${family}:splice-index:${hash}`;
}

function spliceKey(family: string, id: string, epoch: string): string {
  return `${family}:splice:${encodeURIComponent(id)}:${epoch}`;
}

function nextSpliceKeys(
  family: string,
  records: ReadonlyMap<string, RewriteFragmentPair>,
  root: string | undefined,
  ids: readonly string[],
): string[] {
  if (!root) return [];
  const missing = new Set<string>();
  for (const id of ids) {
    const gap = firstMissingIndexKey(family, records, root, id);
    if (gap) missing.add(gap);
  }
  return [...missing];
}

function firstMissingIndexKey(
  family: string,
  records: ReadonlyMap<string, RewriteFragmentPair>,
  root: string,
  id: string,
): string | undefined {
  let hash: string | undefined = root;
  let depth = 0;
  while (hash) {
    if (depth > SPLICE_DEPTH_MAX) fail("incompatible");
    const key = spliceIndexKey(family, hash);
    if (!records.has(key)) return key;
    const node = readIndexNode(family, hash, records);
    if (node.kind === "leaf") return undefined;
    if (node.depth !== depth || node.slots.length !== SPLICE_FANOUT) {
      fail("incompatible");
    }
    hash = node.slots[nibbleAt(idDigest(id), depth)] ?? undefined;
    depth += 1;
  }
  return undefined;
}

function readOverrides(
  family: RewriteWireFamily,
  records: ReadonlyMap<string, RewriteFragmentPair>,
  root: string,
  ids: readonly string[],
): Map<string, unknown> {
  const overrides = new Map<string, unknown>();
  for (const id of ids) {
    if (firstMissingIndexKey(family, records, root, id)) fail("unrecorded");
    const entry = lookupOverride(family, records, root, id);
    if (!entry) continue;
    if (entry.epoch !== rewritePolicyEpoch(entry.content)) fail("incompatible");
    if (entry.key !== rewriteSpliceKey(family, id, entry.content)) {
      fail("incompatible");
    }
    overrides.set(id, entry.content);
  }
  return overrides;
}

function lookupOverride(
  family: string,
  records: ReadonlyMap<string, RewriteFragmentPair>,
  root: string,
  id: string,
): SpliceLeafEntry | undefined {
  let hash: string | undefined = root;
  let depth = 0;
  while (hash) {
    if (depth > SPLICE_DEPTH_MAX) fail("incompatible");
    const node = readIndexNode(family, hash, records);
    if (node.kind === "leaf") {
      return node.entries.find((entry) => entry.id === id);
    }
    hash = node.slots[nibbleAt(idDigest(id), depth)] ?? undefined;
    depth += 1;
  }
  return undefined;
}

function writeSpliceIndex(
  family: RewriteWireFamily,
  records: ReadonlyMap<string, RewriteFragmentPair>,
  root: string | undefined,
  updates: readonly { id: string; content: unknown }[],
  created: RewriteRecord[],
  epoch: (content: unknown) => string,
): string {
  const fresh: SpliceIndexNode[] = [];
  const local = new Map<string, SpliceIndexNode>();
  const load = (hash: string) =>
    local.get(hash) ?? readIndexNode(family, hash, records);
  const remember = (node: SpliceIndexNode) => {
    local.set(digestHex(node), node);
    fresh.push(node);
    return node;
  };
  let node = root ? load(root) : undefined;
  for (const update of updates) {
    const entry: SpliceLeafEntry = {
      id: update.id,
      epoch: epoch(update.content),
      key: spliceKey(family, update.id, epoch(update.content)),
      content: update.content,
    };
    node = insertOverride(node, entry, 0, load, remember);
  }
  const seen = new Set<string>();
  for (const createdNode of fresh) {
    const hash = digestHex(createdNode);
    if (seen.has(hash) || records.has(spliceIndexKey(family, hash))) continue;
    seen.add(hash);
    created.push(indexRecord(family, createdNode));
  }
  if (!node) fail("incompatible");
  return digestHex(node);
}

function insertOverride(
  node: SpliceIndexNode | undefined,
  entry: SpliceLeafEntry,
  depth: number,
  load: (hash: string) => SpliceIndexNode,
  remember: (node: SpliceIndexNode) => SpliceIndexNode,
): SpliceIndexNode {
  if (depth > SPLICE_DEPTH_MAX) fail("incompatible");
  if (!node || node.kind === "leaf") {
    const entries = (node?.entries ?? []).filter(
      (item) => item.id !== entry.id,
    );
    const same = node?.entries.find((item) => item.id === entry.id);
    if (same && same.epoch === entry.epoch && node) return node;
    const next = [...entries, entry].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    if (next.length <= SPLICE_LEAF_MAX || depth >= SPLICE_DEPTH_MAX) {
      return remember({ v: 1, kind: "leaf", entries: next });
    }
    return splitLeaf(next, depth, remember);
  }
  const slot = nibbleAt(idDigest(entry.id), depth);
  const childHash = node.slots[slot];
  const child = childHash ? load(childHash) : undefined;
  const updated = insertOverride(child, entry, depth + 1, load, remember);
  const updatedHash = digestHex(updated);
  if (updatedHash === childHash) return node;
  const slots = node.slots.slice();
  slots[slot] = updatedHash;
  return remember({ v: 1, kind: "branch", depth, slots });
}

function splitLeaf(
  entries: SpliceLeafEntry[],
  depth: number,
  remember: (node: SpliceIndexNode) => SpliceIndexNode,
): SpliceIndexNode {
  if (depth >= SPLICE_DEPTH_MAX) {
    return remember({ v: 1, kind: "leaf", entries });
  }
  const groups = new Map<number, SpliceLeafEntry[]>();
  for (const entry of entries) {
    const slot = nibbleAt(idDigest(entry.id), depth);
    const group = groups.get(slot) ?? [];
    group.push(entry);
    groups.set(slot, group);
  }
  const slots: Array<string | null> = Array.from(
    { length: SPLICE_FANOUT },
    () => null,
  );
  for (const [slot, group] of groups) {
    const child =
      group.length <= SPLICE_LEAF_MAX
        ? remember({ v: 1, kind: "leaf", entries: group })
        : splitLeaf(group, depth + 1, remember);
    slots[slot] = digestHex(child);
  }
  return remember({ v: 1, kind: "branch", depth, slots });
}

function indexRecord(family: string, node: SpliceIndexNode): RewriteRecord {
  const hash = digestHex(node);
  return storePayload(spliceIndexKey(family, hash), sha256(serialize(node)), {
    v: 1,
    before: [],
    after: [],
    self: node,
  });
}

function readIndexNode(
  family: string,
  hash: string,
  records: ReadonlyMap<string, RewriteFragmentPair>,
): SpliceIndexNode {
  const pair = records.get(spliceIndexKey(family, hash));
  if (!pair) fail("unrecorded");
  const self = decodePair(pair).payload.self;
  if (digestHex(self) !== hash || !isIndexNode(self)) fail("incompatible");
  return self;
}

function isIndexNode(value: unknown): value is SpliceIndexNode {
  const record = asRecord(value);
  if (!record || record.v !== 1) return false;
  if (record.kind === "leaf") return Array.isArray(record.entries);
  if (record.kind !== "branch") return false;
  return (
    typeof record.depth === "number" &&
    Array.isArray(record.slots) &&
    record.slots.length === SPLICE_FANOUT
  );
}

function idDigest(id: string): Buffer {
  return sha256(id);
}

function nibbleAt(hash: Buffer, depth: number): number {
  const byte = hash[depth >> 1] ?? 0;
  return (depth & 1) === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
}

function digestHex(value: unknown): string {
  return createHash("sha256").update(serialize(value), "utf8").digest("hex");
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("incompatible");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") fail("incompatible");
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serialize(entry)).join(",")}]`;
  }
  const record = asRecord(value);
  if (!record) fail("incompatible");
  const parts: string[] = [];
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${serialize(record[key])}`);
  }
  return `{${parts.join(",")}}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    fail("incompatible");
  }
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry));
  const record = asRecord(value);
  if (!record) return value;
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(record)) out[key] = cloneValue(record[key]);
  return out;
}

function snapshotValue(
  value: unknown,
  copies: WeakMap<object, unknown>,
): unknown {
  if (value && typeof value === "object" && copies.has(value)) {
    return copies.get(value);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    copies.set(value, out);
    for (const entry of value) out.push(snapshotValue(entry, copies));
    return Object.freeze(out);
  }
  if (Buffer.isBuffer(value)) {
    const out = Buffer.from(value);
    copies.set(value, out);
    return out;
  }
  const record = asRecord(value);
  if (!record) return value;
  const out: Record<string | symbol, unknown> = Object.create(null);
  copies.set(record, out);
  for (const key of Object.keys(record)) {
    out[key] = snapshotValue(record[key], copies);
  }
  // Canonical JSON drops these marks, but lazy candidate views still need them.
  for (const symbol of Object.getOwnPropertySymbols(record)) {
    out[symbol] = snapshotValue(
      (record as Record<symbol, unknown>)[symbol],
      copies,
    );
  }
  if (!Object.hasOwn(out, rewriteOrigin) && rewriteOrigin in record) {
    out[rewriteOrigin] = snapshotValue(
      (record as { [rewriteOrigin]?: unknown })[rewriteOrigin],
      copies,
    );
  }
  if (isOmitted(record)) markOmitted(out);
  return Object.freeze(out);
}

function stripSymbols(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) stripSymbols(entry);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const symbol of Object.getOwnPropertySymbols(record)) {
    delete (record as Record<symbol, unknown>)[symbol];
  }
  for (const key of Object.keys(record)) stripSymbols(record[key]);
}

function takeMarker(record: Record<string, unknown>): unknown | undefined {
  const marker = record.cache_control;
  if (!marker || typeof marker !== "object" || Array.isArray(marker))
    return undefined;
  return cloneValue(marker);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  if (Buffer.isBuffer(value)) return undefined;
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== undefined;
}

function isFamily(value: string): value is RewriteWireFamily {
  return (REWRITE_WIRE_FAMILIES as readonly string[]).includes(value);
}

function resultIdentity(id: string): string {
  return parseTrajectoryStamp(id)?.callId ?? id;
}

function indexResultIdentities(
  contents: ReadonlyMap<string, unknown>,
): Map<string, unknown> {
  const byIdentity = new Map<string, unknown>();
  for (const [id, content] of contents) {
    const identity = resultIdentity(id);
    if (!byIdentity.has(identity)) byIdentity.set(identity, content);
  }
  return byIdentity;
}

function spliceContent(
  splices: ReadonlyMap<string, unknown>,
  id: string,
  byIdentity: ReadonlyMap<string, unknown>,
): unknown | undefined {
  if (splices.has(id)) return splices.get(id);
  return byIdentity.get(resultIdentity(id));
}

function normalizeResultIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeResultIds(entry));
  }
  const record = asRecord(value);
  if (!record) return cloneValue(value);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(record)) {
    const field = record[key];
    if (
      (key === "tool_use_id" || key === "call_id" || key === "tool_call_id") &&
      typeof field === "string"
    ) {
      out[key] = parseTrajectoryStamp(field)?.callId ?? field;
      continue;
    }
    out[key] = normalizeResultIds(field);
  }
  return out;
}

function fail(code: RewriteProjectionErrorCode): never {
  throw new RewriteProjectionError(code);
}
