import { z } from "zod";

/**
 * The log row of one Realtime response. A session streams audio both ways
 * over a WebSocket; the log keeps the session settings the client asked for,
 * the transcripts, the usage of each `response.done`, and the model's spoken
 * audio up to the clip limit so the Logs page can play it.
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
  /** The response's spoken audio as 16-bit PCM, kept up to 2 MB so Logs can play it. */
  output_audio: z
    .object({
      format: z.literal("pcm16"),
      sample_rate: z.number().int().positive(),
      data: z.string(),
    })
    .optional(),
  /** "too_large" when the spoken audio passed the clip limit and was not kept. */
  output_audio_omitted: z.literal("too_large").optional(),
  /** Output items with their audio removed. */
  output: z.array(z.record(z.string(), z.unknown())).optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
});
