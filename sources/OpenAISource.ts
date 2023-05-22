import { Source, Prompt } from "../src/structures/Source";
import { SourceType } from "../src/util/Constants";
import { Agent } from "../src/ai/Agent";
import { SourceError, SourceErrorType, SourceErrorData } from "../src/util/errors/SourceError";
import { Configuration, OpenAIApi, ChatCompletionRequestMessage, ChatCompletionRequestMessageRoleEnum } from "openai";
import { Message } from "discord.js";

export class OpenAISource extends Source {
    private ai: OpenAIApi;
    
    constructor(context: Source.Context) {
        super(context, {
            name: "openai",
            title: "OpenAISource",
            type: SourceType.OpenAI
        });

        const { client: { agent: { openaiConfig } } } = this.container;
        this.ai = new OpenAIApi(openaiConfig);
    }

    async prompt(prompts: Prompt[], message: Message, model?: string): Promise<string | Promise<string>> {
        // TODO: we should NOT be handling the OpenAI source here.
        //       The OpenAI source should be handled in this class instead.
        const { client: { agent, configuration } } = this.container;

        model ??= configuration.bot.ai.model ?? "gpt-3.5-turbo";

        return await new Promise(async (resolve, reject) => {
            this.logger.debug("Creating AI completion request for", this.logger.color.hex("#7dffbc")(prompts.length), "prompts");
            let completionStream: any;

            try {
                let cleanPrompts = prompts.map((p) => {
                    return {
                        content: p.content,
                        role: p.role as ChatCompletionRequestMessageRoleEnum
                    } satisfies ChatCompletionRequestMessage
                })

                completionStream = (await this.ai.createChatCompletion({
                    model: model ?? "gpt-3.5-turbo",
                    stream: true,
                    messages: cleanPrompts
                }, {
                    responseType: "stream"
                }));
            } catch (e: any) {
                if (e.response && e.response.status === 429) {
                    const until = parseInt(e.response.headers["x-ratelimit-reset"]) - Date.now();

                    this.logger.warn("Rate limited, waiting", this.logger.color.hex("#ff7de3")(until), "ms.");
                    return reject(new SourceError(SourceErrorType.Ratelimited, { until }));
                }
            }

            let result = "";
            let queued = false;
            let queueMessage: Message | undefined;

            completionStream?.data.on("data", async (data: Buffer) => {
                let values = data.toString().split("\n")
                    .filter((line) => line.trim() !== "");

                for (let value of values) {
                    if (value.startsWith("data: ")) {
                        value = value.replace("data: ", "");
                    }

                    if (value.includes("queue")) {
                        if (queued == false) {
                            queued = true;
                            queueMessage = await message.channel.send("<enqueued prompt, please wait for a response...>");
                        }

                        continue;
                    }

                    if (value === "[DONE]") {
                        // check if we've sent the queue message, and delete it if it exists
                        if (result.includes("upstream error")) {
                            await queueMessage?.delete();
                            
                            if (result.includes("server_error")) {
                                this.logger.error("The OpenAI API is currently experiencing major issues, so we can't continue.")
                                this.logger.error("Please try again later, or contact the developer if this issue persists.");

                                return reject(new SourceError(SourceErrorType.InternalError, {
                                    message: "The OpenAI API is currently experiencing major issues, so we can't continue."
                                }));
                            }

                            return reject(undefined);
                        }

                        this.logger.trace("Request has been completed, returning result.");

                        await queueMessage?.delete();
                        completionStream?.data.destroy();
                        return resolve(result);
                    }

                    let json: any;

                    try {
                        json = JSON.parse(value);
                    } catch (e: any) {
                        completionStream?.data.destroy();
                        await queueMessage?.delete();

                        return reject(new SourceError(SourceErrorType.MalformedResponse, {
                            data: e.message
                        }));
                    }

                    this.logger.trace("Received completion data:", this.logger.color.hex("#ff7de3")(JSON.stringify(json)));

                    if (json.choices) {
                        json.choices.forEach((choice: any) => {
                            if (choice.delta.content) {
                                result += choice.delta.content;
                            }
                        })
                    }
                }
            })
        });
    }

    
}