const { SlashCommandBuilder } = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require("fs");

fs.mkdirSync(path.join(__dirname, '../module_data/remindme'), { recursive: true });

const db = new Database(path.join(__dirname, '../module_data/remindme/reminders.db'));

db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     TEXT    NOT NULL,
        channel_id  TEXT,
        guild_id    TEXT,
        note        TEXT,
        fire_at     INTEGER NOT NULL,   -- Unix ms timestamp
        label       TEXT    NOT NULL,   -- human-readable duration
        done        INTEGER NOT NULL DEFAULT 0
    )
`);

const insertReminder = db.prepare(`
    INSERT INTO reminders (user_id, channel_id, guild_id, note, fire_at, label)
    VALUES (@user_id, @channel_id, @guild_id, @note, @fire_at, @label)
`);

const markDone = db.prepare(`UPDATE reminders SET done = 1 WHERE id = ?`);

const getPending = db.prepare(`
    SELECT * FROM reminders WHERE done = 0 AND fire_at <= ?
`);

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

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

async function fireReminder(client, reminder) {
    markDone.run(reminder.id);

    const text =
        `<@${reminder.user_id}> **Reminder!**\n` +
        (reminder.note ? `${reminder.note}\n` : '') +
        `*(Set ${reminder.label} ago)*`;

    if (reminder.channel_id) {
        try {
            const channel = await client.channels.fetch(reminder.channel_id);
            if (channel?.send) {
                await channel.send(text);
                return;
            }
        } catch {}
    }

    try {
        const user = await client.users.fetch(reminder.user_id);
        await user.send(text);
    } catch {
        console.error(`[remindme] Failed to deliver reminder id=${reminder.id} to user ${reminder.user_id}`);
    }
}

function scheduleReminder(client, reminder) {
    const delay = reminder.fire_at - Date.now();
    if (delay > MAX_TIMEOUT_MS) return;

    const safeDelay = Math.max(0, delay);
    setTimeout(() => fireReminder(client, reminder), safeDelay);
}

function startPoller(client) {
    setInterval(async () => {
        const now = Date.now();
        const due = getPending.all(now);
        for (const reminder of due) {
            await fireReminder(client, reminder);
        }
    }, 60_000);
}

function initReminders(client) {
    const now = Date.now();
    const allPending = db.prepare('SELECT * FROM reminders WHERE done = 0').all();
    for (const reminder of allPending) {
        if (reminder.fire_at <= now) {
            fireReminder(client, reminder);
        } else {
            scheduleReminder(client, reminder);
        }
    }

    startPoller(client);
    console.log(`[remindme] Initialized. ${allPending.length} pending reminder(s) loaded.`);
}

module.exports = {
    name: 'remindme',
    initReminders,

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
            const note    = interaction.options.getString('note') ?? null;

            const parsed = parseTime(timeStr);
            if (!parsed) {
                return interaction.reply({
                    content: 'Invalid time format. Use combinations like `3d`, `2h`, `30m`, or `1d 6h 30m`.',
                    ephemeral: true,
                });
            }

            const label  = formatDuration(parsed);
            const fireAt = Date.now() + parsed.ms;

            const reminder = {
                user_id:    interaction.user.id,
                channel_id: interaction.channelId ?? null,
                guild_id:   interaction.guildId   ?? null,
                note,
                fire_at:    fireAt,
                label,
            };

            const { lastInsertRowid } = insertReminder.run(reminder);
            reminder.id = Number(lastInsertRowid);

            scheduleReminder(interaction.client, reminder);

            await interaction.reply(
                `Reminder set for **${label}** from now${note ? ` about: *${note}*` : ''}.`
            );
        },
    },
};