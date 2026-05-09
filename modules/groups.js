const {
    SlashCommandBuilder,
    EmbedBuilder,
} = require('discord.js');

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../module_data/groups/groups.db');

fs.mkdirSync(path.join(__dirname, '../module_data/groups'), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        name        TEXT NOT NULL,
        owner_id    TEXT NOT NULL,
        created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        UNIQUE(guild_id, name)
    );
    CREATE TABLE IF NOT EXISTS memberships (
        group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL,
        joined_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (group_id, user_id)
    );
`);

const stmts = {
    getGroup:      db.prepare(`SELECT * FROM groups WHERE guild_id = ? AND name = ? COLLATE NOCASE`),
    createGroup:   db.prepare(`INSERT INTO groups (guild_id, name, owner_id) VALUES (?, ?, ?)`),
    deleteGroup:   db.prepare(`DELETE FROM groups WHERE id = ?`),
    listGroups:    db.prepare(`SELECT name FROM groups WHERE guild_id = ? ORDER BY name ASC`),

    isMember:      db.prepare(`SELECT 1 FROM memberships WHERE group_id = ? AND user_id = ?`),
    addMember:     db.prepare(`INSERT OR IGNORE INTO memberships (group_id, user_id) VALUES (?, ?)`),
    removeMember:  db.prepare(`DELETE FROM memberships WHERE group_id = ? AND user_id = ?`),
    getMembers:    db.prepare(`SELECT user_id FROM memberships WHERE group_id = ?`),
    memberCount:   db.prepare(`SELECT COUNT(*) AS cnt FROM memberships WHERE group_id = ?`),
    userGroups:    db.prepare(`
        SELECT g.name FROM groups g
        JOIN memberships m ON m.group_id = g.id
        WHERE g.guild_id = ? AND m.user_id = ?
        ORDER BY g.name ASC
    `),
};

function autocompleteGroups(guildId, focused) {
    const all = stmts.listGroups.all(guildId).map(r => r.name);
    const lower = focused.toLowerCase();
    return all
        .filter(name => name.toLowerCase().startsWith(lower))
        .slice(0, 25)
        .map(name => ({ name, value: name }));
}

const slashCommand = {
    data: new SlashCommandBuilder()
        .setName('group')
        .setDescription('Manage ping groups')

        .addSubcommand(sub =>
            sub.setName('create')
                .setDescription('Create a new group')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('Group name')
                        .setRequired(true)
                        .setMaxLength(32)
                )
        )

        .addSubcommand(sub =>
            sub.setName('join')
                .setDescription('Join a group')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('Group name')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )

        .addSubcommand(sub =>
            sub.setName('leave')
                .setDescription('Leave a group')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('Group name')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )

        .addSubcommand(sub =>
            sub.setName('ping')
                .setDescription('Ping the group')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('Group name')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )

        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all groups')
        )

        .addSubcommand(sub =>
            sub.setName('info')
                .setDescription('Show members of a group')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('Group name')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )

        .addSubcommand(sub =>
            sub.setName('delete')
                .setDescription('Delete a group you own')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('Group name')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        ),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused();
        const choices = autocompleteGroups(interaction.guildId, focused);
        await interaction.respond(choices);
    },

    async execute(interaction) {
        const sub     = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const userId  = interaction.user.id;

        if (sub === 'create') {
            const rawName = interaction.options.getString('name');
            const name    = rawName.trim().toLowerCase().replace(/\s+/g, '-');

            if (!/^[a-z0-9_-]+$/.test(name)) {
                return interaction.reply({
                    content: 'Group name can only contain letters, numbers, hyphens, and underscores',
                    ephemeral: true,
                });
            }

            const existing = stmts.getGroup.get(guildId, name);
            if (existing) {
                return interaction.reply({
                    content: `A group called **${name}** already exists`,
                    ephemeral: true,
                });
            }

            const info = stmts.createGroup.run(guildId, name, userId);
            stmts.addMember.run(info.lastInsertRowid, userId);

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x57f287)
                        .setTitle('Group created!')
                        .setDescription(
                            `**${name}** is ready.\n` +
                            `Others can join with \`/group join ${name}\`\n` +
                            `Ping everyone with \`/group ping ${name}\``
                        )
                        .setFooter({ text: `You've been added automatically as the owner.` })
                ],
            });
        }

        if (sub === 'join') {
            const name  = interaction.options.getString('name').toLowerCase();
            const group = stmts.getGroup.get(guildId, name);

            if (!group) {
                return interaction.reply({
                    content: `No group called **${name}** exists`,
                    ephemeral: true,
                });
            }

            if (stmts.isMember.get(group.id, userId)) {
                return interaction.reply({
                    content: `You're already in **${name}**.`,
                    ephemeral: true,
                });
            }

            stmts.addMember.run(group.id, userId);
            const { cnt } = stmts.memberCount.get(group.id);

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865f2)
                        .setDescription(`You joined **${name}**`)
                ],
            });
        }

        if (sub === 'leave') {
            const name  = interaction.options.getString('name').toLowerCase();
            const group = stmts.getGroup.get(guildId, name);

            if (!group) {
                return interaction.reply({ content: `Group **${name}** doesn't exist.`, ephemeral: true });
            }

            if (!stmts.isMember.get(group.id, userId)) {
                return interaction.reply({ content: `You're not in **${name}**.`, ephemeral: true });
            }

            stmts.removeMember.run(group.id, userId);
            const { cnt } = stmts.memberCount.get(group.id);

            if (cnt === 0) {
                stmts.deleteGroup.run(group.id);
                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0xed4245)
                            .setDescription(`You left **${name}**`)
                    ],
                });
            }

            if (group.owner_id === userId) {
                const next = stmts.getMembers.all(group.id)[0];
                if (next) {
                    db.prepare(`UPDATE groups SET owner_id = ? WHERE id = ?`).run(next.user_id, group.id);
                }
            }

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xfee75c)
                        .setDescription(`You left **${name}**`)
                ],
            });
        }

        if (sub === 'ping') {
            const name    = interaction.options.getString('name').toLowerCase();
            const group   = stmts.getGroup.get(guildId, name);

            if (!group) {
                return interaction.reply({ content: `Group **${name}** doesn't exist`, ephemeral: true });
            }

            if (!stmts.isMember.get(group.id, userId)) {
                return interaction.reply({
                    content: `You need to be in **${name}** to ping it`,
                    ephemeral: true,
                });
            }

            const members = stmts.getMembers.all(group.id);
            const mentions = members.map(m => `<@${m.user_id}>`).join(' ');

            const lines = [
                `**${interaction.user.displayName}** is pinging **${name}**`,
            ];
            lines.push('', mentions);

            return interaction.reply({ content: lines.join('\n'), allowedMentions: { users: members.map(m => m.user_id) } });
        }

        if (sub === 'list') {
            const groups = stmts.listGroups.all(guildId);

            if (groups.length === 0) {
                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x99aab5)
                            .setDescription('No groups yet. Create one with `/group create <name>`.')
                    ],
                });
            }

            const userGroupNames = new Set(
                stmts.userGroups.all(guildId, userId).map(r => r.name)
            );

            const lines = groups.map(({ name }) => {
                const { cnt } = stmts.memberCount.get(stmts.getGroup.get(guildId, name).id);
                const inGroup = userGroupNames.has(name) ? ' ✅' : '';
                return `**${name}**${inGroup} — ${cnt} member${cnt !== 1 ? 's' : ''}`;
            });

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865f2)
                        .setTitle(`Groups in ${interaction.guild.name}`)
                        .setDescription(lines.join('\n'))
                        .setFooter({ text: '✅ = you\'re a member' })
                ],
            });
        }

        if (sub === 'info') {
            const name  = interaction.options.getString('name').toLowerCase();
            const group = stmts.getGroup.get(guildId, name);

            if (!group) {
                return interaction.reply({ content: `Group **${name}** doesn't exist.`, ephemeral: true });
            }

            await interaction.deferReply();

            const members = stmts.getMembers.all(group.id);
            const lines = await Promise.all(
                members.map(async ({ user_id }) => {
                    let displayName;
                    try {
                        const member = await interaction.guild.members.fetch(user_id);
                        displayName  = member.displayName;
                    } catch {
                        displayName = `<@${user_id}>`;
                    }
                    const isOwner = user_id === group.owner_id ? ' 👑' : '';
                    return `• ${displayName}${isOwner}`;
                })
            );

            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865f2)
                        .setTitle(`Group: ${name}`)
                        .setDescription(lines.join('\n') || 'No members.')
                        .setFooter({ text: `${members.length} member${members.length !== 1 ? 's' : ''} • 👑 = owner` })
                ],
            });
        }

        if (sub === 'delete') {
            const name  = interaction.options.getString('name').toLowerCase();
            const group = stmts.getGroup.get(guildId, name);

            if (!group) {
                return interaction.reply({ content: `Group **${name}** doesn't exist.`, ephemeral: true });
            }

            const member = await interaction.guild.members.fetch(userId);
            const isAdmin = member.permissions.has('Administrator');

            if (group.owner_id !== userId && !isAdmin) {
                return interaction.reply({
                    content: `Only the group owner or a server admin can delete **${name}**.`,
                    ephemeral: true,
                });
            }

            stmts.deleteGroup.run(group.id);

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xed4245)
                        .setDescription(`Group **${name}** has been deleted.`)
                ],
            });
        }
    },
};

function init(client) {
    console.log('[GROUPS] SQLite DB ready');
}

module.exports = {
    name: 'groups',
    slash: slashCommand,
    init,
};