const {
    SlashCommandBuilder,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ComponentType,
} = require('discord.js');

const Database = require('better-sqlite3');
const path = require('path');
const fs = require("fs");

const config = (() => {
    try { return require('../config.json'); } catch { return {}; }
})();
const {
    adminRoles = [],
    adminUsers = [],
    mapwAnnouncement = {},
} = config;

const DB_PATH            = path.join(__dirname, '../module_data/mapw/mapw.db');
const WHITELIST_PATH     = path.join(__dirname, '../module_data/mapw/botWhitelist.json');
const PAGE_SIZE          = 5;
const WINDOW_SECONDS     = 3;
const WINDOW_MAX_MSGS    = 2;
const DAY_TIER1          = 50;
const DAY_TIER2          = 100;
const COLLECTOR_TIMEOUT  = 5 * 60 * 1000;

fs.mkdirSync(path.join(__dirname, '../module_data/mapw'), { recursive: true });

function loadBotWhitelist() {
    try {
        const raw = fs.readFileSync(WHITELIST_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            console.warn('[MAPW] botWhitelist.json should be an array of bot user IDs, defaulting to empty.');
            return new Set();
        }
        return new Set(parsed);
    } catch (err) {
        if (err.code === 'ENOENT') {
            fs.writeFileSync(WHITELIST_PATH, '[]', 'utf8');
            console.log('[MAPW] botWhitelist.json not found — created an empty one at', WHITELIST_PATH);
        } else {
            console.warn('[MAPW] Failed to load botWhitelist.json:', err.message);
        }
        return new Set();
    }
}

let botWhitelist = loadBotWhitelist();

const db = new Database(DB_PATH);

db.exec(`
    CREATE TABLE IF NOT EXISTS scores (
                                          guild_id     TEXT NOT NULL,
                                          user_id      TEXT NOT NULL,
                                          total        REAL NOT NULL DEFAULT 0,
                                          daily_pts    REAL NOT NULL DEFAULT 0,
                                          daily_date   TEXT NOT NULL DEFAULT '',
                                          week_start   INTEGER NOT NULL DEFAULT 0,
                                          PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS resets (
                                          guild_id    TEXT PRIMARY KEY,
                                          last_reset  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS archives (
                                            id           INTEGER PRIMARY KEY AUTOINCREMENT,
                                            guild_id     TEXT NOT NULL,
                                            user_id      TEXT NOT NULL,
                                            total        REAL NOT NULL,
                                            week_start   INTEGER NOT NULL,
                                            archived_at  INTEGER NOT NULL
    );
`);

const stmts = {
    get: db.prepare(`
        SELECT * FROM scores WHERE guild_id = ? AND user_id = ?
    `),
    upsert: db.prepare(`
        INSERT INTO scores (guild_id, user_id, total, daily_pts, daily_date, week_start)
        VALUES (@guild_id, @user_id, @total, @daily_pts, @daily_date, @week_start)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
                                                     total      = excluded.total,
                                                     daily_pts  = excluded.daily_pts,
                                                     daily_date = excluded.daily_date,
                                                     week_start = excluded.week_start
    `),
    leaderboard: db.prepare(`
        SELECT user_id, total
        FROM scores
        WHERE guild_id = ?
        ORDER BY total DESC
        LIMIT ? OFFSET ?
    `),
    count: db.prepare(`
        SELECT COUNT(*) AS cnt FROM scores WHERE guild_id = ?
    `),
    reset: db.prepare(`
        DELETE FROM scores WHERE guild_id = ?
    `),
    archiveInsert: db.prepare(`
        INSERT INTO archives (guild_id, user_id, total, week_start, archived_at)
        VALUES (@guild_id, @user_id, @total, @week_start, @archived_at)
    `),
    allScores: db.prepare(`
        SELECT * FROM scores WHERE guild_id = ? AND total > 0 ORDER BY total DESC
    `),
    top3: db.prepare(`
        SELECT user_id, total FROM scores WHERE guild_id = ? AND total > 0 ORDER BY total DESC LIMIT 3
    `),
    allGuilds: db.prepare(`
        SELECT DISTINCT guild_id FROM scores
    `),
    getLastReset: db.prepare(`
        SELECT last_reset FROM resets WHERE guild_id = ?
    `),
    setLastReset: db.prepare(`
        INSERT INTO resets (guild_id, last_reset)
        VALUES (?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET last_reset = excluded.last_reset
    `),
};

function todayUTC() {
    return new Date().toISOString().slice(0, 10);
}

function currentWeekStart() {
    const now = new Date();
    const day = now.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const mon = new Date(now);
    mon.setUTCDate(now.getUTCDate() + diff);
    mon.setUTCHours(0, 0, 0, 0);
    return mon.getTime();
}

