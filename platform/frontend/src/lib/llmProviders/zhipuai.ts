/**
 * ZhipuAI Interaction Utils
 *
 * ZhipuAI exposes an OpenAI-compatible API, so we reuse the OpenAI interaction class.
 * See: https://open.bigmodel.cn/dev/api
 */
import OpenAiChatCompletionInteraction from "./openai";

class ZhipuaiChatCompletionInteraction extends OpenAiChatCompletionInteraction {}

export default ZhipuaiChatCompletionInteraction;
