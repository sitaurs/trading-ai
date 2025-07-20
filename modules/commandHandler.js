/**
 * @fileoverview Module untuk menangani semua perintah manual dari pengguna via WhatsApp.
 * @version 2.3.0 (Perbaikan Final dengan Menu & Status Baru)
 */

const fs = require('fs').promises;
const path = require('path');

// Impor modul dan definisikan path yang relevan
const broker = require('./brokerHandler');
const journalingHandler = require('./journalingHandler');
// PERBAIKAN: Menambahkan impor yang hilang
const analysisHandler = require('./analysisHandler');

const PENDING_DIR = path.join(__dirname, '..', 'pending_orders');
const POSITIONS_DIR = path.join(__dirname, '..', 'live_positions');
const CACHE_DIR = path.join(__dirname, '..', 'analysis_cache');
const CONFIG_DIR = path.join(__dirname, '..', 'config');
const RECIPIENTS_FILE = path.join(CONFIG_DIR, 'recipients.json');
const BOT_STATUS_PATH = path.join(CONFIG_DIR, 'bot_status.json');


// --- Fungsi Helper ---

async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function writeJsonFile(filePath, data) {
    const dir = path.dirname(filePath);
    try {
        await fs.access(dir);
    } catch (error) {
        await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}


// --- FUNGSI-FUNGSI COMMAND HANDLER ---

async function handleMenuCommand(whatsappSocket, chatId, supportedPairs = []) {
    // PERBAIKAN: Memperbarui menu dengan semua perintah baru
    const menuText = `
🤖 *MENU BANTUAN BOT TRADING* 🤖

*ANALISIS*
▫️ \`/dxy\` : Analisis DXY.
▫️ \`/${supportedPairs.join(', /').toLowerCase()}\` : Analisis Pair.

*MANAJEMEN & LAPORAN*
▫️ \`/status\` : Status lengkap bot.
▫️ \`/cls PAIR\` : Menutup trade.
▫️ \`/profit_today\` : Laporan profit/loss hari ini.

*KONTROL BOT*
▫️ \`/pause\` : Menghentikan sementara trading terjadwal.
▫️ \`/resume\` : Melanjutkan trading terjadwal.

*NOTIFIKASI*
▫️ \`/list_recipients\`
▫️ \`/add_recipient <ID>\`
▫️ \`/del_recipient <ID>\`

*PENGATURAN*
▫️ \`/setting berita <on|off>\`
    `;
    await whatsappSocket.sendMessage(chatId, { text: menuText.trim() });
}


async function handleAddRecipient(command, chatId, whatsappSocket) {
    const parts = command.split(' ');
    if (parts.length < 2) {
        return whatsappSocket.sendMessage(chatId, { text: 'Format salah. Gunakan: `/add_recipient <ID_WA>`\nContoh: `/add_recipient 628123456789@s.whatsapp.net`' });
    }
    const newRecipientId = parts[1];
    let recipients = await readJsonFile(RECIPIENTS_FILE) || [];
    if (recipients.includes(newRecipientId)) {
        return whatsappSocket.sendMessage(chatId, { text: `⚠️ ID ${newRecipientId} sudah ada dalam daftar.` });
    }
    recipients.push(newRecipientId);
    await writeJsonFile(RECIPIENTS_FILE, recipients);
    if (global.botSettings) {
        global.botSettings.recipients = recipients;
    }
    await whatsappSocket.sendMessage(chatId, { text: `✅ Berhasil menambahkan ${newRecipientId} ke daftar penerima.` });
}

async function handleDelRecipient(command, chatId, whatsappSocket) {
    const parts = command.split(' ');
    if (parts.length < 2) {
        return whatsappSocket.sendMessage(chatId, { text: 'Format salah. Gunakan: `/del_recipient <ID_WA>`' });
    }
    const recipientToRemove = parts[1];
    let recipients = await readJsonFile(RECIPIENTS_FILE) || [];
    const initialLength = recipients.length;
    recipients = recipients.filter(id => id !== recipientToRemove);
    if (recipients.length === initialLength) {
        return whatsappSocket.sendMessage(chatId, { text: `⚠️ ID ${recipientToRemove} tidak ditemukan dalam daftar.` });
    }
    await writeJsonFile(RECIPIENTS_FILE, recipients);
    if (global.botSettings) {
        global.botSettings.recipients = recipients;
    }
    await whatsappSocket.sendMessage(chatId, { text: `🗑️ Berhasil menghapus ${recipientToRemove} dari daftar penerima.` });
}

async function handleListRecipients(chatId, whatsappSocket) {
    const recipients = await readJsonFile(RECIPIENTS_FILE) || [];
    if (recipients.length === 0) {
        return whatsappSocket.sendMessage(chatId, { text: 'Daftar penerima notifikasi kosong.' });
    }
    let message = '📋 *Daftar Penerima Notifikasi:*\n\n';
    recipients.forEach((id, index) => {
        message += `${index + 1}. ${id}\n`;
    });
    await whatsappSocket.sendMessage(chatId, { text: message.trim() });
}

async function handleSettingsCommand(command, botSettings, chatId, whatsappSocket) {
    const parts = command.split(' ');
    if (parts.length < 3) {
        return await whatsappSocket.sendMessage(chatId, { text: 'Format salah. Gunakan: `/setting <tipe> <on|off>`\nContoh: `/setting berita on`' });
    }
    const settingType = parts[1].toLowerCase();
    const value = parts[2].toLowerCase();
    if (!['on', 'off'].includes(value)) {
        return await whatsappSocket.sendMessage(chatId, { text: 'Nilai tidak valid. Gunakan "on" atau "off".' });
    }
    const isActive = value === 'on';
    let responseMessage = 'Tipe pengaturan tidak dikenali. Gunakan "berita".';
    if (settingType === 'berita') {
        botSettings.isNewsEnabled = isActive;
        responseMessage = `✅ Pengaturan Pencarian Berita sekarang: *${isActive ? 'AKTIF' : 'NONAKTIF'}*`;
    }
    console.log('Pengaturan diubah:', botSettings);
    await whatsappSocket.sendMessage(chatId, { text: responseMessage });
}

async function handleConsolidatedStatusCommand(supportedPairs, botSettings, whatsappSocket, chatId) {
    await whatsappSocket.sendMessage(chatId, { text: '🔍 Mengambil status bot terkini...' });
    let statusText = '⚙️ *RINGKASAN STATUS BOT*\n\n';
    try {
        const dxyCache = await readJsonFile(path.join(CACHE_DIR, 'last_result_DXY.json'));
        if (dxyCache && dxyCache.analysis_text && dxyCache.last_updated) {
            const dxySentiment = dxyCache.analysis_text.split('\n')[0] || 'Tidak ada sentimen';
            const lastUpdated = new Date(dxyCache.last_updated).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
            statusText += `*DXY Sentiment:* ${dxySentiment}\n_(Diperbarui: ${lastUpdated})_\n\n`;
        } else {
            statusText += '*DXY Sentiment:* Belum ada data.\n\n';
        }
    } catch (error) {
        statusText += '*DXY Sentiment:* Gagal memuat data.\n\n';
    }
    statusText += '*Status Trade Saat Ini:*\n';
    for (const pair of supportedPairs) {
        // PERBAIKAN: Menggunakan format nama file yang konsisten
        const pendingPath = path.join(PENDING_DIR, `trade_${pair}.json`);
        const livePath = path.join(POSITIONS_DIR, `trade_${pair}.json`);
        const isPending = await readJsonFile(pendingPath);
        const isLive = await readJsonFile(livePath);
        if (isPending) {
            statusText += `  🟡 *${pair}: PENDING* (Tiket: ${isPending.ticket})\n`;
        } else if (isLive) {
            statusText += `  🟢 *${pair}: AKTIF* (Tiket: ${isLive.ticket})\n`;
        } else {
            statusText += `  🔴 *${pair}: TIDAK AKTIF*\n`;
        }
    }
    statusText += '\n*Pengaturan Bot:*\n';
    const newsStatus = botSettings.isNewsEnabled ? 'AKTIF' : 'NONAKTIF';
    statusText += `  ▶️ Pencarian Berita: *${newsStatus}*`;
    await whatsappSocket.sendMessage(chatId, { text: statusText });
}

async function handleCloseCommand(text, chatId, whatsappSocket) {
    const parts = text.split(' ');
    if (parts.length < 2) {
        return whatsappSocket.sendMessage(chatId, { text: 'Format perintah salah. Contoh: `/cls usdjpy`' });
    }
    const pair = parts[1].toUpperCase();
    await whatsappSocket.sendMessage(chatId, { text: `⏳ Mencoba menutup/membatalkan order untuk *${pair}*...` });

    try {
        // PERBAIKAN: Mencari file dengan format yang konsisten
// PERBAIKAN: Mencari file dengan format yang konsisten
    const pendingOrderPath = path.join(PENDING_DIR, `trade_${pair}.json`);
    const livePositionPath = path.join(POSITIONS_DIR, `trade_${pair}.json`); // <-- PERBAIKI PATH INI

    // Cari di kedua folder, tentukan tipe berdasarkan folder mana yang ada filenya
    const tradeToClose = await readJsonFile(livePositionPath) || await readJsonFile(pendingOrderPath);
    const tradeType = await readJsonFile(livePositionPath) ? 'live' : 'pending';

    if (!tradeToClose || !tradeToClose.ticket) {
        return whatsappSocket.sendMessage(chatId, { text: `❌ Tidak ditemukan order aktif atau pending untuk *${pair}*.` });
}

        let closeResult;
        let closeReason;

        if (tradeType === 'pending') {
            console.log(`[COMMAND HANDLER] Membatalkan pending order #${tradeToClose.ticket} secara manual.`);
            closeResult = await broker.cancelPendingOrder(tradeToClose.ticket);
            closeReason = 'Manual Cancel by User';
        } else { // tradeType === 'live'
            console.log(`[COMMAND HANDLER] Menutup posisi #${tradeToClose.ticket} secara manual.`);
            closeResult = await broker.closePosition(tradeToClose.ticket);
            closeReason = 'Manual Close by User';
        }

        await journalingHandler.recordTrade(tradeToClose, closeReason, closeResult);
        await whatsappSocket.sendMessage(chatId, { text: `✅ *SUKSES!* Order untuk *${pair}* (#${tradeToClose.ticket}) telah ditutup/dibatalkan.` });

    } catch (error) {
        console.error(`[COMMAND HANDLER] Gagal saat menjalankan /cls untuk ${pair}:`, error);
        await whatsappSocket.sendMessage(chatId, { text: `❌ Gagal menutup order untuk *${pair}*.\n*Error:* ${error.message}` });
    }
}

async function handleEntryCommand(command, chatId, whatsappSocket) {
    await whatsappSocket.sendMessage(chatId, { 
        text: '⚠️ Perintah `/etr` sudah tidak digunakan di sistem V7.\n\nBot sekarang akan membuka posisi secara otomatis berdasarkan hasil analisis. Untuk menutup posisi, gunakan `/cls PAIR`.' 
    });
}

async function handlePauseCommand(whatsappSocket, chatId) {
    await writeJsonFile(BOT_STATUS_PATH, { isPaused: true });
    await whatsappSocket.sendMessage(chatId, { text: '⏸️ *Bot Dijeda.* Analisis trading terjadwal telah dihentikan.' });
}

async function handleResumeCommand(whatsappSocket, chatId) {
    await writeJsonFile(BOT_STATUS_PATH, { isPaused: false });
    await whatsappSocket.sendMessage(chatId, { text: '▶️ *Bot Dilanjutkan.* Analisis trading terjadwal telah diaktifkan kembali.' });
}

async function handleProfitTodayCommand(whatsappSocket, chatId) {
    await whatsappSocket.sendMessage(chatId, { text: '💰 Menghitung profit hari ini, mohon tunggu...' });
    const totalProfit = await broker.getTodaysProfit();
    if (totalProfit === null) {
        await whatsappSocket.sendMessage(chatId, { text: 'Gagal mengambil data profit. Silakan periksa log.' });
    } else {
        const profitMessage = totalProfit >= 0
            ? `✅ *Profit Hari Ini:* +${totalProfit.toFixed(2)}`
            : `🔻 *Loss Hari Ini:* ${totalProfit.toFixed(2)}`;
        await whatsappSocket.sendMessage(chatId, { text: profitMessage });
    }
}

module.exports = {
    handleMenuCommand,
    handleConsolidatedStatusCommand,
    handleEntryCommand,
    handleCloseCommand,
    handleSettingsCommand,
    handleAddRecipient,
    handleDelRecipient,
    handleListRecipients,
    handlePauseCommand,
    handleResumeCommand,
    handleProfitTodayCommand
};
