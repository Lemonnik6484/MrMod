const {
    ApplicationIntegrationType,
    InteractionContextType,
    SlashCommandBuilder,
} = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../module_data/remindme/reminders.db'));

const getByUser = db.prepare(`
    SELECT * FROM reminders WHERE done = 0 AND user_id = ? ORDER BY fire_at ASC
`);

const cancelByIdAndOwner = db.prepare(`
    UPDATE reminders SET done = 1 WHERE id = ? AND user_id = ? AND done = 0
`);

module.exports = {
    name: 'reminders',

    slash: {
        data: new SlashCommandBuilder()
            .setName('reminders')
            .setDescription('View or remove reminders')
            .setIntegrationTypes(
                ApplicationIntegrationType.GuildInstall,
                ApplicationIntegrationType.UserInstall,
            )
            .setContexts(
                InteractionContextType.Guild,
                InteractionContextType.BotDM,
                InteractionContextType.PrivateChannel,
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('list')
                    .setDescription('List active reminders')
                    .addUserOption(option =>
                        option
                            .setName('user')
                            .setDescription('User whose reminders to view')
                            .setRequired(false)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('remove')
                    .setDescription('Remove one of your active reminders')
                    .addIntegerOption(option =>
                        option
                            .setName('index')
                            .setDescription('Index shown by /reminders list')
                            .setMinValue(1)
                            .setRequired(true)
                    )
            ),

        async execute(interaction) {
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === 'remove') {
                const index = interaction.options.getInteger('index');
                const rows = getByUser.all(interaction.user.id);
                const reminder = rows[index - 1];

                if (!reminder) {
                    return interaction.reply({
                        content: `No active reminder exists at index ${index}.`,
                        ephemeral: false,
                    });
                }

                const result = cancelByIdAndOwner.run(reminder.id, interaction.user.id);
                if (result.changes !== 1) {
                    return interaction.reply({
                        content: 'That reminder is no longer active.',
                        ephemeral: false,
                    });
                }

                return interaction.reply({
                    content: `Removed reminder ${index}: **${reminder.label}**${reminder.note ? ` — ${reminder.note}` : ''}.`,
                    ephemeral: false,
                });
            }

            const targetUser =
                interaction.options.getUser('user') ?? interaction.user;

            const rows = getByUser.all(targetUser.id);

            if (rows.length === 0) {
                return interaction.reply({
                    content:
                        targetUser.id === interaction.user.id
                            ? 'You have no active reminders'
                            : `${targetUser.username} has no active reminders`,
                    ephemeral: false,
                });
            }

            const lines = rows.map((r, i) => {
                const ts = Math.floor(r.fire_at / 1000);
                return r.note
                    ? `${i + 1}. **${r.label}** — ${r.note} (<t:${ts}:R>)`
                    : `${i + 1}. **${r.label}** (<t:${ts}:R>)`;
            });

            await interaction.reply({
                content:
                    targetUser.id === interaction.user.id
                        ? `**Your reminders:**\n${lines.join('\n')}`
                        : `**Reminders for ${targetUser.tag}:**\n${lines.join('\n')}`,
                ephemeral: false,
            });
        },
    },
};
