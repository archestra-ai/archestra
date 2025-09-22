import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import CloudProviderModel from '@backend/models/cloudProvider';
import log from '@backend/utils/logger';

const speechPlugin: FastifyPluginAsync = async (fastify) => {
  // Register multipart support for file uploads
  await fastify.register(require('@fastify/multipart'));

  fastify.post(
    '/api/speech/transcribe',
    {
      schema: {
        consumes: ['multipart/form-data'],
        response: {
          200: z.object({
            text: z.string(),
          }),
          400: z.object({
            error: z.string(),
          }),
          500: z.object({
            error: z.string(),
          }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        log.info('Received speech transcription request');

        // Get the uploaded audio file
        const data = await (request as any).file();
        if (!data) {
          return reply.status(400).send({ error: 'No audio file provided' });
        }

        log.info(`Received audio file: ${data.filename}, mimetype: ${data.mimetype}`);

        // Use GPT-4o for speech transcription (Whisper API)
        const speechModel = 'gpt-4o';
        const providerConfig = await CloudProviderModel.getProviderConfigForModel(speechModel);

        if (!providerConfig) {
          return reply.status(400).send({
            error: 'OpenAI provider not configured. Please configure OpenAI in Settings → Cloud Providers.'
          });
        }

        const { apiKey, provider } = providerConfig;
        const baseUrl = provider.baseUrl || 'https://api.openai.com/v1';

        // Convert file buffer to FormData for OpenAI API
        const audioBuffer = await data.toBuffer();
        const formData = new FormData();

        // Create a blob from the buffer
        const audioBlob = new Blob([audioBuffer], { type: data.mimetype || 'audio/webm' });
        formData.append('file', audioBlob, data.filename || 'recording.webm');
        formData.append('model', 'whisper-1');

        log.info('Sending audio to OpenAI Whisper API');

        // Call OpenAI Whisper API directly
        const response = await fetch(`${baseUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
          body: formData,
        });

        if (!response.ok) {
          const errorText = await response.text();
          log.error(`OpenAI API error: ${response.status} - ${errorText}`);
          return reply.status(500).send({
            error: `Transcription failed: ${response.status} ${response.statusText}`
          });
        }

        const result = await response.json();
        const transcription = result.text || '';

        log.info(`Transcription successful: "${transcription.slice(0, 100)}..."`);

        return reply.send({ text: transcription });

      } catch (error) {
        log.error('Speech transcription error:', error);
        return reply.status(500).send({
          error: 'Internal server error during transcription'
        });
      }
    }
  );
};

export default speechPlugin;