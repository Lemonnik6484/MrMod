const { EmbedBuilder } = require('discord.js');

const events = {
    async voiceStateUpdate(oldState, newState) {
        const oldChannel = oldState.channel;
        const newChannel = newState.channel;

        if (oldState.channelId === newState.channelId) return;

        const member = newState.member ?? oldState.member;
        if (member?.user?.bot) return;

        console.log(
            `[VC LOG] ${member?.user?.tag ?? member?.id ?? 'Unknown user'}: ` +
            `${oldChannel?.name ?? 'none'} -> ${newChannel?.name ?? 'none'}`
        );

        const displayName = member?.displayName ?? member?.user?.tag ?? 'Unknown user';
        const avatarUrl = member?.displayAvatarURL?.({ size: 128 }) ?? member?.user?.displayAvatarURL?.({ size: 128 });

        const sendToChannel = async (channel, title, color) => {
            if (!channel || typeof channel.send !== 'function') return;

            const embed = new EmbedBuilder()
                .setAuthor({
                    name: displayName,
                    iconURL: avatarUrl ?? undefined,
                })
                .setDescription(title)
                .setColor(color)
                .setTimestamp();

            try {
                await channel.send({ embeds: [embed] });
            } catch (err) {
                console.error('[VC LOG] Failed to send voice log:', err);
            }
        };

        if (!oldChannel && newChannel) {
            await sendToChannel(newChannel, 'Joined the channel', 0x57f287);
            return;
        }

        if (oldChannel && !newChannel) {
            await sendToChannel(oldChannel, 'Left the channel', 0xed4245);
            return;
        }

        if (oldChannel && newChannel) {
            await sendToChannel(oldChannel, 'Left the channel', 0xed4245);
            await sendToChannel(newChannel, 'Joined the channel', 0x57f287);
        }
    },
};

function init(client) {
    console.log('[VC LOG] Initialized');
}

module.exports = {
    name: 'vc-log',
    events,
    init,
};
