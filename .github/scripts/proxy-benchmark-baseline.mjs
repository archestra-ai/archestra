import { renderSummary } from "../../platform/benchmarks/report.mjs";

export const benchmarkMarker = "<!-- archestra-llm-proxy-benchmark -->";
const payloadPrefix = "<!-- archestra-llm-proxy-benchmark-data:v1:";
const sha = /^[a-f0-9]{40}$/;
const platformTag = /^platform-v\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/;

export function isPlatformReleasePr(pr, repository) {
  return (
    pr?.head?.repo?.full_name === repository &&
    pr.head.ref.startsWith("release-please--branches--") &&
    pr.head.ref.endsWith("--components--platform")
  );
}

export function benchmarkPayload(summary, gitCommit) {
  // Base64 cannot terminate an HTML comment, even when artifact metadata is hostile.
  // Leave room for the rendered table within GitHub's 65,536-character limit.
  let json = JSON.stringify({ gitCommit, summary });
  if (Buffer.byteLength(json) > 24000)
    json = JSON.stringify({ gitCommit, summary: null });
  return `${payloadPrefix}${Buffer.from(json).toString("base64")} -->`;
}

export function readBenchmarkPayload(body) {
  if (typeof body !== "string" || body.length > 65536) return null;
  const encoded = body.match(
    /<!-- archestra-llm-proxy-benchmark-data:v1:([A-Za-z0-9+/=]+) -->/,
  );
  return encoded
    ? JSON.parse(Buffer.from(encoded[1], "base64").toString("utf8"))
    : null;
}

/**
 * The release a release PR compares with: on a `release/X.Y` branch its
 * previous `X.Y` stable release, otherwise the newest published release in
 * the base branch's history. Null when there is none.
 */
export async function findPreviousRelease({ github, context }) {
  const repo = context.repo;
  const source = context.payload.pull_request;
  const published = (
    await github.paginate(github.rest.repos.listReleases, {
      ...repo,
      per_page: 100,
    })
  )
    .filter(
      (release) =>
        !release.draft &&
        release.published_at &&
        platformTag.test(release.tag_name),
    )
    .sort((a, b) => b.published_at.localeCompare(a.published_at));
  // A stable release track (release/1.4) compares with its own previous
  // stable release. Its first release has none, so it compares with the
  // release it was cut from: the newest one in its history, whatever the
  // version. Main always compares with the newest release in its history,
  // so a new minor or major version still finds the last one.
  const track = source.base.ref.startsWith("release/")
    ? `platform-v${source.base.ref.slice(8)}.`
    : null;
  const sameTrack = (release) =>
    track && !release.prerelease && release.tag_name.startsWith(track);
  const releases = [
    ...published.filter(sameTrack),
    ...published.filter((release) => !sameTrack(release)),
  ];
  let previous = null;
  for (const release of releases) {
    const { data } = await github.rest.repos.compareCommits({
      ...repo,
      base: release.tag_name,
      head: source.base.sha,
    });
    if (data.status === "ahead" || data.status === "identical") {
      previous = release;
      break;
    }
  }
  return previous;
}

/**
 * The previous release's benchmark. `remeasured` is that release measured
 * again on this run's runner (benchmarks/remeasure-release.sh); it is used
 * when it names the release's own commit, so both sides share hardware.
 * Otherwise the metrics saved on the release's PR are used.
 */
