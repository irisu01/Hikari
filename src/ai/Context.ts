import { Message, TextBasedChannel, ChannelType } from "discord.js";
import { Task, TaskType } from "../structures/ai/Task";
import { ChatCompletionRequestMessage } from "openai";
import { JSONUtil } from "../util/JSONUtil";
import { jsonrepair } from "jsonrepair";
import { Util } from "../util/Util";
import { Agent } from "./Agent";
import { ContextMemory } from "./ContextMemory";

export interface ContextEvent {
    text?: string;
    username?: string;
    message_id?: string;
    user_id?: string;
    attempts: number;
    action?: Task;
    memory?: {
        in?: string;
        out?: string;
        user?: string;
    }
}

export const IgnoreTaskTypes: TaskType[] = [
    TaskType.UploadImage
];

/**
 * An instance of a Discord channel, with context of everything that has happened in it.
 * 
 * TODO: this really needs a detailed explanation tbh
 */
export class Context {
    public channel: TextBasedChannel;
    public agent: Agent;
    public events: Set<ContextEvent>;
    public memories: ContextMemory;
    public ratelimited: boolean = false;
    public handling: boolean = false;
    public currentMessage: Message | undefined;

    constructor(agent: Agent, channel: TextBasedChannel) {
        this.agent = agent;
        this.channel = channel;
        this.events = new Set();
        this.memories = new ContextMemory(this);

        this.parse();
    }

    // TODO: Also split this up into multiple functions, and check if the bot starts reciting its own prompts
    async handleCompletion(prompts: ChatCompletionRequestMessage[], sendReply: boolean = false, model: string = this.agent.model): Promise<string> {
        return await new Promise(async (resolve, reject) => {
            this.agent.logger.debug("Agent: Creating AI completion request for", this.agent.logger.color.hex("#7dffbc")(prompts.length), "prompts");
            let completionStream: any;
            try {
                completionStream = (await this.agent.ai?.createChatCompletion({
                    model: model,
                    stream: true,
                    messages: prompts
                }, {
                    responseType: "stream"
                }))
                
            } catch (e: any) {
                if (e.response && e.response.status === 429) {
                    this.ratelimited = true;
                    const until = parseInt(e.response.headers["x-ratelimit-reset"]) - Date.now();

                    let rl: Message | undefined;
                    if (sendReply) {
                        rl = await this.currentMessage?.reply(`I'm being rate limited, please wait ${until}ms for a response, or try again later (wont read any messages until then)`);
                    }

                    this.agent.logger.warn("Agent: Rate limited, waiting", this.agent.logger.color.hex("#7dffbc")(until), "ms");

                    setTimeout(async () => {
                        this.ratelimited = false;

                        await rl?.delete();
                        resolve(await this.handleCompletion(prompts, sendReply ? false : sendReply, model));
                    }, until);
                } else {
                    this.agent.logger.error("Agent: Error while creating completion request:", e);

                    if (e.response) {
                        console.log(e.response)
                    }

                    reject(undefined);
                }
            }

            let result = "";
            let sentQueueMessage = false;
            let queueMessage: Message | undefined; ``
            // @ts-ignore
            // don't think there's a type for this lol 
            completionStream?.data.on("data", async (data: Buffer) => {
                if (data.includes("queue")) {
                    // Well Fuck
                    if (sentQueueMessage == false && sendReply == true) {
                        this.agent.logger.debug("Agent: Request has been enqueued, waiting for freedom before we can continue.");
                        queueMessage = await this.currentMessage?.reply(`(enqueued request, please wait for a response~)`);
                        sentQueueMessage = true;
                    }

                    return;
                }

                let values = data.toString().split("\n")
                    .filter((line) => line.trim() !== "");

                for (let value of values) {
                    if (value.startsWith("data: ")) {
                        value = value.replace("data: ", "");
                    }

                    // trim newlines
                    if (value === "[DONE]") {
                        // @ts-ignore
                        if (sentQueueMessage == true) {
                            await queueMessage?.delete();
                        }

                        if (result.includes("upstream error")) {
                            if (result.includes("server_error")) {
                                this.agent.logger.error("Agent: The OpenAI API is currently experiencing major issues, so we can't continue.");
                                this.agent.logger.error("Agent: Please try again later, or contact the developer if this issue persists.");

                                await this.currentMessage?.delete();
                            }

                            reject(undefined);
                            break;
                        }

                        this.agent.logger.trace("Agent: Request has been completed, returning result.");

                        completionStream?.data.destroy();
                        resolve(result);

                        break;
                    }

                    let json;
                    try {
                        json = JSON.parse(value);
                    } catch (e) {
                        completionStream?.data.destroy();
                        reject(result);

                        break;
                    }

                    this.agent.logger.trace("Agent: Recieved completion data:", this.agent.logger.color.hex("#ff7de3")(JSON.stringify(json)));

                    if (json.choices) {
                        json.choices.forEach((choice: any) => {
                            if (choice.delta.content) {
                                result += choice.delta.content;
                            }
                        });
                    }
                }

            })
        })
    }

