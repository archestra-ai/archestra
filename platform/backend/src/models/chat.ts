import type { InputJsonValue } from "@prisma/client/runtime/library";
import type { ChatCompletionMessage } from "openai/resources";
import { PrismaClient } from "../database/generated/client";
import { interactionModel } from "./interaction";

const prisma = new PrismaClient();

export class ChatModel {
  async create() {
    const chat = await prisma.chat.create({
      data: {},
    });
    return chat;
  }

  async findById(id: string) {
    return await prisma.chat.findUnique({
      where: { id },
      include: { interactions: true },
    });
  }

  async getInteractions(chatId: string) {
    return await interactionModel.findByChatId(chatId);
  }

  async addInteraction(
    chatId: string,
    content: InputJsonValue | ChatCompletionMessage,
    tainted = false,
    taintReason?: string,
  ) {
    return await interactionModel.create({
      chatId,
      content: content as InputJsonValue,
      tainted,
      taintReason,
    });
  }

  async hasTaintedData(chatId: string): Promise<boolean> {
    const taintedCount = await prisma.interaction.count({
      where: {
        chatId,
        tainted: true,
      },
    });
    return taintedCount > 0;
  }

  async getTaintedInteractions(chatId: string) {
    return await interactionModel.findTaintedByChatId(chatId);
  }
}

export const chatModel = new ChatModel();
