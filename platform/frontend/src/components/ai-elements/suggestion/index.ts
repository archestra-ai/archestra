"use client";

import {
  Suggestion,
  type SuggestionProps,
  Suggestions as RootSuggestions,
  type SuggestionsProps,
} from "./suggestion";

export type { SuggestionProps, SuggestionsProps };

export const Suggestions = Object.assign(RootSuggestions, {
  Item: Suggestion,
});