function getOrCreate(guildId, userId) {
    let row = stmts.get.get(guildId, userId);
    const weekStart = currentWeekStart();
    const today = todayUTC();

    if (!row) {
        row = { guild_id: guildId, user_id: userId, total: 0, daily_pts: 0, daily_date: today, week_start: weekStart };
        stmts.upsert.run(row);
    }

    if (row.daily_date !== today) {
        row.daily_pts = 0;
        row.daily_date = today;
        stmts.upsert.run(row);
    }

    return row;
}

function resetGuild(guildId, now) {
    const rows = stmts.allScores.all(guildId);
    const top3 = stmts.top3.all(guildId);

    if (top3.length > 0) {
        const podium = top3
            .map((r, i) => `#${i + 1} <@${r.user_id}> — ${parseInt(r.total)} pts`)
            .join('\n');
        console.log(`[MAPW] Top ${top3.length} for guild ${guildId} before reset:\n${podium}`);
    } else {
        console.log(`[MAPW] Guild ${guildId} had no scores this week.`);
    }

    for (const row of rows) {
        stmts.archiveInsert.run({
            guild_id:    row.guild_id,
            user_id:     row.user_id,
            total:       row.total,
            week_start:  row.week_start,
            archived_at: now,
        });
    }
    stmts.reset.run(guildId);
    stmts.setLastReset.run(guildId, now);
    console.log(`[MAPW] Archived ${rows.length} score(s) for guild ${guildId}.`);

    return { totalArchived: rows.length, winner: top3[0] ?? null };
}

function formatAnnouncement(template, guild, winner) {
    return template
        .split('{winner}').join(`<@${winner.user_id}>`)
        .split('{winner_id}').join(winner.user_id)
        .split('{points}').join(String(Math.floor(winner.total)))
        .split('{guild}').join(guild.name);
}

async function announceWinner(client, guildId, winner) {
    const channelId = mapwAnnouncement.channelId;
    const template = mapwAnnouncement.message;
    if (!winner || !channelId || typeof template !== 'string' || !template.trim()) return false;

    try {
        const channel = await client.channels.fetch(channelId);
        const guild = channel?.guild;
        if (!channel?.isTextBased?.() || guild?.id !== guildId) {
            console.warn(`[MAPW] Announcement channel ${channelId} is not a text channel in guild ${guildId}.`);
            return false;
        }
        await channel.send(formatAnnouncement(template, guild, winner));
        return true;
    } catch (err) {
        console.error(`[MAPW] Failed to announce winner for guild ${guildId}:`, err.message);
        return false;
    }
}

async function runWeeklyReset(client) {
    const now = Date.now();
    const guilds = stmts.allGuilds.all();

    if (guilds.length === 0) {
        console.log('[MAPW] Weekly reset triggered — no guilds with scores, nothing to archive.');
        return;
    }

    const archiveTx = db.transaction(() => {
        let totalArchived = 0;
        const winners = [];
        for (const { guild_id } of guilds) {
            const result = resetGuild(guild_id, now);
            totalArchived += result.totalArchived;
            if (result.winner) winners.push({ guildId: guild_id, winner: result.winner });
        }
        console.log(`[MAPW] Weekly reset complete — ${totalArchived} total score(s) archived across ${guilds.length} guild(s).`);
        return winners;
    });

    const winners = archiveTx();
    await Promise.all(winners.map(({ guildId, winner }) => announceWinner(client, guildId, winner)));
}

function scheduleWeeklyReset(client) {
    let lastCheckedWeek = currentWeekStart();

    const startupWeek = currentWeekStart();
    const anyGuild = stmts.allGuilds.all()[0];
    if (anyGuild) {
        const resetRow = stmts.getLastReset.get(anyGuild.guild_id);
        const lastReset = resetRow?.last_reset ?? 0;
        if (lastReset < startupWeek) {
            console.log('[MAPW] Missed weekly reset detected on startup — running now.');
            void runWeeklyReset(client);
        }
    }

    setInterval(() => {
        const week = currentWeekStart();
        if (week !== lastCheckedWeek) {
            lastCheckedWeek = week;
            console.log('[MAPW] New week detected — archiving scores and resetting leaderboard.');
            void runWeeklyReset(client);
        }
    }, 60 * 60 * 1000); // check every hour
}

function saveRow(row) {
    stmts.upsert.run(row);
}

const windows = new Map();
const seen    = new Map();

function getWindow(guildId, userId) {
    const k = `${guildId}:${userId}`;
    if (!windows.has(k)) windows.set(k, new Map());
    return windows.get(k);
}

