const zlib = require("zlib");
const {
    ApplicationIntegrationType,
    InteractionContextType,
    SlashCommandBuilder,
} = require("discord.js");

module.exports = {
    name: "logUploader",

    LOG_FILE_PATTERNS: [
        "latest.log",
        "debug.log",
        "crash",
        ".log",
        ".txt"
    ],

    isLogFile(name) {
        name = name.toLowerCase();
        return this.LOG_FILE_PATTERNS.some(p => name.includes(p));
    },

    async upload(text) {
        try {
            const res = await fetch("https://api.mclo.gs/1/log", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: text })
            });

            const data = await res.json();
            return data.url;
        } catch (e) {
            console.error("Upload failed:", e);
            return null;
        }
    },

    async readAttachment(attachment) {
        const name = attachment.name || "file";

        try {
            const res = await fetch(attachment.url);
            const buffer = Buffer.from(await res.arrayBuffer());

            if (name.toLowerCase().endsWith(".gz")) {
                return zlib.gunzipSync(buffer).toString("utf-8");
            }

            return buffer.toString("utf-8");
        } catch (e) {
            console.error("Failed to read attachment:", e);
            return null;
        }
    },

    async handleMessage(message, force = false) {
        if (!message.attachments.size) return;

        for (const attachment of message.attachments.values()) {
            const name = attachment.name || "file";

            const detectedLog = this.isLogFile(name);
            let content = null;

            if (detectedLog || force) {
                content = await this.readAttachment(attachment);
            }

            if (!detectedLog && !force) continue;
            if (typeof content !== "string") continue;

            try {
                await message.react("📃");
            } catch {}

            const url = await this.upload(content);

            if (!url) {
                await message.reply("Failed to upload");
                continue;
            }

            await message.reply(`${url}`);
        }
    },

    slash: {
        data: new SlashCommandBuilder()
            .setName("log")
            .setDescription("Upload a log file to mclo.gs")
            .setIntegrationTypes(
                ApplicationIntegrationType.GuildInstall,
                ApplicationIntegrationType.UserInstall,
            )
            .setContexts(
                InteractionContextType.Guild,
                InteractionContextType.BotDM,
                InteractionContextType.PrivateChannel,
            )
            .addAttachmentOption(option =>
                option
                    .setName("file")
                    .setDescription("Log file to upload")
                    .setRequired(true)
            ),

        async execute(interaction) {
            const attachment = interaction.options.getAttachment("file", true);

            await interaction.deferReply();

            const content = await module.exports.readAttachment(attachment);
            if (typeof content !== "string") {
                await interaction.editReply("Failed to read file");
                return;
            }

            const url = await module.exports.upload(content);
            if (!url) {
                await interaction.editReply("Failed to upload");
                return;
            }

            await interaction.editReply(url);
        },
    },

    prefix: {
        name: "log",

        async execute(message, args, client) {
            let targetMessage = null;

            if (message.reference?.messageId) {
                try {
                    targetMessage = await message.channel.messages.fetch(message.reference.messageId);
                } catch {}
            }

            if (!targetMessage && args[0]) {
                try {
                    targetMessage = await message.channel.messages.fetch(args[0]);
                } catch {}
            }

            if (!targetMessage) {
                await message.reply("Reply to a message with a file or provide a message ID");
                return;
            }

            await module.exports.handleMessage(targetMessage, true);
        }
    },

    events: {
        async messageCreate(message, client) {
            if (message.author.bot) return;

            await module.exports.handleMessage(message, false);
        }
    }
};
