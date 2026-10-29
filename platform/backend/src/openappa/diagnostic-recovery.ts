import type { AppaWireFamily, DeclaredToolSpelling } from "./wire";

type ReportingCall = {
  name: string;
  arguments: string | object;
  namespace?: string;
};

/** A blocked conversation may infer reports, but cannot resume ordinary work. */
export function recoverDiagnosticTurn(params: {
  body: unknown;
  family: AppaWireFamily;
  refusal: string;
  tools: readonly DeclaredToolSpelling[];
  isAllowedCall: (call: ReportingCall) => boolean;
}): { resultIds: Set<string> } | undefined {
  if (!params.tools.length || !params.body || typeof params.body !== "object")
    return;
  const body = params.body as Record<string, unknown>;
  if (
    body.previous_response_id ||
    body.previous_message_id ||
    body.conversation
  )
    return;
  const key = params.family === "openai:responses" ? "input" : "messages";
  const history = body[key];
  if (!Array.isArray(history)) return;
  const instructions = history.filter(
    (item) => item?.role === "system" || item?.role === "developer",
  );
  const prompt = history.findLast((message) => {
    if (message?.role !== "user" || message.type === "agent_message")
      return false;
    const text = userText(message.content);
    // Client-authored child notifications are not a new user request.
    return (
      text.trim().length > 0 &&
      !/<(?:task_result|task-notification|task)(?=[\s>])/.test(text)
    );
  });
  const guidance = `[appa] OpenAPPA blocked this conversation. Earlier task history is withheld. Only reporting tools and their approval flow may run; ordinary work must remain blocked. Follow the user's intent, without requiring any special command wording. If the user wants to report the failure, wants OpenAPPA off for this session, or is frustrated, use yell. Do not include task content in a report.\n${params.refusal}`;
  const first = {
    role: "user",
    content:
      params.family === "openai:responses"
        ? [
            {
              type: "input_text",
              text: `${prompt ? userText(prompt.content) : ""}\n\n${guidance}`,
            },
          ]
        : `${prompt ? userText(prompt.content) : ""}\n\n${guidance}`,
  };
  const retained: unknown[] = [...instructions, first];
  const resultIds = new Set<string>();
  const callIds = new Set<string>();
  const start = prompt ? history.indexOf(prompt) + 1 : 0;
  for (const item of history.slice(start)) {
    if (!item || typeof item !== "object") continue;
    if (
      item.type === "function_call" &&
      params.isAllowedCall({
        name: item.name,
        namespace: item.namespace,
        arguments: item.arguments,
      })
    ) {
      callIds.add(item.call_id);
      retained.push(item);
    } else if (
      (item.type === "function_call_output" ||
        item.type === "custom_tool_call_output") &&
      callIds.has(item.call_id)
    ) {
      resultIds.add(item.call_id);
      retained.push(item);
    } else if (item.role === "tool" && callIds.has(item.tool_call_id)) {
      resultIds.add(item.tool_call_id);
      retained.push(item);
    } else if (item.role === "assistant" && Array.isArray(item.tool_calls)) {
      const calls = (
        item.tool_calls as Array<{
          id: string;
          function?: { name: string; arguments: string };
        }>
      ).filter(
        (call) =>
          call?.function &&
          params.isAllowedCall({
            name: call.function.name,
            arguments: call.function.arguments,
          }),
      );
      for (const call of calls) callIds.add(call.id);
      if (calls.length)
        retained.push({ role: "assistant", content: null, tool_calls: calls });
    } else if (Array.isArray(item.content)) {
      const content = (
        item.content as Array<{
          type?: string;
          id: string;
          name: string;
          input: object;
          tool_use_id: string;
        }>
      ).filter((part) => {
        if (
          item.role === "assistant" &&
          part?.type === "tool_use" &&
          params.isAllowedCall({ name: part.name, arguments: part.input })
        ) {
          callIds.add(part.id);
          return true;
        }
        if (
          item.role === "user" &&
          part?.type === "tool_result" &&
          callIds.has(part.tool_use_id)
        ) {
          resultIds.add(part.tool_use_id);
          return true;
        }
        return false;
      });
      if (content.length) retained.push({ role: item.role, content });
    }
  }
  const seenTools = new Set<string>();
  function filterTools(tools: unknown[], namespace?: string): unknown[] {
    const groups = new Map<string, Record<string, unknown>>();
    return tools.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const tool = value as Record<string, unknown>;
      if (
        tool.type === "namespace" &&
        typeof tool.name === "string" &&
        Array.isArray(tool.tools)
      ) {
        const children = filterTools(tool.tools, tool.name);
        if (!children.length) return [];
        const previous = groups.get(tool.name);
        if (previous) {
          (previous.tools as unknown[]).push(...children);
          return [];
        }
        const group = { ...tool, tools: children };
        groups.set(tool.name, group);
        return [group];
      }
      if (
        tool.type !== undefined &&
        tool.type !== "function" &&
        tool.type !== "custom"
      )
        return [];
      const name =
        (tool.function as { name?: string } | undefined)?.name ?? tool.name;
      const key = JSON.stringify([namespace, name]);
      if (
        seenTools.has(key) ||
        !params.tools.some(
          (spelling) =>
            spelling.name === name && spelling.namespace === namespace,
        )
      )
        return [];
      seenTools.add(key);
      const eager = { ...tool };
      delete eager.defer_loading;
      return [eager];
    });
  }
  // Loaded reporting tools must remain callable without replaying tool-search
  // outputs or depending on another discovery call in the blocked session.
  const declarations = [
    ...(Array.isArray(body.tools) ? body.tools : []),
    ...(Array.isArray(body.additional_tools) ? body.additional_tools : []),
    ...history.flatMap((item) =>
      (item?.type === "additional_tools" ||
        item?.type === "tool_search_output") &&
      Array.isArray(item.tools)
        ? item.tools
        : [],
    ),
  ];
  body.tools = filterTools(declarations);
  delete body.additional_tools;
  if (body.tool_choice)
    body.tool_choice =
      params.family === "anthropic:messages" ? { type: "auto" } : "auto";
  body[key] = retained;
  return { resultIds };
}

function userText(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part) => typeof part?.text === "string")
            .map((part) => part.text)
            .join("\n")
        : "";
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}
