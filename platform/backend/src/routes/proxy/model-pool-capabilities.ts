import type { ModelInputModality } from "@archestra/shared";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import { classifyAzureModelCapabilities } from "@/services/azure-model-capabilities";
import { getTokenizer } from "@/tokenizers";
import { ApiError } from "@/types/api";
import { asRecord } from "@/utils/as-record";
import type { PlannedMember } from "./model-pool-failover";
import {
  type PoolWire,
  requestedMaxOutputTokens,
} from "./model-pool-transport";

/** Filter the final outbound request, after prompt/tool transformations. */
export async function compatiblePoolMembers(params: {
  members: PlannedMember[];
  wire: PoolWire;
  request: unknown;
}): Promise<PlannedMember[]> {
  if (params.wire === "openai-responses") {
    const body = asRecord(params.request);
    // Stored state belongs to one provider account. Affinity alone cannot
    // make that state available to another member during failover.
    if (
      body?.previous_response_id ||
      body?.conversation ||
      body?.background ||
      hasStoredResponsesReferences(body)
    )
      throw new ApiError(
        400,
        "Model pools require the complete Responses input history and synchronous execution; stored response, conversation, item, file, prompt, vector-store, container and skill references and background execution are not supported.",
      );
  }
  const requirements = requestRequirements(params.request, params.wire);
  const [models, azureRows] = await Promise.all([
    ModelModel.findByProviderModelIds(params.members),
    LlmProviderApiKeyModelLinkModel.findCapabilitiesForApiKeyModels([
      ...new Set(
        params.members
          .filter((m) => m.provider === "azure")
          .map((m) => m.providerApiKeyId),
      ),
    ]),
  ]);
  const compatible = params.members.filter((member) => {
    const model = models.get(`${member.provider}:${member.modelId}`);
    let modalities = model?.inputModalities;
    // Azure deployment aliases are resource-scoped. Never borrow another
    // resource's modalities, or use expired discovery evidence.
    if (member.provider === "azure") {
      const evidence = classifyAzureModelCapabilities(
        azureRows.find(
          (row) =>
            row.apiKeyId === member.providerApiKeyId &&
            row.model.modelId === member.modelId,
        ),
      );
      modalities =
        evidence.status === "known" ? evidence.inputModalities : null;
    }
    if (
      modalities?.length &&
      [...requirements.modalities].some((m) => !modalities.includes(m))
    )
      return false;
    // Discovery does not yet attach a context limit to Azure's scoped
    // evidence. A global deployment alias cannot establish that limit.
    const context =
      model && member.provider !== "azure"
        ? ModelModel.resolveEffectiveContextLength(model)
        : null;
    if (context) {
      const tokenizer = getTokenizer(member.provider, member.modelId);
      const input = requirements.text.reduce(
        (sum, content) =>
          sum + tokenizer.countTokens({ role: "user", content }),
        0,
      );
      if (input + requirements.outputTokens > context) return false;
    }
    // Unknown metadata remains eligible. Media token counts and remote file
    // contents cannot be estimated locally; the provider remains authoritative.
    return true;
  });
  if (!compatible.length)
    throw new ApiError(
      400,
      "No model pool member can accept this request's input types and estimated context size. Choose a compatible model or reduce the request.",
    );
  return compatible;
}

// === Internal helpers ===

/** Inspect protocol fields, never arbitrary function arguments or JSON schemas. */
function hasStoredResponsesReferences(
  body: Record<string, unknown> | undefined,
): boolean {
  if (asRecord(body?.prompt)?.id) return true;
  const containerHasState = (value: unknown): boolean => {
    const container = asRecord(value);
    return (
      typeof value === "string" ||
      Boolean(container?.container_id) ||
      (Array.isArray(container?.file_ids) && container.file_ids.length > 0) ||
      (Array.isArray(container?.skills) &&
        container.skills.some(
          (skill) => asRecord(skill)?.type === "skill_reference",
        ))
    );
  };
  const contentHasFile = (content: unknown): boolean =>
    Array.isArray(content) &&
    content.some((raw) => {
      const part = asRecord(raw);
      return (
        (part?.type === "input_file" || part?.type === "input_image") &&
        Boolean(part.file_id)
      );
    });
  if (
    Array.isArray(body?.input) &&
    body.input.some((raw) => {
      const item = asRecord(raw);
      return (
        item?.type === "item_reference" ||
        (item?.type === "computer_call_output" &&
          Boolean(asRecord(item.output)?.file_id)) ||
        (item?.type === "code_interpreter_call" &&
          Boolean(item.container_id)) ||
        (item?.type === "shell_call" && containerHasState(item.environment)) ||
        contentHasFile(item?.content) ||
        contentHasFile(item?.output)
      );
    })
  )
    return true;
  const toolsHaveState = (tools: unknown): boolean =>
    Array.isArray(tools) &&
    tools.some((raw) => {
      const tool = asRecord(raw);
      if (tool?.type === "namespace") return toolsHaveState(tool.tools);
      if (tool?.type === "file_search")
        return (
          Array.isArray(tool.vector_store_ids) &&
          tool.vector_store_ids.length > 0
        );
      if (tool?.type === "image_generation")
        return Boolean(asRecord(tool.input_image_mask)?.file_id);
      if (tool?.type === "code_interpreter")
        return containerHasState(tool.container);
      if (tool?.type === "shell") return containerHasState(tool.environment);
      return false;
    });
  return toolsHaveState(body?.tools);
}

