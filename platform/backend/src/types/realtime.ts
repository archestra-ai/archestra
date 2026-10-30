import { z } from "zod";

/**
 * The log row of one Realtime response. A session streams audio both ways
 * over a WebSocket; the log keeps the session settings the client asked for,
 * the transcripts, and the usage of each `response.done`, never the audio.
 */
export const RealtimeInteractionRequestSchema = z.object({
  model: z.string(),
  /** 1 for the session's first response, counting up. */
  turn: z.number().int().positive(),
  /** The client's `session.update` settings, without audio data. */
  session: z.record(z.string(), z.unknown()).optional(),
  /** Text the client sent as user items for this turn (`conversation.item.create`). */
  input_text: z.string().optional(),
  /** Transcript of the audio the client sent for this turn, when OpenAI returned one. */
  input_transcript: z.string().optional(),
});

export const RealtimeInteractionResponseSchema = z.object({
  id: z.string(),
  status: z.string(),
  output_transcript: z.string().optional(),
  /** Output items with their audio removed. */
  output: z.array(z.record(z.string(), z.unknown())).optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
});
