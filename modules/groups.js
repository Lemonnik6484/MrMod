const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits,
} = require('discord.js');

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../module_data/groups/groups.db');
const CONFIG_PATH = path.join(__dirname, '../module_data/groups/config.json');

fs.mkdirSync(path.join(__dirname, '../module_data/groups'), { recursive: true });

function loadConfig() {
    try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
    } catch (error) {
        if (error.code === 'ENOENT') {
            fs.writeFileSync(CONFIG_PATH, `${JSON.stringify({ groupListChannelId: '' }, null, 2)}\n`, 'utf8');
            console.log('[GROUPS] Created config.json. Set groupListChannelId to enable the live group list.');
        } else {
            console.warn('[GROUPS] Unable to read config.json:', error.message);
        }
        return {};
    }
}

const db = new Database(DB_PATH);

db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        name        TEXT NOT NULL,
        created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        UNIQUE(guild_id, name)
    );

    CREATE TABLE IF NOT EXISTS memberships (
        group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL,
        joined_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_list_messages (
        guild_id    TEXT PRIMARY KEY,
        channel_id  TEXT NOT NULL,
        message_id  TEXT NOT NULL
    );
`);

if (db.prepare(`PRAGMA table_info(groups)`).all().some(column => column.name === 'owner_id')) {
    db.exec(`ALTER TABLE groups DROP COLUMN owner_id`);
}

const stmts = {
    getGroup:      db.prepare(`SELECT * FROM groups WHERE guild_id = ? AND name = ? COLLATE NOCASE`),
    createGroup:   db.prepare(`INSERT INTO groups (guild_id, name) VALUES (?, ?)`),
    deleteGroup:   db.prepare(`DELETE FROM groups WHERE id = ?`),
    listGroups:    db.prepare(`SELECT id, name FROM groups WHERE guild_id = ? ORDER BY name ASC`),

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
    getListMessage: db.prepare(`SELECT * FROM group_list_messages WHERE guild_id = ?`),
    setListMessage: db.prepare(`
        INSERT INTO group_list_messages (guild_id, channel_id, message_id)
        VALUES (?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id
    `),
};

function formatGroupListLines(groups, userGroupNames = new Set()) {
    const longestName = Math.max(...groups.map(({ name }) => name.length));

    return groups.map(({ id, name }) => {
        const { cnt } = stmts.memberCount.get(id);
        const membershipMark = userGroupNames.has(name) ? ' ✅' : '';

        return `\`${name.padEnd(longestName)}\` — ${cnt} member${cnt === 1 ? '' : 's'}${membershipMark}`;
    });
}

function groupListEmbeds(guildId, guildName) {
    const groups = stmts.listGroups.all(guildId);
    const lines = groups.length
        ? formatGroupListLines(groups)
        : ['No groups yet. Create one with `/group create <name>`.'];

    const descriptions = [];
    for (const line of lines) {
        const previous = descriptions.at(-1);
        if (!previous || previous.length + line.length + 1 > 4096) {
            descriptions.push(line);
        } else {
            descriptions[descriptions.length - 1] = `${previous}\n${line}`;
        }
    }

    return descriptions.map((description, index) =>
        new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(index === 0 ? `Groups in ${guildName}` : `Groups in ${guildName} (continued)`)
            .setDescription(description)
            .setFooter({ text: 'This list updates automatically.' })
    );
}

async function updateGroupList(client, guildId) {
    const config = loadConfig();
    const channelId = typeof config.groupListChannelId === 'string'
        ? config.groupListChannelId.trim()
        : '';

    if (!channelId) return;

    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased() || typeof channel.send !== 'function') {
            console.warn(`[GROUPS] Configured group list channel ${channelId} is not a text channel.`);
            return;
        }
        if (channel.guildId !== guildId) return;

        const embeds = groupListEmbeds(guildId, channel.guild?.name ?? 'this server');
        const saved = stmts.getListMessage.get(guildId);
        let message = null;

        if (saved?.channel_id === channelId) {
            try {
                message = await channel.messages.fetch(saved.message_id);
            } catch {
                // The list message was deleted; create a replacement below.
            }
        }

        if (message) {
            await message.edit({ embeds });
            console.log(`[GROUPS] Updated live group list in ${channelId} for guild ${guildId}.`);
        } else {
            message = await channel.send({ embeds });
            stmts.setListMessage.run(guildId, channelId, message.id);
            console.log(`[GROUPS] Created live group list in ${channelId} for guild ${guildId}.`);
        }
    } catch (error) {
        console.error(`[GROUPS] Failed to update live list for guild ${guildId}:`, error.message);
    }
}

