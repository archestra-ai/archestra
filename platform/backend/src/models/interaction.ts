import { PrismaClient } from "../database/generated/client";

const prisma = new PrismaClient();

export class InteractionModel {
  async create(data: {
    chatId: string;
    content: any;
    tainted?: boolean;
    taintReason?: string;
  }) {
    return await prisma.interaction.create({
      data: {
        chatId: data.chatId,
        content: data.content,
        tainted: data.tainted ?? false,
        taintReason: data.taintReason,
      },
    });
  }

  async findByChatId(chatId: string) {
    return await prisma.interaction.findMany({
      where: { chatId },
      orderBy: { createdAt: "asc" },
    });
  }

  async findTaintedByChatId(chatId: string) {
    return await prisma.interaction.findMany({
      where: {
        chatId,
        tainted: true,
      },
      orderBy: { createdAt: "asc" },
    });
  }
}

export const interactionModel = new InteractionModel();
