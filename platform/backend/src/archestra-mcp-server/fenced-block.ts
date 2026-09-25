// Wrap arbitrary content in a markdown code fence that content cannot close.
export function fencedBlock(content: string, lang = ""): string {
  // Iterate instead of spreading matches into Math.max: large documents can
  // exceed the call-argument limit.
  let longestBacktickRun = 0;
  for (const match of content.matchAll(/`+/g)) {
    if (match[0].length > longestBacktickRun)
      longestBacktickRun = match[0].length;
  }
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${lang}\n${content}\n${fence}`;
}
