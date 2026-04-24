const {
    Client,
    GatewayIntentBits,
    Collection,
    REST,
    Routes,
    Events
} = require('discord.js');

const fs = require('fs');
const path = require('path');

const { token, clientId } = require('./config.json');

const PREFIX = "!";

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.slashCommands = new Collection();
client.prefixCommands = new Collection();

const slashPayload = [];

const modulesPath = path.join(__dirname, 'modules');

if (fs.existsSync(modulesPath)) {
    const files = fs.readdirSync(modulesPath).filter(f => f.endsWith('.js'));

    for (const file of files) {
        const mod = require(path.join(modulesPath, file));

        try {
            if (!mod || !mod.name) {
                console.warn(`Skipping invalid module ${file}`);
                continue;
            }

            if (mod.slash) {
                client.slashCommands.set(mod.slash.data.name, mod.slash);
                slashPayload.push(mod.slash.data.toJSON());
            }

            if (mod.prefix) {
                client.prefixCommands.set(mod.prefix.name, mod.prefix);
            }

            if (mod.events) {
                for (const [eventName, handler] of Object.entries(mod.events)) {
                    client.on(eventName, (...args) => handler(...args, client));
                }
            }

            if (typeof mod.init === 'function') {
                mod.init(client);
            }

            console.log(`Loaded module: ${mod.name}`);
        } catch (err) {
            console.error(`Failed loading module ${file}:`, err);
        }
    }
}

client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(token);

    try {
        await rest.put(
            Routes.applicationCommands(clientId),
            { body: slashPayload }
        );

        console.log("Slash commands registered");
    } catch (err) {
        console.error("Slash registration failed:", err);
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const cmd = client.slashCommands.get(interaction.commandName);
    if (!cmd) return;

    try {
        await cmd.execute(interaction, client);
    } catch (err) {
        console.error(err);

        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: "Error", ephemeral: true });
        } else {
            await interaction.reply({ content: "Error", ephemeral: true });
        }
    }
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const name = args.shift()?.toLowerCase();

    const cmd = client.prefixCommands.get(name);
    if (!cmd) return;

    try {
        await cmd.execute(message, args, client);
    } catch (err) {
        console.error(err);
        await message.reply("Error executing command");
    }
});

client.login(token);