function getSeen(guildId, userId) {
    const k = `${guildId}:${userId}`;
    if (!seen.has(k)) seen.set(k, []);
    return seen.get(k);
}

function hashMsg(content) {
    let h = 0;
    for (let i = 0; i < content.length; i++) h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
    return h.toString(36);
}

function rawScore(content) {
    const text = content.trim();

    const noEmoji = text.replace(/<a?:\w+:\d+>/g, '').replace(/[\u{1F000}-\u{1FFFF}]/gu, '').trim();
    if (!noEmoji.length) return 0;

    if (!text.replace(/https?:\/\/\S+/g, '').trim().length) return 0;

    const freq = {};
    for (const ch of text) freq[ch] = (freq[ch] || 0) + 1;
    if (Math.max(...Object.values(freq)) / text.length > 0.70) return 0;

    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < 3 && text.length < 7) return text.length * 0.03;
    if (words <= 20) return 1 + text.length * 0.05;
    if (words <= 50) return 2 + text.length * 0.03;
    return 1.5 * text.length * 0.01;
}

async function scoreMessage(guild, guildId, userId, content) {
    const seenList = getSeen(guildId, userId);
    const h = hashMsg(content);
    if (seenList.includes(h)) return 0;
    seenList.push(h);
    if (seenList.length > 30) seenList.shift();

    const raw = rawScore(content);

    const bucket = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
    const winMap = getWindow(guildId, userId);
    const count = winMap.get(bucket) ?? 0;
    if (count >= WINDOW_MAX_MSGS) return 0;
    winMap.set(bucket, count + 1);

    if (winMap.size > 20) winMap.delete(winMap.keys().next().value);

    const row = getOrCreate(guildId, userId);
    let effective = raw;
    if (row.daily_pts >= DAY_TIER2) effective *= 0.25;
    else if (row.daily_pts >= DAY_TIER1) effective *= 0.5;

    row.daily_pts += effective;
    row.total += effective;
    saveRow(row);

    let displayName;

    try {
        let member = guild.members.cache.get(userId)
        if (!member) {
            member = await guild.members.fetch(userId);
        }
        displayName = member.displayName;
    } catch {
        displayName = `Unknown User`;
    }

    console.log(`[mapw] +${effective.toFixed(2)} pts → ${displayName} (${userId})`);

    return effective;
}

function isAdmin(member) {
    if (!member) return false;
    if (member.permissions.has('Administrator')) return true;
    if (adminUsers.includes(member.id)) return true;
    if (member.roles?.cache?.some(r => adminRoles.includes(r.id))) return true;
    return false;
}

const MEDALS = ['🥇', '🥈', '🥉'];

async function buildLeaderboardEmbed(guild, page) {
    const guildId  = guild.id;
    const total    = stmts.count.get(guildId).cnt;
    const maxPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.max(0, Math.min(page, maxPages - 1));
    const rows     = stmts.leaderboard.all(guildId, PAGE_SIZE, safePage * PAGE_SIZE);

    const resetRow = stmts.getLastReset.get(guildId);
    const resetTs  = resetRow?.last_reset || currentWeekStart();
    const lastReset = new Date(resetTs).toLocaleDateString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short',
    });

    if (rows.length === 0) {
        const embed = new EmbedBuilder()
            .setTitle('MAPW Leaderboard')
            .setDescription('No activity this week, dead chat fr')
            .setColor(0xf5a623)
            .setFooter({ text: `Last reset: ${lastReset}` });
        return { embed, page: 0, maxPages: 1 };
    }

    const lines = await Promise.all(
        rows.map(async ({ user_id, total }, i) => {
            const rank = safePage * PAGE_SIZE + i;
            const medal = MEDALS[rank] ?? `**#${rank + 1}**`;
            let name;
            try {
                const member = await guild.members.fetch(user_id);
                name = member.displayName;
            } catch {
                name = `<@${user_id}>`;
            }
            return `${medal} **${name}** — \`${parseInt(total)} pts\``;
        })
    );

    const embed = new EmbedBuilder()
        .setTitle('MAPW Leaderboard')
        .setDescription(lines.join('\n'))
        .setColor(0xf5a623)
        .setFooter({ text: `Page ${safePage + 1}/${maxPages} • Last reset: ${lastReset}` })
        .setTimestamp();

    return { embed, page: safePage, maxPages };
}