function refreshGroupList(client, guildId) {
    updateGroupList(client, guildId).catch(error => {
        console.error(`[GROUPS] Failed to schedule live list update for guild ${guildId}:`, error.message);
    });
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
            sub.setName('user')
                .setDescription('Show the groups a user belongs to')
                .addUserOption(opt =>
                    opt.setName('user')
                        .setDescription('User to look up')
                        .setRequired(true)
                )
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
                .setDescription('Delete a group (admin only)')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('Group name')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )

        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Add a user to a group (admin only)')
                .addStringOption(opt => opt.setName('name').setDescription('Group name').setRequired(true).setAutocomplete(true))
                .addUserOption(opt => opt.setName('user').setDescription('User to add').setRequired(true))
        )

        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a user from a group (admin only)')
                .addStringOption(opt => opt.setName('name').setDescription('Group name').setRequired(true).setAutocomplete(true))
                .addUserOption(opt => opt.setName('user').setDescription('User to remove').setRequired(true))
        ),

    async autocomplete(interaction) {
        const guildId = interaction.guildId;
        const focused = interaction.options.getFocused().toLowerCase();

        const groups = stmts.listGroups.all(guildId);

        const filtered = groups
            .filter(({ name }) => name.includes(focused))
            .slice(0, 25);

        return interaction.respond(
            filtered.map(({ name }) => ({
                name,
                value: name,
            }))
        );
    },

    async execute(interaction) {
        const sub     = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const userId  = interaction.user.id;

        const member = await interaction.guild.members.fetch(userId);
        const displayName = member.displayName;

        if (sub === 'create') {
            const rawName = interaction.options.getString('name');
            const name = rawName.trim().toLowerCase().replace(/\s+/g, '-');

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

            const info = stmts.createGroup.run(guildId, name);

            stmts.addMember.run(info.lastInsertRowid, userId);
            refreshGroupList(interaction.client, guildId);

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
                        .setFooter({ text: `${displayName} has been added automatically` }),
                ],
            });
        }

        if (sub === 'join') {
            const name = interaction.options.getString('name').toLowerCase();
            const group = stmts.getGroup.get(guildId, name);

            if (!group) {
                return interaction.reply({
                    content: `No group called **${name}** exists`,
                    ephemeral: true,
                });
            }

            if (stmts.isMember.get(group.id, userId)) {
                return interaction.reply({
                    content: `You're already in **${name}**`,
                    ephemeral: true,
                });
            }

            stmts.addMember.run(group.id, userId);
            refreshGroupList(interaction.client, guildId);

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865f2)
                        .setDescription(`${displayName} joined **${name}**`),
                ],
            });
        }

        if (sub === 'leave') {
            const name = interaction.options.getString('name').toLowerCase();
            const group = stmts.getGroup.get(guildId, name);

            if (!group) {
                return interaction.reply({
                    content: `Group **${name}** doesn't exist`,
                    ephemeral: true,
                });
            }

            if (!stmts.isMember.get(group.id, userId)) {
                return interaction.reply({
                    content: `You're not in **${name}**`,
                    ephemeral: true,
                });
            }

            stmts.removeMember.run(group.id, userId);

            refreshGroupList(interaction.client, guildId);

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xfee75c)
                        .setDescription(`You left **${name}**`),
                ],
            });
        }

        if (sub === 'ping') {
            const name = interaction.options.getString('name').toLowerCase();
            const group = stmts.getGroup.get(guildId, name);

            if (!group) {
                return interaction.reply({
                    content: `Group **${name}** doesn't exist`,
                    ephemeral: true,
                });
            }

            if (!stmts.isMember.get(group.id, userId)) {
                return interaction.reply({
                    content: `You need to be in **${name}** to ping it`,
                    ephemeral: true,
                });
            }

            const members = stmts.getMembers.all(group.id);

            const mentions = members
                .map(m => `<@${m.user_id}>`)
                .join(' ');

            const lines = [
                `**${displayName}** is pinging **${name}**`,
                '',
                mentions,
            ];

            return interaction.reply({
                content: lines.join('\n'),
                allowedMentions: {
                    users: members.map(m => m.user_id),
                },
            });
        }

        if (sub === 'list') {
            const groups = stmts.listGroups.all(guildId);

            if (groups.length === 0) {
                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x99aab5)
                            .setDescription('No groups yet. Create one with `/group create <name>`.'),
                    ],
                });
            }

            const userGroupNames = new Set(
                stmts.userGroups.all(guildId, userId).map(r => r.name)
            );

            const lines = formatGroupListLines(groups, userGroupNames);

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865f2)
                        .setTitle(`Groups in ${interaction.guild.name}`)
                        .setDescription(lines.join('\n'))
                        .setFooter({
                            text: '✅ = you\'re a member',
                        }),
                ],
            });
        }

        if (sub === 'user') {
            const target = interaction.options.getUser('user', true);
            const groups = stmts.userGroups.all(guildId, target.id);

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865f2)
                        .setTitle(`Groups for ${target.username}`)
                        .setDescription(groups.length ? groups.map(({ name }) => `• **${name}**`).join('\n') : 'This user is not in any groups.'),
                ],
            });
        }

        if (sub === 'info') {
            const name = interaction.options.getString('name').toLowerCase();
            const group = stmts.getGroup.get(guildId, name);

            if (!group) {
                return interaction.reply({
                    content: `Group **${name}** doesn't exist`,
                    ephemeral: true,
                });
            }

            await interaction.deferReply();

            const members = stmts.getMembers.all(group.id);

            const lines = await Promise.all(
                members.map(async ({ user_id }) => {
                    let memberName;

                    try {
                        const member = await interaction.guild.members.fetch(user_id);
                        memberName = member.displayName;
                    } catch {
                        memberName = `<@${user_id}>`;
                    }

                    return `• ${memberName}`;
                })
            );

            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865f2)
                        .setTitle(`Group: ${name}`)
                        .setDescription(lines.join('\n') || 'No members.')
                        .setFooter({ text: `${members.length} member${members.length !== 1 ? 's' : ''}` }),
                ],
            });
        }

        if (sub === 'delete') {
            const name = interaction.options.getString('name').toLowerCase();
            const group = stmts.getGroup.get(guildId, name);

            if (!group) {
                return interaction.reply({
                    content: `Group **${name}** doesn't exist`,
                    ephemeral: true,
                });
            }

            const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);

            if (!isAdmin) {
                return interaction.reply({
                    content: `Only a server admin can delete **${name}**.`,
                    ephemeral: true,
                });
            }

            stmts.deleteGroup.run(group.id);
            refreshGroupList(interaction.client, guildId);

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xed4245)
                        .setDescription(`Group **${name}** has been deleted`),
                ],
            });
        }

        if (sub === 'add' || sub === 'remove') {
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: 'Only a server admin can manage group members.', ephemeral: true });
            }

            const name = interaction.options.getString('name', true).toLowerCase();
            const target = interaction.options.getUser('user', true);
            const group = stmts.getGroup.get(guildId, name);

            if (!group) {
                return interaction.reply({ content: `Group **${name}** doesn't exist`, ephemeral: true });
            }

            const alreadyMember = Boolean(stmts.isMember.get(group.id, target.id));
            if (sub === 'add') {
                if (alreadyMember) return interaction.reply({ content: `<@${target.id}> is already in **${name}**.`, ephemeral: true });
                stmts.addMember.run(group.id, target.id);
            } else {
                if (!alreadyMember) return interaction.reply({ content: `<@${target.id}> is not in **${name}**.`, ephemeral: true });
                stmts.removeMember.run(group.id, target.id);

            }

            refreshGroupList(interaction.client, guildId);
            return interaction.reply({
                embeds: [new EmbedBuilder().setColor(sub === 'add' ? 0x57f287 : 0xfee75c)
                    .setDescription(`<@${target.id}> was ${sub === 'add' ? 'added to' : 'removed from'} **${name}**.`)],
            });
        }
    },
};

function init(client) {
    client.once('ready', () => {
        const config = loadConfig();
        const channelId = typeof config.groupListChannelId === 'string' ? config.groupListChannelId.trim() : '';
        if (!channelId) return;

        client.channels.fetch(channelId)
            .then(channel => channel?.guildId && updateGroupList(client, channel.guildId))
            .catch(error => console.error('[GROUPS] Failed to initialize live group list:', error.message));
    });
    console.log('[GROUPS] SQLite DB ready');
}

module.exports = {
    name: 'groups',
    slash: slashCommand,
    init,
};
