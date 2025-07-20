const fs = require('fs').promises;
const path = require('path');

const STATS_PATH = path.join(__dirname, '..', 'config', 'circuit_breaker_stats.json');
const MAX_CONSECUTIVE_LOSSES = 3; // Anda bisa mengubah angka ini nanti

async function getStats() {
    try {
        const data = await fs.readFile(STATS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return { consecutiveLosses: 0, lastResetDate: new Date().toISOString().split('T')[0] };
    }
}

async function saveStats(stats) {
    await fs.writeFile(STATS_PATH, JSON.stringify(stats, null, 2));
}

async function recordLoss() {
    const stats = await getStats();
    stats.consecutiveLosses += 1;
    console.log(`[Circuit Breaker] Kerugian dicatat. Total kerugian beruntun: ${stats.consecutiveLosses}`);
    await saveStats(stats);
}

async function recordWin() {
    const stats = await getStats();
    if (stats.consecutiveLosses > 0) {
        console.log(`[Circuit Breaker] Keuntungan dicatat. Kerugian beruntun direset ke 0.`);
        stats.consecutiveLosses = 0;
        await saveStats(stats);
    }
}

async function isTripped() {
    const stats = await getStats();
    const today = new Date().toISOString().split('T')[0];

    if (stats.lastResetDate !== today) {
        console.log('[Circuit Breaker] Hari baru, penghitung kerugian direset.');
        stats.consecutiveLosses = 0;
        stats.lastResetDate = today;
        await saveStats(stats);
        return false;
    }

    if (stats.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
        console.warn(`[Circuit Breaker] !!! CIRCUIT BREAKER AKTIF: Mencapai ${stats.consecutiveLosses} kerugian beruntun.`);
        return true;
    }

    return false;
}

module.exports = { isTripped, recordLoss, recordWin };