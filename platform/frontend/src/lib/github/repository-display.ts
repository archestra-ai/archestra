import { getGithubWebOrigin } from "@archestra/shared";

/** Display public repository shorthand and Enterprise URLs without public avatar lookups for Enterprise owners. */
export function getRepositoryDisplay(
  repository: string,
  githubApiUrl?: string | null,
) {
  const input = repository.trim();
  try {
    const origin = new URL(getGithubWebOrigin(githubApiUrl ?? undefined));
    const firstSegment = input.split("/")[0];
    const hasHost =
      firstSegment.includes(".") ||
      firstSegment.includes(":") ||
      firstSegment.toLowerCase() === origin.host.toLowerCase();
    const url = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(input)
        ? input
        : hasHost
          ? `${origin.protocol}//${input}`
          : `${origin.origin}/${input}`,
    );
    const [owner = "", name = ""] = url.pathname.split("/").filter(Boolean);
    const repo = name.replace(/\.git$/, "");
    const isPublic =
      url.hostname === "github.com" || url.hostname === "www.github.com";
    const isHttp = url.protocol === "https:" || url.protocol === "http:";
    return {
      owner,
      label: `${isPublic ? "" : `${url.host}/`}${owner}/${repo}`,
      avatarUrl:
        isPublic && isHttp && owner && repo
          ? `https://github.com/${encodeURIComponent(owner)}.png`
          : undefined,
    };
  } catch {
    return { owner: "", label: input, avatarUrl: undefined };
  }
}
