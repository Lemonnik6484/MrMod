const path = require('path');
const fs   = require('fs');

fs.mkdirSync(path.join(__dirname, '../module_data/mapw-mc'), { recursive: true });

function loadJson(filename) {
    const filepath = path.join(__dirname, `../module_data/mapw-mc/${filename}`);
    try {
        return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch (err) {
        console.warn(`[mapw-mc] Could not load ${filename}:`, err.message);
        return null;
    }
}

function getBots()  { return loadJson('bots.json')?.bots  ?? []; }
function getLinks() { return loadJson('links.json')        ?? {}; }

let _scoreMessage = null;

function getScoreMessage() {
    if (_scoreMessage) return _scoreMessage;
    try {
        const mapw = require('./mapw.js');
        if (typeof mapw.scoreMessage !== 'function') {
            console.error('[mapw-mc] mapw.js does not export scoreMessage. See setup notes.');
            return null;
        }
        _scoreMessage = mapw.scoreMessage;
        return _scoreMessage;
    } catch (err) {
        console.error('[mapw-mc] Failed to require mapw.js:', err.message);
        return null;
    }
}

function parseBridgeMessage(text) {
    const clean = text?.replace(/\*\*/g, '').replace(/\\/g, '').trim();

    if (clean.includes("xaero-waypoint")) return null;

    const colonMatch = clean.match(/^([A-Za-z0-9_]{2,16}):\s+(.+)$/s);
    if (colonMatch) return { mcName: colonMatch[1], content: colonMatch[2] };

    const bracketMatch = clean.match(/^\[([A-Za-z0-9_]{2,16})\]\s+(.+)$/s);
    if (bracketMatch) return { mcName: bracketMatch[1], content: bracketMatch[2] };

    return null;
}

const events = {
    async messageCreate(message) {
        if (!message.guildId) return;

        const bots = getBots();
        if (!bots.length) return;

        const isBot = bots.includes(message.author.id);

        let parsed = null;

        if (isBot) {
            parsed = parseBridgeMessage(message.content);
        } else if (message.webhookId) {
            const webhookName = message.author.username;
            const isValidMcName = /^[A-Za-z0-9_]{2,16}$/.test(webhookName);
            if (isValidMcName) {
                parsed = {
                    mcName: webhookName,
                    content: message.content,
                };
            }
        }

        if (!parsed) return;

        const { mcName, content } = parsed;

        const links = getLinks();
        const userId = links[mcName];
        if (!userId) return;

        const scoreMessage = getScoreMessage();
        if (!scoreMessage) return;

        const pts = scoreMessage(message.guildId, userId, content);
        if (pts > 0) {
            console.log(`[mapw-mc] +${pts.toFixed(2)} pts → ${mcName} (${userId})`);
        }
    },
};

module.exports = {
    name: 'mapw-mc',
    events,
};