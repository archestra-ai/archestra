import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ChatModel } from "@/models";
import {
  ChatWithInteractionsSchema,
  ErrorResponseSchema,
  InsertChatSchema,
  SelectChatSchema,
  UuidIdSchema,
} from "@/types";

const chatRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/chats",
    {
      schema: {
        operationId: "createChat",
        description: "Create a new chat session",
        tags: ["Chat"],
        body: InsertChatSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }),
        response: {
          200: SelectChatSchema,
        },
      },
    },
    async (request, reply) => {
      const chat = await ChatModel.create(request.body);
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
          200: z.array(ChatWithInteractionsSchema),
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
          chatId: UuidIdSchema,
        }),
        response: {
          200: ChatWithInteractionsSchema,
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
