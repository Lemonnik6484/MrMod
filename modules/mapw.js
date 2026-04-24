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

const { adminRoles = [], adminUsers = [] } = (() => {
    try { return require('../config.json'); } catch { return {}; }
})();

const DB_PATH            = path.join(__dirname, '../module_data/mapw/mapw.db');
const PAGE_SIZE          = 5;
const WINDOW_SECONDS     = 3;
const WINDOW_MAX_MSGS    = 2;
const DAY_TIER1          = 50;
const DAY_TIER2          = 100;
const VC_TICK_MINUTES    = 5;
const VC_POINTS_PER_TICK = 1;
const WEEK_MS            = 7 * 24 * 60 * 60 * 1000;
const COLLECTOR_TIMEOUT  = 5 * 60 * 1000;

fs.mkdirSync(path.join(__dirname, '../module_data/mapw'), { recursive: true });

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

    let dirty = false;

    if (Date.now() - row.week_start >= WEEK_MS) {
        row.total = 0;
        row.week_start = weekStart;
        row.daily_pts = 0;
        row.daily_date = today;
        dirty = true;
    }

    if (row.daily_date !== today) {
        row.daily_pts = 0;
        row.daily_date = today;
        dirty = true;
    }

    if (dirty) stmts.upsert.run(row);
    return row;
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
    if (words < 3)   return 0;
    if (words <= 20) return 1;
    if (words <= 50) return 2;
    return 1.5;
}

function scoreMessage(guildId, userId, content) {
    const seenList = getSeen(guildId, userId);
    const h = hashMsg(content);
    if (seenList.includes(h)) return 0;
    seenList.push(h);
    if (seenList.length > 30) seenList.shift();

    const raw = rawScore(content);
    if (raw === 0) return 0;

    const bucket = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
    const winMap = getWindow(guildId, userId);
    const count  = winMap.get(bucket) ?? 0;
    if (count >= WINDOW_MAX_MSGS) return 0;
    winMap.set(bucket, count + 1);

    if (winMap.size > 20) winMap.delete(winMap.keys().next().value);

    const row = getOrCreate(guildId, userId);
    let effective = raw;
    if (row.daily_pts >= DAY_TIER2)      effective *= 0.25;
    else if (row.daily_pts >= DAY_TIER1) effective *= 0.5;

    row.daily_pts += effective;
    row.total     += effective;
    saveRow(row);
    return effective;
}

// voiceSessions[guildId][userId] = { lastTick: ms }
const voiceSessions = {};

function isEligible(vs) {
    if (!vs?.channel) return false;
    if (vs.selfDeaf || vs.serverDeaf || vs.selfMute || vs.serverMute) return false;
    return vs.channel.members.filter(m => !m.user.bot && m.id !== vs.id).size > 0;
}

function handleVoiceStateUpdate(oldState, newState) {
    const guildId = newState.guild?.id || oldState.guild?.id;
    const userId  = newState.member?.id || oldState.member?.id;
    if (!guildId || !userId) return;

    if (!voiceSessions[guildId]) voiceSessions[guildId] = {};
    const sessions = voiceSessions[guildId];

    const nowOk = isEligible(newState);
    const wasOk = isEligible(oldState);

    if (nowOk && !sessions[userId]) {
        sessions[userId] = { lastTick: Date.now() };
    }
    if (!nowOk && sessions[userId]) {
        awardVcTicks(guildId, userId);
        delete sessions[userId];
    }
}

function awardVcTicks(guildId, userId) {
    const session = voiceSessions[guildId]?.[userId];
    if (!session) return;
    const ticks = Math.floor((Date.now() - session.lastTick) / (VC_TICK_MINUTES * 60 * 1000));
    if (ticks < 1) return;
    session.lastTick += ticks * VC_TICK_MINUTES * 60 * 1000;

    const row = getOrCreate(guildId, userId);
    for (let i = 0; i < ticks; i++) {
        let pts = VC_POINTS_PER_TICK;
        if (row.daily_pts >= DAY_TIER2)      pts *= 0.25;
        else if (row.daily_pts >= DAY_TIER1) pts *= 0.5;
        row.daily_pts += pts;
        row.total     += pts;
    }
    saveRow(row);
}

function tickAllVc() {
    for (const [guildId, sessions] of Object.entries(voiceSessions)) {
        for (const userId of Object.keys(sessions)) {
            awardVcTicks(guildId, userId);
        }
    }
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
            stmts.reset.run(guildId);
            stmts.setLastReset.run(guildId, Date.now());
            return interaction.reply({ content: 'Nuked it sir', ephemeral: true });
        }
    },
};

const events = {
    messageCreate(message) {
        if (message.author?.bot || !message.guildId) return;
        scoreMessage(message.guildId, message.author.id, message.content);
    },
    voiceStateUpdate(oldState, newState) {
        handleVoiceStateUpdate(oldState, newState);
    },
};

function init(client) {
    setInterval(tickAllVc, 60 * 1000);
    console.log('[MAPW] SQLite DB ready. Voice ticker started.');
}

module.exports = {
    name: 'mapw',
    slash: slashCommand,
    events,
    init,
    scoreMessage,
};