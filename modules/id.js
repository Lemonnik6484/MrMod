const {
    ApplicationIntegrationType,
    ChannelType,
    InteractionContextType,
    SlashCommandBuilder,
} = require('discord.js');

function extractId(value) {
    const match = String(value).trim().match(/^(?:<[@#]!?)?(\d{17,20})>?$/);
    return match?.[1] ?? null;
}

function channelTypeName(channel) {
    return ChannelType[channel.type] ?? 'Unknown channel';
}

async function resolveChannel(client, guild, id) {
    const cached = guild?.channels.cache.get(id) ?? client.channels.cache.get(id);
    if (cached) return cached;

    try {
        return await client.channels.fetch(id);
    } catch {
        return null;
    }
}

async function resolveUser(client, guild, id) {
    const cachedMember = guild?.members.cache.get(id);
    if (cachedMember) return { user: cachedMember.user, member: cachedMember };

    if (guild) {
        try {
            const member = await guild.members.fetch(id);
            return { user: member.user, member };
        } catch {}
    }

    try {
        return { user: await client.users.fetch(id), member: null };
    } catch {
        return null;
    }
}

module.exports = {
    name: 'id',

    slash: {
        data: new SlashCommandBuilder()
            .setName('id')
            .setDescription('Resolve a user or channel ID')
            .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
            .setContexts(InteractionContextType.Guild)
            .addStringOption(option =>
                option
                    .setName('value')
                    .setDescription('A user/channel ID or mention')
                    .setRequired(true)
            ),

        async execute(interaction) {
            const value = interaction.options.getString('value', true);
            const id = extractId(value);

            if (!id) {
                return interaction.reply({
                    content: 'Provide a valid Discord ID, user mention, or channel mention.',
                    ephemeral: true,
                });
            }

            const channel = await resolveChannel(interaction.client, interaction.guild, id);
            if (channel) {
                const name = channel.name ? `#${channel.name}` : 'Unknown channel';
                return interaction.reply({
                    content: `Channel: <#${channel.id}> (${name})\nType: ${channelTypeName(channel)}\nID: \`${channel.id}\``,
                    ephemeral: true,
                });
            }

            const resolved = await resolveUser(interaction.client, interaction.guild, id);
            if (resolved) {
                const name = resolved.member?.displayName ?? resolved.user.globalName ?? resolved.user.username;
                return interaction.reply({
                    content: `User: <@${resolved.user.id}> (${name})\nUsername: ${resolved.user.username}\nID: \`${resolved.user.id}\``,
                    ephemeral: true,
                });
            }

            return interaction.reply({
                content: 'That ID is not a user or channel I can access.',
                ephemeral: true,
            });
        },
    },
};
