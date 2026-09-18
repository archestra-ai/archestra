/** Display public repository shorthand and Enterprise URLs without public avatar lookups for Enterprise owners. */
export function getRepositoryDisplay(repository: string) {
  const input = repository.trim();
  const normalized = /^(?:www\.)?github\.com\//i.test(input)
    ? `https://${input}`
    : input;
  try {
    const url = new URL(
      /^[a-z][a-z\d+.-]*:/i.test(normalized)
        ? normalized
        : `https://github.com/${normalized}`,
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