function buildPageRow(page, maxPages) {
    const prev = new ButtonBuilder()
        .setCustomId('mapw_prev')
        .setLabel('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0);

    const next = new ButtonBuilder()
        .setCustomId('mapw_next')
        .setLabel('▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= maxPages - 1);

    return new ActionRowBuilder().addComponents(prev, next);
}

const slashCommand = {
    data: new SlashCommandBuilder()
        .setName('mapw')
        .setDescription('Most Active Person of the Week')
        .addSubcommand(sub =>
            sub.setName('top')
                .setDescription('Show MAPW leaderboard')
        )
        .addSubcommand(sub =>
            sub.setName('score')
                .setDescription("Check yours or someone else's activity score")
                .addUserOption(opt =>
                    opt.setName('user')
                        .setDescription('User to look up (defaults to you)')
                )
        )
        .addSubcommand(sub =>
            sub.setName('reset')
                .setDescription('Reset the leaderboard for this server')
        )
        .addSubcommand(sub =>
            sub.setName('announce')
                .setDescription('Announce the current MAPW winner')
        ),

    async execute(interaction, client) {
        const sub     = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        if (sub === 'top') {
            await interaction.deferReply();

            let page = 0;
            const { embed, maxPages } = await buildLeaderboardEmbed(interaction.guild, page);
            const row = buildPageRow(page, maxPages);

            const msg = await interaction.editReply({
                embeds: [embed],
                components: maxPages > 1 ? [row] : [],
            });

            if (maxPages <= 1) return;

            const collector = msg.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: COLLECTOR_TIMEOUT,
                filter: i => i.user.id === interaction.user.id,
            });

            collector.on('collect', async btnInt => {
                if (btnInt.customId === 'mapw_prev') page = Math.max(0, page - 1);
                if (btnInt.customId === 'mapw_next') page = Math.min(maxPages - 1, page + 1);

                const { embed: newEmbed, maxPages: mp } = await buildLeaderboardEmbed(interaction.guild, page);
                await btnInt.update({
                    embeds: [newEmbed],
                    components: [buildPageRow(page, mp)],
                });
            });

            collector.on('end', async () => {
                try {
                    const disabledRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('mapw_prev').setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(true),
                        new ButtonBuilder().setCustomId('mapw_next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(true),
                    );
                    await msg.edit({ components: [disabledRow] });
                } catch { /* message doesnt exist */ }
            });

            return;
        }

        if (sub === 'score') {
            const target = interaction.options.getUser('user') ?? interaction.user;
            const row    = getOrCreate(guildId, target.id);

            let member;
            try { member = await interaction.guild.members.fetch(target.id); } catch {}
            const displayName = member?.displayName ?? target.username;

            const embed = new EmbedBuilder()
                .setTitle('MAPW Score')
                .setThumbnail(target.displayAvatarURL())
                .setDescription(
                    `**${displayName}**\n` +
                    `> Weekly total: \`${parseInt(row.total)} pts\`\n` +
                    `> Today: \`${parseInt(row.daily_pts)} pts\``
                )
                .setColor(0x4fcf70)
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'reset') {
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!isAdmin(member)) {
                return interaction.reply({ content: "You're not an admin, go away", ephemeral: true });
            }
            const result = db.transaction(() => resetGuild(guildId, Date.now()))();
            const announced = await announceWinner(client, guildId, result.winner);
            return interaction.reply({
                content: result.winner
                    ? `Leaderboard reset.${announced ? ' Winner announced.' : ' No winner announcement was sent.'}`
                    : 'Leaderboard reset. There was no winner to announce.',
                ephemeral: true,
            });
        }

        if (sub === 'announce') {
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!isAdmin(member)) {
                return interaction.reply({ content: "You're not an admin, go away", ephemeral: true });
            }

            const winner = stmts.top3.get(guildId);
            if (!winner) {
                return interaction.reply({ content: 'There is no MAPW winner to announce yet.', ephemeral: true });
            }

            const announced = await announceWinner(client, guildId, winner);
            return interaction.reply({
                content: announced
                    ? 'MAPW winner announced.'
                    : 'No announcement was sent. Check `mapwAnnouncement` in config.json.',
                ephemeral: true,
            });
        }
    },
};

const events = {
    messageCreate(message) {
        if (message.author?.bot && !botWhitelist.has(message.author.id)) return;
        if (!message.guildId) return;
        scoreMessage(message.guild, message.guildId, message.author.id, message.content).then(r => {});
    },
};

function init(client) {
    scheduleWeeklyReset(client);
    console.log('[MAPW] SQLite DB ready. Weekly archive scheduler started.');
    console.log(`[MAPW] Bot whitelist loaded: ${botWhitelist.size} entr${botWhitelist.size === 1 ? 'y' : 'ies'}`);
}

module.exports = {
    name: 'mapw',
    slash: slashCommand,
    events,
    init,
    scoreMessage,
};
