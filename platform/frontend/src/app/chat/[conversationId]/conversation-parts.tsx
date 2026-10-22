"use client";

import { provideResponseMarkdown } from "@/components/ai-elements/response";
import ResponseMarkdown from "@/components/ai-elements/response-markdown";
import { ChatMessages as Transcript } from "@/components/chat/chat-messages";
import { ChatMessages } from "../lazy-parts";

// A conversation's first screen is its transcript. The server renders the end
// of it into the HTML, so its code ships with this route instead of as chunks
// loaded after paint: loaded later, the transcript and its markdown would not
// be there when the page hydrates, and the server's content would drop to the
// plain fallback and back. The new-chat screen (/chat) does not load these.
ChatMessages.provide(Transcript);
provideResponseMarkdown({ default: ResponseMarkdown });

/** Ships the transcript and markdown modules with the conversation route. */
export function ConversationParts() {
  return null;
}