    // TODO: Split this into multiple functions
    // <3
    async handle(message: Message, event?: ContextEvent, toEdit?: Message): Promise<ContextEvent | undefined> {
        event ??= await this.parseMessage(message);
        
        if (this.ratelimited || this.handling) {
            this.events.add(event);
            return;
        }

        this.currentMessage = message;
        this.handling = true;

        if (event.attempts === 0) {
            this.agent.logger.info(
                "Agent: Handling context",
                this.agent.logger.color.hex("#7dffbc")(message.channel.id),
                "for message",
                this.agent.logger.color.hex("#7dffbc")(message.id)
            );
            this.agent.logger.debug(
                "Agent: Event data:",
                this.agent.logger.color.hex("#ff7de3")(JSON.stringify(event))
            );
        }

        const prompts: ChatCompletionRequestMessage[] = [{
            role: "system",
            content: message.channel.type == ChannelType.DM ? this.agent.dm_prompt.replace("%user_name%", message.author.username) : this.agent.prompt
        }];

        this.events.forEach((event) => {
            prompts.push({
                role: (
                    !event.username
                    ? "system"
                    : event.username == this.agent.name
                    ? "assistant"
                    : "user"
                ),
                content: JSON.stringify(Util.omit(event, ["attempts"]))
            });
        });

        prompts.push({
            role: (
                !event.username
                ? "system"
                : event.username == this.agent.name
                ? "assistant"
                : "user"
            ),
            content: JSON.stringify(Util.omit(event, ["attempts"]))
        });

        await message.channel.sendTyping();

        let completion: string;
        try {
            completion = await this.handleCompletion(prompts, true);
        } catch (e) {
            if (e === undefined) {
                // Well, api's down.
                this.handling = false;
                return;
            }

            this.agent.logger.error("Agent: A response to the message", this.agent.logger.color.hex("#7dffbc")(message.id), "couldn't be generated, and encountered a critical problem.");
            this.agent.logger.error("Agent: Malformed result data:", this.agent.logger.color.hex("#ff7de3")(e));

            // We'll have to retry this one.
            event.attempts++;
            this.handling = false;
            
            return await this.handle(message, event);
        }

        if (completion.includes(", \"action\": undefined")) {
            // Remove it entirely
            completion = completion.replace(", \"action\": undefined", "");
        }

        // Attempt to parse the json
        let json = this.tryParse(completion);

        if (event.attempts > 5) {
            this.events.add(event);
            this.agent.logger.error("Agent: Couldn't properly handle a response to the message", this.agent.logger.color.hex("#7dffbc")(message.id), "after 5 attempts");
            return undefined;
        }

        if (!json) {
            // Malformed json.
            if (event.attempts === 0) {
                this.agent.client.logger.error("Agent: Couldn't properly handle a response to the message", this.agent.logger.color.hex("#7dffbc")(message.id), "so we will attempt doing so again.");
            }

            this.agent.logger.trace("Agent: Attempt", this.agent.logger.color.hex("#ffcb7d")(event.attempts), "of 5 at fixing the json for message", this.agent.logger.color.hex("#7dffbc")(message.id));

            try {
                const repaired = jsonrepair(completion);
                json = this.tryParse(repaired);

                if (!json) {
                    this.agent.logger.error("Agent: JSON repair failed for response to message", this.agent.logger.color.hex("#7dffbc")(message.id));
                    this.agent.logger.error("Agent: Malformed json:", this.agent.logger.color.hex("#7dffbc")(completion));

                    event.attempts++;
                    this.handling = false;

                    return await this.handle(message, event);
                }

                if (json.includes("\n")) {
                    json = json.split("\n")
                }

                if (Array.isArray(json)) {
                    // why is this even possible?
                    let objBuilder: any = {};

                    json.forEach((val) => {
                        if (val.username) {
                            objBuilder = {
                                ...val
                            }
                        } else if (val.type) {
                            objBuilder.action = val;
                        }
                    });
                }

                this.agent.logger.error("Agent: JSON repair apparently succeeded, continuing on.");
            } catch (err) {
                this.agent.logger.error("Agent: JSON repair failed for response to message", this.agent.logger.color.hex("#7dffbc")(message.id));
                this.agent.logger.error("Agent: Malformed json:", this.agent.logger.color.hex("#7dffbc")(completion));

                this.handling = false;
                event.attempts++;

                return await this.handle(message, event);
            }
        }

        // Quick fixes because the AI can be really fucking stupid
        if (json.action && typeof json.action === "string") {
            if (json.action == "null") {
                json.action = null;
            } else {
                let stringified = JSONUtil.tryParse(json.action);

                if (stringified) {
                    // this is rare but wow
                    json = stringified
                }

                if (json.parameters) {
                    json.action = {
                        type: json.action,
                        parameters: json.parameters
                    }

                    delete json.parameters;
                }
            }
        }

        const urls = json.action?.parameters?.url ?? json.action?.parameters?.urls;
        if (json.action?.type == "upload_image" && !urls) {
            this.agent.logger.warn("Agent: The AI tried to upload an image(s), but it didn't provide any urls.");
            this.agent.logger.debug("Agent: Action data:", this.agent.logger.color.hex("#ff7de3")(json.action));

            this.handling = false;
            return this.handle(message, event);
        }

        this.agent.logger.info("Agent: AI response to message", this.agent.logger.color.hex("#7dffbc")(message.id), "has been generated.");
        this.agent.logger.debug("Agent: Response data:", this.agent.logger.color.hex("#ff7de3")(completion));

        this.events.add(event);

        if (this.events.size > this.agent.client.configuration.bot.context_memory_limit) {
            const toRemove = this.events.size - this.agent.client.configuration.bot.context_memory_limit;
            
            let removed = 0;
            for (const event of this.events.values()) {
                if (removed == toRemove) {
                    break;
                }

                this.events.delete(event);
                removed++;
            }
        }

        if (json.memory) {
            const memory = this.memories.handle(json, message);

            if (memory) {
                this.agent.logger.trace("Agent: Memory data:", this.agent.logger.color.hex("#ff7de3")(JSON.stringify(memory)));

                this.events.add({
                    attempts: 0,
                    action: {
                        type: TaskType.GetMemory,
                        parameters: memory
                    }
                })
            }
        }

        if (json.action) {
            if (IgnoreTaskTypes.includes(json.action.type)) {
                this.agent.logger.debug("Agent: Response to message", this.agent.logger.color.hex("#7dffbc")(message.id), "had an instruction attached to it, but it was ignored.");
            } else {
                this.agent.logger.debug("Agent: Response to message", this.agent.logger.color.hex("#7dffbc")(message.id), "had an instruction attached to it");
                this.agent.logger.debug("Agent: Instruction data:", this.agent.logger.color.hex("#ff7de3")(JSON.stringify(json.action)));
                this.agent.logger.trace("Agent: Attempting to find a proper instruction handler to read them all.");

                const instructionHandler = this.agent.client.stores.get("instructions").find(x => x.taskType === json.action.type);

                if (instructionHandler) {

                    this.agent.logger.trace("Agent: Proper instruction handler found.");
                    const postEvent = await instructionHandler.handle(message, json.action as Task, this);

                    if (postEvent) {
                        this.agent.logger.debug("Agent: Instruction handler created a post event, so we're handling it now.");
                        this.agent.logger.debug("Agent: Instruction response data: ", this.agent.logger.color.hex("#ff7de3")(JSON.stringify(postEvent)));

                        postEvent.attempts = 1;
                        this.handling = false;

                        return await this.handle(message, postEvent);
                    } else {
                        this.agent.logger.debug("Agent: Instruction handler returned no data, so continuing on normally.");
                    }
                } else {
                    // Invalid action.
                    this.agent.logger.warn("Agent: An instruction was provided by the AI, but there is no instruction handler that supports it!");
                    this.agent.logger.warn("Agent: instruction data:", this.agent.logger.color.hex("#ff7de3")(JSON.stringify(json.action)));

                    json.action = null;
                }

                return await this.send(message, json as ContextEvent, toEdit);
            }
        }

        await this.send(message, json as ContextEvent, toEdit);

        return json as ContextEvent;
    }

