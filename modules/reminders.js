const { SlashCommandBuilder } = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../module_data/remindme/reminders.db'));

const getByUser = db.prepare(`
    SELECT * FROM reminders WHERE done = 0 AND user_id = ? ORDER BY fire_at ASC
`);

module.exports = {
    name: 'reminders',

    slash: {
        data: new SlashCommandBuilder()
            .setName('reminders')
            .setDescription('List active reminders')
            .addUserOption(option =>
                option
                    .setName('user')
                    .setDescription('User whose reminders to view')
                    .setRequired(false)
            ),

        async execute(interaction) {
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