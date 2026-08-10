import { describe, expect, it } from "vitest";
import {
  buildSkillManifestUri,
  buildSkillUri,
  isPlatformSkillUri,
  parseSkillUri,
} from "./skill-uri";

describe("buildSkillUri", () => {
  it("puts the skill name last, as SEP-2640 requires", () => {
    // A client must be able to read the skill's name off the URI without
    // fetching the manifest, so the name is always the final directory segment.
    expect(
      buildSkillManifestUri({
        scope: "shared",
        authorId: null,
        name: "refunds",
      }),
    ).toBe("skill://archestra/shared/refunds/SKILL.md");

    expect(
      buildSkillManifestUri({
        scope: "personal",
        authorId: "user-1",
        name: "refunds",
      }),
    ).toBe("skill://archestra/personal/user-1/refunds/SKILL.md");
  });

  it("distinguishes a personal skill from a shared one of the same name", () => {
    // Names are unique only within a visibility scope, so a user can hold a
    // personal `refunds` while an org `refunds` also exists.
    const personal = buildSkillManifestUri({
      scope: "personal",
      authorId: "user-1",
      name: "refunds",
    });
    const shared = buildSkillManifestUri({
      scope: "shared",
      authorId: null,
      name: "refunds",
    });

    expect(personal).not.toBe(shared);
  });

  it("refuses to build a personal URI without an author", () => {
    expect(() =>
      buildSkillUri({
        scope: "personal",
        authorId: null,
        name: "refunds",
        filePath: "",
      }),
    ).toThrow(/authorId/);
  });

  it("addresses supporting files as siblings of SKILL.md", () => {
    expect(
      buildSkillUri({
        scope: "shared",
        authorId: null,
        name: "pdf-processing",
        filePath: "references/FORMS.md",
      }),
    ).toBe("skill://archestra/shared/pdf-processing/references/FORMS.md");
  });

  it("returns the bare root when there is no file path", () => {
    expect(
      buildSkillUri({
        scope: "shared",
        authorId: null,
        name: "pdf-processing",
        filePath: "",
      }),
    ).toBe("skill://archestra/shared/pdf-processing");
  });
});

