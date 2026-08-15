import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSkillManifest } from "./parser";
import {
  buildSkillPublicationArtifacts,
  composeSkillManifest,
  computeFileDigest,
  parseFrontmatterBlob,
} from "./skill-manifest-serializer";

interface TestSkill {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  allowedTools: string | null;
  metadata: Record<string, string>;
}

function makeSkill(overrides: Partial<TestSkill> = {}): TestSkill {
  return {
    name: "pdf-processing",
    description: "Extract, fill, and assemble PDF documents",
    license: null,
    compatibility: null,
    allowedTools: null,
    metadata: {},
    ...overrides,
  };
}

/**
 * The published bytes for a skill: what the write path stores as the
 * frontmatter blob, composed with the body exactly as a read does.
 */
function serializeSkillManifest(params: {
  skill: TestSkill;
  body: string;
}): string {
  return composeSkillManifest({
    frontmatterBlob: buildSkillPublicationArtifacts({
      ...params.skill,
      content: params.body,
    }).frontmatterBlob,
    body: params.body,
  });
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

describe("serializeSkillManifest", () => {
  it("emits a golden byte sequence for a fully-populated skill", () => {
    // Pins the exact published bytes. This test failing is the intended alarm
    // for a YAML-library or field-order change: it means every skill's digest
    // would move on its next write, so the change must be deliberate.
    const manifest = serializeSkillManifest({
      skill: makeSkill({
        license: "Apache-2.0",
        compatibility: "requires python 3.11",
        allowedTools: "read_file write_file",
        metadata: { version: "2.1.0", owner: "platform" },
      }),
      body: "# Heading\n\nDo the thing.",
    });

    expect(manifest).toBe(
      [
        "---",
        "name: pdf-processing",
        "description: Extract, fill, and assemble PDF documents",
        "license: Apache-2.0",
        "compatibility: requires python 3.11",
        "allowed-tools: read_file write_file",
        "metadata:",
        "  owner: platform",
        "  version: 2.1.0",
        "---",
        "",
        "# Heading",
        "",
        "Do the thing.",
        "",
      ].join("\n"),
    );
  });

  it("omits absent optional fields rather than emitting nulls", () => {
    const manifest = serializeSkillManifest({
      skill: makeSkill(),
      body: "Body.",
    });

    expect(manifest).toBe(
      [
        "---",
        "name: pdf-processing",
        "description: Extract, fill, and assemble PDF documents",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    );
  });

  it("is stable across metadata insertion order", () => {
    // Two writes of the same logical map must not differ by key order, or the
    // digest would churn without the skill changing.
    const a = serializeSkillManifest({
      skill: makeSkill({ metadata: { b: "2", a: "1" } }),
      body: "Body.",
    });
    const b = serializeSkillManifest({
      skill: makeSkill({ metadata: { a: "1", b: "2" } }),
      body: "Body.",
    });

    expect(a).toBe(b);
    expect(sha256(a)).toBe(sha256(b));
  });

  it("does not wrap long descriptions", () => {
    // Width-based folding would make a description's rendering depend on its
    // length, so an unrelated edit could reflow (and re-digest) the manifest.
    const description = `Extract data ${"and reassemble documents ".repeat(20)}now`;
    const manifest = serializeSkillManifest({
      skill: makeSkill({ description }),
      body: "Body.",
    });

    expect(manifest).toContain(`description: ${description}\n`);
  });

  it("never emits Archestra-internal frontmatter fields", () => {
    // `templated`/`agent` drive Archestra-side activation behaviour and are not
    // agentskills.io fields; the skill types that use them are not published at
    // all, so they must not appear even if a caller passes them through.
    const manifest = serializeSkillManifest({
      skill: {
        ...makeSkill(),
        ...({ templated: true, agentName: "refund-processor" } as object),
      },
      body: "Body.",
    });

    expect(manifest).not.toContain("templated");
    expect(manifest).not.toContain("agent");
  });

  it("round-trips back through the parser", () => {
    const skill = makeSkill({
      license: "MIT",
      allowedTools: "read_file",
      metadata: { version: "1.0.0" },
    });
    const body = "# Title\n\nInstructions here.";

    const parsed = parseSkillManifest(serializeSkillManifest({ skill, body }));

    expect(parsed.name).toBe(skill.name);
    expect(parsed.description).toBe(skill.description);
    expect(parsed.license).toBe("MIT");
    expect(parsed.allowedTools).toBe("read_file");
    expect(parsed.metadata).toEqual({ version: "1.0.0" });
    expect(parsed.content).toBe(body);
  });
});

describe("parseFrontmatterBlob", () => {
  it("reads back exactly the fields the served manifest carries", () => {
    // SEP-2640 lets a host verify the listing's `frontmatter` against the
    // fetched SKILL.md. Both are derived from the stored blob, so reading it
    // back must reproduce the manifest's fields field-for-field.
    const skill = makeSkill({
      license: "Apache-2.0",
      allowedTools: "read_file",
      metadata: { version: "2.1.0" },
    });
    const { frontmatterBlob } = buildSkillPublicationArtifacts({
      ...skill,
      content: "Body.",
    });

    const parsed = parseSkillManifest(
      serializeSkillManifest({ skill, body: "Body." }),
    );

    expect(parseFrontmatterBlob(frontmatterBlob)).toEqual({
      name: parsed.name,
      description: parsed.description,
      license: parsed.license,
      "allowed-tools": parsed.allowedTools,
      metadata: parsed.metadata,
    });
  });

  it("yields empty frontmatter for a blob that is not a mapping", () => {
    // A listing degrades to an empty frontmatter rather than failing the whole
    // page: the manifest bytes are still served and still match their digest.
    expect(parseFrontmatterBlob("- just\n- a list\n")).toEqual({});
    expect(parseFrontmatterBlob("name: [unterminated\n")).toEqual({});
  });
});

describe("buildSkillPublicationArtifacts", () => {
  it("digests exactly the bytes the stored blob composes into", () => {
    // The pair is written to `skills.frontmatter_blob` / `skills.digest` and
    // read back independently — the blob to serve, the digest to advertise — so
    // composing the stored blob must reproduce the digested bytes exactly.
    const skill = makeSkill({ license: "MIT", metadata: { team: "docs" } });
    const artifacts = buildSkillPublicationArtifacts({
      ...skill,
      content: "# Body\n\nDo the thing.",
    });

    const composed = composeSkillManifest({
      frontmatterBlob: artifacts.frontmatterBlob,
      body: "# Body\n\nDo the thing.",
    });
    expect(composed).toBe(
      serializeSkillManifest({ skill, body: "# Body\n\nDo the thing." }),
    );
    expect(artifacts.digest).toBe(sha256(composed));
  });
});

describe("digests", () => {
  it("hashes a base64 asset over its decoded bytes", () => {
    // A client receives the decoded bytes, so the digest must cover those and
    // not the storage encoding.
    const raw = "binary-ish payload";
    expect(
      computeFileDigest({
        content: Buffer.from(raw, "utf8").toString("base64"),
        encoding: "base64",
      }),
    ).toBe(computeFileDigest({ content: raw, encoding: "utf8" }));
  });
});
