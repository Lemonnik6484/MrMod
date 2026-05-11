const { SlashCommandBuilder } = require('discord.js');

function parseTime(timeStr) {
    const regex = /(?:(\d+)d)?(?:\s*(\d+)h)?(?:\s*(\d+)m)?/i;
    const match = timeStr.trim().match(regex);

    if (!match || (!match[1] && !match[2] && !match[3])) return null;

    const days    = parseInt(match[1] || 0);
    const hours   = parseInt(match[2] || 0);
    const minutes = parseInt(match[3] || 0);

    const ms = (days * 24 * 60 + hours * 60 + minutes) * 60 * 1000;
    return ms > 0 ? { ms, days, hours, minutes } : null;
}

function formatDuration({ days, hours, minutes }) {
    return [
        days    && `${days}d`,
        hours   && `${hours}h`,
        minutes && `${minutes}m`,
    ].filter(Boolean).join(' ');
}

module.exports = {
    name: 'remindme',

    slash: {
        data: new SlashCommandBuilder()
            .setName('remindme')
            .setDescription('Set a reminder')
            .addStringOption(option =>
                option
                    .setName('time')
                    .setDescription('When to remind (e.g. 3d 2h 30m)')
                    .setRequired(true)
            )
            .addStringOption(option =>
                option
                    .setName('note')
                    .setDescription('Optional reminder note')
                    .setRequired(false)
            ),

        async execute(interaction) {
            const timeStr = interaction.options.getString('time');
            const note    = interaction.options.getString('note');

            const parsed = parseTime(timeStr);
            if (!parsed) {
                return interaction.reply({
                    content: 'Invalid time format. Use combinations like `3d`, `2h`, `30m`, or `1d 6h 30m`.',
                    ephemeral: true,
                });
            }

            const { ms } = parsed;
            const label = formatDuration(parsed);

            await interaction.reply(
                `Reminder in **${label}**${note ? ` about: *${note}*` : ''}.`
            );

            setTimeout(async () => {
                try {
                    const channel = interaction.channel;
                    if (channel?.send) {
                        await channel.send(
                            `<@${interaction.user.id}> **Reminder!**\n` +
                            (note ? `${note}\n` : '') +
                            `*(Set ${label} ago)*`
                        );
                    }
                } catch {
                    try {
                        await interaction.user.send(
                            `**Reminder!**\n` +
                            (note ? `${note}\n` : '') +
                            `*(Set ${label} ago)*`
                        );
                    } catch {
                        console.error(`Failed to send reminder to ${interaction.user.name}`);
                    }
                }
            }, ms);
        },
    },
};