describe("isPlatformSkillUri", () => {
  it.each([
    "skill://archestra",
    "skill://archestra/shared/refunds/SKILL.md",
    "skill://archestra/personal/user-1/refunds/SKILL.md",
    // Reserved even when unparseable — the authority is claimed in every
    // state, so a malformed URI under it is ours to answer, not to forward.
    "skill://archestra/",
    "skill://archestra/unknown-scope/refunds/SKILL.md",
    "skill://archestra/shared/%zz/SKILL.md",
  ])("reserves %s", (uri) => {
    expect(isPlatformSkillUri(uri)).toBe(true);
  });

  it.each([
    "SKILL://archestra/shared/refunds/SKILL.md",
    "skill://Archestra/shared/refunds/SKILL.md",
    "Skill://ARCHESTRA/shared/refunds/SKILL.md",
    "SKILL://ARCHESTRA",
  ])("reserves %s despite its casing", (uri) => {
    // RFC 3986 makes scheme and authority case-insensitive, so these are the
    // same URI as ours to any normalizing client. Matching them exactly would
    // let a connected MCP server advertise this spelling in its own
    // resources/list and have the gateway proxy the read — serving
    // attacker-controlled instructions under the platform's own prefix.
    expect(isPlatformSkillUri(uri)).toBe(true);
  });

  it.each([
    // Empty userinfo, an empty port, and a trailing-dot host: authority
    // spellings a normalizing client collapses straight onto
    // `skill://archestra/shared/x/SKILL.md`. Verified against WHATWG `URL`,
    // whose `href` for the first three is exactly the canonical URI.
    "skill://@archestra/shared/x/SKILL.md",
    "skill://:@archestra/shared/x/SKILL.md",
    "skill://archestra:/shared/x/SKILL.md",
    "skill://archestra./shared/x/SKILL.md",
    // Same authority dressed up further: real userinfo and an explicit port.
    "skill://user:pass@archestra/shared/x/SKILL.md",
    "skill://archestra:8080/shared/x/SKILL.md",
    // Percent-encoded unreserved characters in the host. RFC 3986 §6.2.2.2
    // makes decoding these part of normalization, so every one of them is our
    // authority to a conforming client — including `%2E`, which decodes to the
    // trailing dot the line above already collapses.
    "skill://arch%65stra/shared/x/SKILL.md",
    "skill://%61rchestra/shared/x/SKILL.md",
    "skill://ARCH%45STRA/shared/x/SKILL.md",
    "skill://archestra%2E/shared/x/SKILL.md",
    // The encoding surviving alongside the other authority decorations.
    "skill://user@arch%65stra:8080/shared/x/SKILL.md",
  ])("reserves %s despite its authority spelling", (uri) => {
    // A prefix compare answered false for each of these, and false is the
    // answer that proxies the read to whichever connected server advertised
    // the URI — serving attacker-controlled skill instructions under the
    // platform's own trusted prefix. Reserved here, unparseable below, so the
    // gateway answers them not-found itself.
    expect(isPlatformSkillUri(uri)).toBe(true);
    expect(parseSkillUri(uri)).toBeNull();
  });

  it.each([
    "ui://some-app/index.html",
    "https://example.com/skill",
    "skill://other-registry/shared/refunds/SKILL.md",
    // Prefix-adjacent authorities that are NOT ours: the reservation ends at
    // the authority boundary, so a longer host name is someone else's.
    "skill://archestrafoo/shared/refunds/SKILL.md",
    "skill://archestra.example.com/shared/refunds/SKILL.md",
    // Our name sitting in the userinfo, not the host — a different authority
    // no matter how it is normalized.
    "skill://archestra@example.com/shared/refunds/SKILL.md",
    // Encoding that does NOT decode onto our authority. `%zz` is not an escape
    // at all, and `%2F` is a reserved character normalization must leave
    // encoded — so neither host is `archestra` under any spelling, and
    // reserving them would take a legitimate upstream resource off the wire.
    "skill://arch%zzstra/shared/refunds/SKILL.md",
    "skill://archestra%2Fshared/refunds/SKILL.md",
  ])("leaves %s to be proxied", (uri) => {
    expect(isPlatformSkillUri(uri)).toBe(false);
  });

  it("keeps the path case-sensitive", () => {
    // A mixed-case path is reserved but does not parse, so it is answered
    // not-found rather than resolving to a differently-cased skill.
    expect(
      isPlatformSkillUri("skill://archestra/SHARED/Refunds/SKILL.md"),
    ).toBe(true);
    expect(
      parseSkillUri("skill://archestra/SHARED/Refunds/SKILL.md"),
    ).toBeNull();
  });
});

