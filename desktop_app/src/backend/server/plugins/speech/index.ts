import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import OpenAI from 'openai';

import CloudProviderModel from '@backend/models/cloudProvider';
import log from '@backend/utils/logger';

const TranscribeRequestSchema = z.object({
  audio: z.string().describe('Base64-encoded audio data'),
  mimeType: z.string().describe('Audio MIME type (e.g., audio/webm, audio/mp4)'),
});

const TranscribeResponseSchema = z.object({
  text: z.string().describe('Transcribed text from audio'),
});

const ErrorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
  }),
});

// Register schemas
z.globalRegistry.add(TranscribeRequestSchema, { id: 'TranscribeRequest' });
z.globalRegistry.add(TranscribeResponseSchema, { id: 'TranscribeResponse' });

const speechRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/api/speech/transcribe',
    {
      schema: {
        operationId: 'transcribeAudio',
        description: 'Transcribe audio to text using OpenAI Whisper',
        tags: ['Speech'],
        body: TranscribeRequestSchema,
        response: {
          200: TranscribeResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          402: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { audio, mimeType } = request.body as z.infer<typeof TranscribeRequestSchema>;

        // Get OpenAI API key from cloud provider config
        const openAIConfig = await CloudProviderModel.getByType('openai');

        if (!openAIConfig || !openAIConfig.enabled) {
          return reply.code(401).send({
            error: {
              message: 'OpenAI API key not configured. Please configure it in Settings > LLM Providers.',
            },
          });
        }

        const { apiKey } = openAIConfig;
        const baseUrl = 'https://api.openai.com/v1';

        // Initialize OpenAI client
        const openai = new OpenAI({
          apiKey,
          baseURL: baseUrl,
        });

        // Decode base64 audio
        const audioBuffer = Buffer.from(audio, 'base64');

        // Determine file extension from MIME type
        const mimeToExt: Record<string, string> = {
          'audio/webm': 'webm',
          'audio/webm;codecs=opus': 'webm',
          'audio/mp4': 'mp4',
          'audio/mpeg': 'mp3',
          'audio/wav': 'wav',
          'audio/x-wav': 'wav',
        };

        const extension = mimeToExt[mimeType] || 'webm';
        const fileName = `audio.${extension}`;

        // Create a File-like object for OpenAI API
        const audioFile = new File([audioBuffer], fileName, { type: mimeType });

        log.info(`Transcribing audio file: ${fileName}, size: ${audioBuffer.length} bytes`);

        // Call OpenAI Whisper API
        const transcription = await openai.audio.transcriptions.create({
          file: audioFile,
          model: 'whisper-1',
          language: 'en', // Can be made configurable later
        });

        log.info(`Transcription successful: ${transcription.text.substring(0, 100)}...`);

        return reply.send({
          text: transcription.text,
        });
      } catch (error: any) {
        log.error('Error transcribing audio:', error);

        if (error.status === 401) {
          return reply.code(401).send({
            error: {
              message: 'Invalid OpenAI API key. Please check your configuration.',
            },
          });
        }

        if (error.status === 402) {
          return reply.code(402).send({
            error: {
              message: 'OpenAI API quota exceeded. Please check your account limits.',
            },
          });
        }

        return reply.code(500).send({
          error: {
            message: error.message || 'Failed to transcribe audio',
          },
        });
      }
    }
  );
};

export default speechRoutes;
