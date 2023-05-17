import { Instruction, InstructionOptions } from "../src/structures/Instruction";
import { Task, TaskType } from "../src/structures/ai/Task";
import { Context, ContextEvent } from "../src/ai/Context";
import { PrismaClient } from "@prisma/client";
import { Piece } from "@sapphire/pieces";
import { Message } from "discord.js";

const prisma = new PrismaClient();

export class SaveMemoryInstruction extends Instruction {
    constructor(context: Piece.Context, options: InstructionOptions) {
        super(context, {
            ...options,
            taskType: TaskType.SaveMemory
        });
    }

    async handle(trigger: Message, event: Task, _context: Context): Promise<ContextEvent | undefined> {
        if (!event.parameters.data || !event.parameters.user) {
            return undefined;
        }

        const memory = await prisma.memory.create({
            data: {
                channel_id: trigger.channel.id,
                data: event.parameters
            }
        });

        return undefined;
    }
}