describe("parseSkillUri", () => {
  it.each([
    {
      uri: "skill://archestra/shared/refunds/SKILL.md",
      expected: {
        scope: "shared",
        authorId: null,
        name: "refunds",
        filePath: "SKILL.md",
      },
    },
    {
      uri: "skill://archestra/personal/user-1/refunds/SKILL.md",
      expected: {
        scope: "personal",
        authorId: "user-1",
        name: "refunds",
        filePath: "SKILL.md",
      },
    },
    {
      uri: "skill://archestra/shared/pdf/templates/regional/eu.md",
      expected: {
        scope: "shared",
        authorId: null,
        name: "pdf",
        filePath: "templates/regional/eu.md",
      },
    },
    {
      uri: "skill://archestra/shared/pdf",
      expected: {
        scope: "shared",
        authorId: null,
        name: "pdf",
        filePath: "",
      },
    },
  ])("parses $uri", ({ uri, expected }) => {
    expect(parseSkillUri(uri)).toEqual(expected);
  });

  it.each([
    "ui://some-app/index.html",
    "https://example.com/skill",
    "skill://other-registry/shared/refunds/SKILL.md",
    "skill://archestra/unknown-scope/refunds/SKILL.md",
    "skill://archestra/shared",
    "skill://archestra/personal/user-1",
  ])("returns null for %s", (uri) => {
    // A gateway `resources/read` sees URIs for every scheme it proxies, so a
    // non-skill URI is ordinary traffic to pass along, not an error.
    expect(parseSkillUri(uri)).toBeNull();
  });

  it("round-trips names and authors needing percent-encoding", () => {
    const uri = buildSkillUri({
      scope: "personal",
      authorId: "user id/with slash",
      name: "skill-name",
      filePath: "references/a b.md",
    });

    expect(parseSkillUri(uri)).toEqual({
      scope: "personal",
      authorId: "user id/with slash",
      name: "skill-name",
      filePath: "references/a b.md",
    });
  });

  it.each([
    // Characters that are URI syntax (or invalid in a URI) when left raw: a
    // literal `%` that is not an escape, an already-escaped-looking sequence,
    // and `#`/`?`/space, which would terminate or corrupt the path.
    "references/100%.md",
    "references/a%20b.md",
    "notes #1.md",
    "faq?.md",
  ])("round-trips file path %s through an encoded URI", (filePath) => {
    const uri = buildSkillUri({
      scope: "shared",
      authorId: null,
      name: "pdf",
      filePath,
    });

    // The published URI must be RFC 3986-clean: raw `%`, `#`, `?`, and spaces
    // would be misparsed (or rejected) by any real URI parser.
    const path = uri.slice("skill://archestra/".length);
    expect(path).not.toMatch(/[ #?]/);
    expect(path).not.toMatch(/%(?![0-9A-Fa-f]{2})/);

    expect(parseSkillUri(uri)?.filePath).toBe(filePath);
  });

  it.each([
    // decodeURIComponent throws on these; the parser must answer "not ours",
    // not crash the gateway's read path.
    "skill://archestra/shared/%zz/SKILL.md",
    "skill://archestra/shared/refunds/100%",
    "skill://archestra/personal/%E0%A4%A/refunds/SKILL.md",
  ])("returns null for malformed percent-encoding in %s", (uri) => {
    expect(parseSkillUri(uri)).toBeNull();
  });

  it.each([
    // `%2F` decodes to the separator, so this named the same file as
    // `.../scripts/run.py`.
    "skill://archestra/shared/refunds/scripts%2Frun.py",
    // Empty segments are dropped, so these named the same file as
    // `.../shared/refunds/SKILL.md`.
    "skill://archestra/shared//refunds//SKILL.md",
    "skill://archestra/shared/refunds/SKILL.md/",
    // A needlessly-escaped character decodes to the same file name.
    "skill://archestra/shared/refunds/SKILL%2Emd",
    "skill://archestra/shared/re%66unds/SKILL.md",
  ])("returns null for the non-canonical spelling %s", (uri) => {
    // Parsing is many-to-one, building is canonical, so a spelling that does
    // not rebuild to itself would resolve to a real file while echoing a URI
    // `skills/list` never advertised — which a conforming host reads as the
    // skill having been tampered with. Refused rather than canonicalized, and
    // refused exactly like an unexposed skill, so it is no probing oracle.
    expect(parseSkillUri(uri)).toBeNull();
  });

  it("still resolves the canonical spelling of those URIs", () => {
    expect(parseSkillUri("skill://archestra/shared/refunds/SKILL.md")).toEqual({
      scope: "shared",
      authorId: null,
      name: "refunds",
      filePath: "SKILL.md",
    });
    expect(
      parseSkillUri("skill://archestra/shared/refunds/scripts/run.py"),
    ).toEqual({
      scope: "shared",
      authorId: null,
      name: "refunds",
      filePath: "scripts/run.py",
    });
  });

  it("returns null for a URI smuggling a null byte", () => {
    // A null byte can never match stored content and Postgres rejects it in
    // text parameters, so it must die here rather than inside the DB lookup.
    expect(parseSkillUri("skill://archestra/shared/refunds/%00.md")).toBeNull();
  });
});
