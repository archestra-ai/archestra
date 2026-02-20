import { redirect } from "next/navigation";

export default function LlmApiKeysRedirect() {
  redirect("/llm-proxies/provider-settings");
}