    private async send(message: Message, event: ContextEvent, toEdit?: Message) {
        this.events.add(event);

        if (event.text && event.text.length > 0 && event.text !== "") {
            let content = event.text;

            // Get mentions from the message.
            // they're @Username, so we need to convert them to <@ID>
            const regex = /@(\w+)/;
            let matches = regex.exec(content);

            while (matches) {
                const user = this.agent.client.users.cache.find(x => x.username === matches?.[1]);

                if (user) {
                    content = content.replace(new RegExp(`@${user.username}`), `<@${user.id}>`);
                }
                
                matches = regex.exec(content);
            }

            if (toEdit) {
                toEdit.edit(content);
            } else {
                const urls = event.action?.parameters?.url ?? event.action?.parameters?.urls;
                if (urls) {
                    this.agent.logger.debug("Agent: Response to message", this.agent.logger.color.hex("#7dffbc")(message.id), "has an image(s) attached to it, so we're sending it as a file.");
                }

                let m: Message | undefined;
                try {
                    m = await message.reply({
                        content: content,
                        files: event.action && urls ? urls.map((x: string) => {
                            // get the file name out of the url
                            const fileName = x.split("/").pop();

                            return {
                                attachment: x,
                                name: fileName
                            }
                        }) : undefined
                    });
                } catch (e) {
                    this.handling = false;
                    this.agent.logger.error("Agent: AI failed to send message, likely due to an improper response.");

                    // It's fine to rehandle this message.
                    return await this.handle(message, event);
                }

                event.message_id = m.id;
                event.user_id = m.author.id;
            }
        }

        this.currentMessage = undefined;
        this.handling = false;
    }

