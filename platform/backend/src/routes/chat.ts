import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CreateChatResponseSchema,
  GetChatResponseSchema,
  GetChatsResponseSchema,
} from "../database";
import ChatModel from "../models/chat";
import { ChatIdSchema, ErrorResponseSchema } from "./schemas";

const chatRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/chats",
    {
      schema: {
        operationId: "createChat",
        description: "Create a new chat session",
        tags: ["Chat"],
        response: {
          200: CreateChatResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const chat = await ChatModel.create();
      return reply.send(chat);
    },
  );

  fastify.get(
    "/api/chats",
    {
      schema: {
        operationId: "getChats",
        description: "Get all chats",
        tags: ["Chat"],
        response: {
          200: GetChatsResponseSchema,
        },
      },
    },
    async (_, reply) => {
      const chats = await ChatModel.findAll();
      return reply.send(chats);
    },
  );

  fastify.get(
    "/api/chats/:chatId",
    {
      schema: {
        operationId: "getChat",
        description: "Get chat by ID",
        tags: ["Chat"],
        params: z.object({
          chatId: ChatIdSchema,
        }),
        response: {
          200: GetChatResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { chatId } }, reply) => {
      const chat = await ChatModel.findById(chatId);

      if (!chat) {
        return reply.status(404).send({ error: "Chat not found" });
      }

      return reply.send(chat);
    },
  );
};

export default chatRoutes;