type Requirements = {
  modalities: Set<ModelInputModality>;
  text: string[];
  outputTokens: number;
};

function requestRequirements(request: unknown, wire: PoolWire): Requirements {
  const body = asRecord(request) ?? {};
  const result: Requirements = {
    modalities: new Set(),
    text: [],
    outputTokens: requestedMaxOutputTokens(request) ?? 0,
  };
  const text = (value: unknown) => {
    if (typeof value === "string" && value.length) {
      result.text.push(value);
      result.modalities.add("text");
    }
  };
  const json = (value: unknown) => {
    if (value !== undefined) text(JSON.stringify(value));
  };
  const mime = (value: unknown) => {
    if (typeof value !== "string") return;
    if (value.startsWith("image/")) result.modalities.add("image");
    else if (value.startsWith("audio/")) result.modalities.add("audio");
    else if (value.startsWith("video/")) result.modalities.add("video");
    else if (value === "application/pdf") result.modalities.add("pdf");
  };
  const blocks = (value: unknown): void => {
    if (typeof value === "string") {
      text(value);
      return;
    }
    for (const raw of Array.isArray(value) ? value : []) {
      const block = asRecord(raw);
      if (!block) continue;
      text(block.text);
      if (
        wire === "openai-chat" ||
        wire === "anthropic" ||
        wire === "openai-responses"
      ) {
        if (
          block.type === "image_url" ||
          block.type === "image" ||
          block.type === "input_image"
        )
          result.modalities.add("image");
        if (block.type === "input_audio") result.modalities.add("audio");
        if (block.type === "video_url") result.modalities.add("video");
        if (block.type === "document") {
          const source = asRecord(block.source);
          mime(source?.media_type);
          if (source?.type === "text") text(source.data);
          if (source?.type === "content") blocks(source.content);
          // Anthropic URL documents are PDFs; text/content sources above are not.
          if (source?.type === "url") result.modalities.add("pdf");
        }
        if (block.type === "file") {
          const file = asRecord(block.file);
          const data = file?.file_data;
          if (typeof data === "string") mime(/^data:([^;,]+)/.exec(data)?.[1]);
          if (
            typeof file?.filename === "string" &&
            /\.pdf$/i.test(file.filename)
          )
            result.modalities.add("pdf");
        }
        if (block.type === "input_file") {
          if (typeof block.file_data === "string")
            mime(/^data:([^;,]+)/.exec(block.file_data)?.[1]);
          if (
            typeof block.filename === "string" &&
            /\.pdf$/i.test(block.filename)
          )
            result.modalities.add("pdf");
        }
        if (block.type === "function_call") {
          text(block.name);
          text(block.arguments);
        }
        if (block.type === "custom_tool_call") {
          text(block.name);
          text(block.input);
        }
        if (
          block.type === "function_call_output" ||
          block.type === "custom_tool_call_output"
        )
          blocks(block.output);
        if (block.type === "message" || block.role) blocks(block.content);
        if (block.type === "reasoning") blocks(block.summary);
        if (block.type === "tool_use") {
          text(block.name);
          json(block.input);
        }
        if (block.type === "tool_result") blocks(block.content);
        if (block.type === "thinking") text(block.thinking);
      } else if (wire === "gemini") {
        for (const key of [
          "inlineData",
          "inline_data",
          "fileData",
          "file_data",
        ]) {
          const media = asRecord(block[key]);
          mime(media?.mimeType ?? media?.mime_type);
        }
        text(asRecord(block.executableCode ?? block.executable_code)?.code);
        text(
          asRecord(block.codeExecutionResult ?? block.code_execution_result)
            ?.output,
        );
        json(block.functionCall ?? block.function_call);
        json(block.functionResponse ?? block.function_response);
      } else {
        const guard = asRecord(block.guardContent);
        text(asRecord(guard?.text)?.text);
        if (guard?.image) result.modalities.add("image");
        if (block.image) result.modalities.add("image");
        if (block.video) result.modalities.add("video");
        const document = asRecord(block.document);
        if (document?.format === "pdf") result.modalities.add("pdf");
        text(asRecord(document?.source)?.text);
        json(block.toolUse);
        const toolResult = asRecord(block.toolResult);
        if (toolResult) blocks(toolResult.content);
        json(block.json);
      }
    }
  };
  if (wire === "openai-responses") {
    text(body.instructions);
    blocks(body.input);
    json(body.tools);
  } else if (wire === "gemini") {
    for (const message of Array.isArray(body.contents) ? body.contents : [])
      blocks(asRecord(message)?.parts);
    blocks(asRecord(body.systemInstruction ?? body.system_instruction)?.parts);
    json(body.tools);
  } else {
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      const item = asRecord(message);
      blocks(item?.content);
      // OpenAI assistant tool calls carry arguments outside content.
      if (wire === "openai-chat") {
        json(item?.tool_calls);
        json(item?.function_call);
      }
    }
    blocks(body.system);
    json(wire === "bedrock-converse" ? body.toolConfig : body.tools);
  }
  return result;
}