    private tryParse(json?: string) {
        try {
            return JSON.parse(json ?? "");
        } catch (e) {
            return undefined;
        }
    }

    private async parseMessage(message: Message): Promise<ContextEvent> {
        const event: ContextEvent = {
            text: message.cleanContent,
            message_id: message.id,
            user_id: message.author.id,
            username: message.author.username,
            attempts: 0
        };

        if (message.attachments.size > 0) {
            const attachment = message.attachments.first();

            if (attachment?.name.endsWith(".png") || attachment?.name.endsWith(".jpg") || attachment?.name.endsWith(".jpeg")) {
                this.agent.logger.debug("Agent: Message", this.agent.logger.color.hex("#7dffbc")(message.id), "contains an image, so we're going to try to parse it.");

                const url = new URL("https://saucenao.com/search.php");
                url.search = new URLSearchParams({
                    api_key: this.agent.client.configuration.bot.keys.saucenao,
                    db: "999",
                    output_type: "2",
                    url: attachment.url
                }).toString();

                const naoResponse = await fetch(url, { method: "GET" });

                if (naoResponse.status !== 200) {
                    // todo: handle this?
                    return event;
                }

                const resJson = await naoResponse.json();
                const sortedResults = resJson.results.sort((a: any, b: any) => parseFloat(b.header.similarity) - parseFloat(a.header.similarity));
                const first = sortedResults[0];

                const similarity = parseFloat(first.header.similarity);
                let finalString = "";

                if (similarity >= 90 && first.data != null) {
                    let tags = await this.getTags(attachment.url, attachment.name);
                    finalString = await this.handleCompletion([{
                        role: "system",
                        content: this.agent.getPrompt("image_curator_prompt")
                    }, {
                        role: "user",
                        content: `${JSON.stringify(first.data)}${tags.length > 0 ? `\n\n${tags.join(", ")}` : ""}`
                    }], false, "gpt-3.5-turbo"); // Enforce gpt-3.5 because gpt-4 is expensive and this ain't rly that bulky of a request tbh
                } else {
                    const tags = await this.getTags(attachment.url, attachment.name);

                    if (tags.length > 0) {
                        finalString = await this.handleCompletion([{
                            role: "system",
                            content: this.agent.getPrompt("image_curator_prompt")
                        }, {
                            role: "user",
                            content: tags.join(", ")
                        }], false, "gpt-3.5-turbo"); // Enforce gpt-3.5 because gpt-4 is expensive and this ain't rly that bulky of a request tbh
                    }
                }

                event.action = {
                    type: TaskType.UploadImage,
                    parameters: {
                        query: finalString
                    }
                }
            } else {
                event.action = {
                    type: TaskType.UploadImage,
                    parameters: {
                        query: "You are unsure what this image is, as you can't find any characters or source material, or tell what it is."
                    }
                }
            }
        }

        return event;
    }

    private async getTags(url: string, filename: string) {
        this.agent.logger.debug("Agent: Getting tags for image", this.agent.logger.color.hex("#7dffbc")(url));

        const image = await fetch(url, { method: "GET" });
        const formData = new FormData();

        formData.append("format", "json");
        formData.append("file", await image.blob(), filename);

        const resp = await (await fetch("https://autotagger.donmai.us/evaluate", {
            method: "POST",
            body: formData
        })).json();

        const tags = [];

        for (const tag of Object.keys(resp[0].tags)) {
            if (tag.startsWith("rating:"))
                continue;

            const tagSimilarity = resp[0].tags[tag];

            if (tagSimilarity >= 0.5)
                tags.push(tag);
        }

        return tags;
    }

    private parse() {
        this.agent.logger.trace("Agent: Parsing the last", this.agent.logger.color.hex("#7dffbc")(this.agent.client.configuration.bot.context_memory_limit), "messages in the channel");
    }
}