export async function findReleaseBenchmark({ github, context, remeasured }) {
  const repo = context.repo;
  const missing = (reason) => ({ state: "missing", reason });
  try {
    const previous = await findPreviousRelease({ github, context });
    if (!previous)
      return {
        state: "first-run",
        reason:
          "First release benchmark: no earlier published platform release exists on this release track.",
      };
    const { data: commit } = await github.rest.repos.getCommit({
      ...repo,
      ref: previous.tag_name,
    });
    if (
      remeasured?.complete === true &&
      !remeasured.diagnostic &&
      remeasured.gitCommit === commit.sha &&
      (await platformTree({
        github,
        repo,
        treeSha: commit.commit.tree.sha,
      })) === remeasured.platformTree
    ) {
      renderSummary(remeasured); // Only validated numeric metrics may reach the comment.
      return {
        state: "available",
        tag: previous.tag_name,
        summary: remeasured,
        sameRunner: true,
      };
    }
    const pulls = await github.paginate(
      github.rest.repos.listPullRequestsAssociatedWithCommit,
      { ...repo, commit_sha: commit.sha, per_page: 100 },
    );
    const releasePr = pulls.find(
      (pr) =>
        pr.merged_at &&
        pr.merge_commit_sha === commit.sha &&
        isPlatformReleasePr(pr, `${repo.owner}/${repo.repo}`),
    );
    if (!releasePr)
      return missing(
        `Last release (${previous.tag_name}) has no associated merged platform release PR; its benchmark is unavailable.`,
      );
    const comments = await github.paginate(github.rest.issues.listComments, {
      ...repo,
      issue_number: releasePr.number,
      per_page: 100,
    });
    const saved = comments.find(
      (comment) =>
        comment.user?.type === "Bot" &&
        comment.body?.startsWith(benchmarkMarker),
    );
    if (!saved)
      return {
        state: "first-run",
        reason: `First recorded release benchmark: ${previous.tag_name} has no saved benchmark comment.`,
      };
    const payload = readBenchmarkPayload(saved.body);
    if (!payload)
      return missing(
        `Last release (${previous.tag_name}) has no saved machine-readable metrics. Older comments and expired workflow artifacts cannot supply a baseline.`,
      );
    if (!payload.summary?.complete)
      return missing(
        `Last release (${previous.tag_name}) has no successful complete benchmark record.`,
      );
    if (
      !sha.test(payload.gitCommit) ||
      payload.summary.gitCommit !== payload.gitCommit
    )
      return missing(
        `Last release (${previous.tag_name}) has stale benchmark data for a different release PR revision.`,
      );
    if (payload.gitCommit !== releasePr.head.sha) {
      const { data: changes } = await github.rest.repos.compareCommits({
        ...repo,
        base: payload.gitCommit,
        head: releasePr.head.sha,
      });
      // Generated tables/screenshots do not change the measured backend.
      // Reject truncated file lists and every execution/configuration change.
      if (
        changes.status !== "ahead" ||
        !changes.files?.length ||
        changes.files.length >= 300 ||
        changes.files.some(
          (file) =>
            !file.filename.startsWith("docs/") ||
            (file.previous_filename &&
              !file.previous_filename.startsWith("docs/")),
        )
      )
        return missing(
          `Last release (${previous.tag_name}) has stale benchmark data for a different release PR revision.`,
        );
    }
    renderSummary(payload.summary); // Only validated numeric metrics may reach the comment.
    // The saved tree must be the measured revision's. The release commit
    // itself can differ: the merge queue squashes the release PR on top of
    // whatever merged since its last update, and those changes are measured
    // by the next release instead.
    const { data: measured } = await github.rest.repos.getCommit({
      ...repo,
      ref: payload.gitCommit,
    });
    if (
      !sha.test(payload.summary.platformTree) ||
      payload.summary.platformTree !==
        (await platformTree({
          github,
          repo,
          treeSha: measured.commit.tree.sha,
        }))
    )
      return missing(
        `Last release (${previous.tag_name}) has saved metrics that do not match the revision they name.`,
      );
    return {
      state: "available",
      tag: previous.tag_name,
      summary: payload.summary,
    };
  } catch {
    return missing(
      "Last release benchmark could not be read or validated. Release lookup, saved metrics or API access may be unavailable; no older release is substituted.",
    );
  }
}

async function platformTree({ github, repo, treeSha }) {
  const { data: tree } = await github.rest.git.getTree({
    ...repo,
    tree_sha: treeSha,
  });
  return tree.tree.find(
    (entry) => entry.path === "platform" && entry.type === "tree",
  )?.sha;
}
