/** Root-session guidance must not become a delegated child's output contract. */
export const OPENCODE_HANDOFF_PLUGIN = `import { readFileSync } from "node:fs";

export const RuntimeHandoff = async ({ client, directory }) => ({
  async "experimental.chat.system.transform"(input, output) {
    if (!input.sessionID) return;
    try {
      const result = await client.session.get({
        path: { id: input.sessionID },
        query: { directory },
        throwOnError: true,
      });
      const session = result.data;
      // Use native lineage, not agent names or the presence of tools.
      if (result.error || !session || session.id !== input.sessionID || session.parentID != null) return;
      const prompt = new URL(import.meta.url);
      prompt.pathname = prompt.pathname.replace(/\\.handoff\\.mjs$/, ".prompt.md");
      const instructions = readFileSync(prompt, "utf8");
      if (instructions.trim() && !output.system.includes(instructions)) output.system.push(instructions);
    } catch {
      // Optional startup guidance is omitted if root identity cannot be confirmed.
    }
  },
});
`;
