import { GROK_HTTP } from "./grok-http";

export const GROK_MODEL_DISCOVERY = `${GROK_HTTP}
${String.raw`
async function discoverGrokModel(options) {
  const credential = options.apiKey || process.env.XAI_API_KEY;
  if (!credential) throw new Error("Set XAI_API_KEY in this terminal or choose a provider-backed personal virtual key. MCP login and skills are saved; MCP authorization does not supply an LLM API key.");
  const endpoint = new URL(options.modelsUrl);
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search || !endpoint.pathname.endsWith("/models") || (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && (["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) || endpoint.hostname.endsWith(".localhost"))))) throw new Error("Automatic xAI discovery requires the approved HTTPS proxy models endpoint or a loopback development endpoint.");
  const read = async (url, headers) => {
    let response;
    try { response = await grokFetch(url, { headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000) }); }
    catch { throw new Error("Automatic xAI discovery is unavailable. No model was changed. Retry when online or choose an explicit model."); }
    if (!response.ok) throw new Error("Automatic xAI discovery failed (HTTP " + response.status + "). Check the local provider credential or choose an explicit model.");
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1048576) throw new Error("Automatic xAI discovery response exceeded its size limit.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  const docs = await read("https://docs.x.ai/developers/models.md");
  const recommendation = /^Code:\s*\[[^\]\n]+\]\(\/developers\/models\/([a-z0-9][a-z0-9.-]{0,100})\)/m.exec(docs)?.[1];
  if (!recommendation) throw new Error("xAI's current coding recommendation could not be verified. Choose an explicit model or retry after the documentation is available.");
  const headers = { ...options.headers, Authorization: "Bearer " + credential };
  const body = await read(endpoint.href, headers);
  let listing;
  try { listing = JSON.parse(body); } catch { throw new Error("xAI account model discovery returned invalid JSON. No model was changed."); }
  if (!Array.isArray(listing.data)) throw new Error("xAI account model discovery returned an unsupported format.");
  const textPricing = docs.split("### Text API Pricing")[1]?.split(/^### /m)[0] || "";
  const publicIds = new Set([...textPricing.matchAll(/^\|\s*(grok-[a-z0-9.-]+)(?:\s|\s*\|)/gm)].map(match => match[1]));
  publicIds.add(recommendation);
  const available = listing.data.filter(model => model && typeof model.id === "string" && /^[a-z0-9][a-z0-9.-]{0,100}$/.test(model.id) && publicIds.has(model.id) && !/(?:fast|image|imagine|audio|voice|embed|multi-agent)/i.test(model.id));
  const dated = available.filter(model => Number.isSafeInteger(model.created) && model.created > 0).sort((left, right) => right.created - left.created || left.id.localeCompare(right.id));
  const candidates = [...new Set([...(available.some(model => model.id === recommendation) ? [recommendation] : []), ...dated.map(model => model.id)])].slice(0, 6);
  for (const candidate of candidates) {
    const detail = await read("https://docs.x.ai/developers/models/" + candidate + ".md");
    const name = /\*\*Model name:\*\*\s*\x60([^\x60\r\n]+)\x60/.exec(detail)?.[1];
    if (name === candidate && /\*\*Function calling:\*\*\s*Yes\b/.test(detail) && /\*\*Modalities:\*\*[^\r\n]*text[^\r\n]*(?:→|->)\s*text/.test(detail)) return { model: candidate, recommendation, selectedBy: candidate === recommendation ? "official-coding-recommendation" : "available-release-timestamp", checkedAt: new Date().toISOString() };
  }
  throw new Error("No available xAI coding model could be verified from current recommendation, release timestamps and tool-calling capabilities. Choose an explicit model.");
}
`}`;
