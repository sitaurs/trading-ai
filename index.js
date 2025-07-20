/**
 * @fileoverview Titik masuk utama untuk aplikasi Bot Trading.
 * Menginisialisasi koneksi WhatsApp, menjadwalkan analisis, dan menjalankan loop monitoring.
 * @version 2.1.0 (Upgrade dengan fitur kontrol dan notifikasi lengkap)
 */

require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const cron = require('node-cron');

// Impor modul yang sudah ada
const { startWhatsAppClient } = require('./modules/whatsappClient');
const analysisHandler = require('./modules/analysisHandler');
const commandHandler = require('./modules/commandHandler');
const monitoringHandler = require('./modules/monitoringHandler');

// --- Konfigurasi Terpusat ---
const SUPPORTED_PAIRS = process.env.SUPPORTED_PAIRS
    ? process.env.SUPPORTED_PAIRS.split(',').map(p => p.trim().toUpperCase())
    : ['USDJPY', 'USDCHF', 'GBPUSD'];

const CONFIG_DIR = path.join(__dirname, 'config');
const RECIPIENTS_FILE = path.join(CONFIG_DIR, 'recipients.json');

// --- Variabel Global ---
global.botSettings = {};
let whatsappSocket;

// --- Fungsi Helper ---

/**
 * Memuat daftar penerima dari file JSON.
 */
async function loadRecipients() {
    try {
        await fs.access(RECIPIENTS_FILE);
        const data = await fs.readFile(RECIPIENTS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.warn("Warning: File config/recipients.json tidak ditemukan. Membuat file baru...");
        await writeJsonFile(RECIPIENTS_FILE, []);
        return [];
    }
}

/**
 * Helper untuk menulis file JSON.
 */
async function writeJsonFile(filePath, data) {
    const dir = path.dirname(filePath);
    try {
        await fs.access(dir);
    } catch (error) {
        await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * (BARU) Fungsi global untuk mengirim pesan ke semua penerima.
 * Digunakan oleh modul lain seperti monitoringHandler.
 */
global.broadcastMessage = (messageText) => {
    // Pastikan socket dan daftar penerima sudah siap
    if (whatsappSocket && global.botSettings && global.botSettings.recipients) {
        console.log(`[BROADCAST] Mengirim pesan: "${messageText}"`);
        for (const id of global.botSettings.recipients) {
            whatsappSocket.sendMessage(id, { text: messageText }).catch(err => {
                console.error(`Gagal kirim pesan broadcast ke ${id}:`, err);
            });
        }
    }
};

/**
 * Fungsi utama aplikasi
 */
async function main() { // PERBAIKAN: Kurung kurawal pembuka dipindahkan ke sini
    console.log('Memulai bot...');
    global.botSettings = {
        isNewsEnabled: process.env.ENABLE_NEWS_SEARCH === 'true',
        recipients: await loadRecipients()
    };
    console.log('Pengaturan awal dimuat:', { isNewsEnabled: global.botSettings.isNewsEnabled });
    console.log('Penerima notifikasi dimuat:', global.botSettings.recipients);

    whatsappSocket = await startWhatsAppClient();

    // --- Mengaktifkan Siklus Monitoring Otomatis ---
    const intervalMinutes = process.env.MONITORING_INTERVAL_MINUTES || 2;
    const intervalMs = intervalMinutes * 60 * 1000;

    console.log(`🤖 Bot siap. Siklus monitoring akan berjalan setiap ${intervalMinutes} menit.`);
    
    setTimeout(() => {
        monitoringHandler.checkAllTrades();
    }, 5000); 

    setInterval(() => {
        monitoringHandler.checkAllTrades();
    }, intervalMs);


    // --- Listener Pesan WhatsApp ---
    whatsappSocket.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const chatId = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        if (!text) return;

        const command = text.split(' ')[0].toLowerCase();
        
        try {
            console.log(`Menerima perintah: "${text}" dari ${chatId}`);
            
            // PERBAIKAN: Blok switch yang sudah di-upgrade
            switch (command) {
                case '/menu':
                case '/help':
                    const menuText = `
🤖 *MENU BANTUAN BOT TRADING* 🤖

*ANALISIS*
▫️ \`/dxy\` : Analisis DXY.
▫️ \`/${SUPPORTED_PAIRS.join(', /').toLowerCase()}\` : Analisis Pair.

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
                    `;
                    await whatsappSocket.sendMessage(chatId, { text: menuText.trim() });
                    break;
                case '/status':
                    await commandHandler.handleConsolidatedStatusCommand(SUPPORTED_PAIRS, global.botSettings, whatsappSocket, chatId);
                    break;
                case '/etr':
                    await commandHandler.handleEntryCommand(text, chatId, whatsappSocket);
                    break;
                case '/cls':
                    await commandHandler.handleCloseCommand(text, chatId, whatsappSocket);
                    break;
                case '/settings':
                case '/setting':
                    await commandHandler.handleSettingsCommand(text, global.botSettings, chatId, whatsappSocket);
                    break;
                case '/add_recipient':
                    await commandHandler.handleAddRecipient(text, chatId, whatsappSocket);
                    break;
                case '/del_recipient':
                    await commandHandler.handleDelRecipient(text, chatId, whatsappSocket);
                    break;
                case '/list_recipients':
                    await commandHandler.handleListRecipients(chatId, whatsappSocket);
                    break;
                case '/pause': // Perintah baru
                    await commandHandler.handlePauseCommand(whatsappSocket, chatId);
                    break;
                case '/resume': // Perintah baru
                    await commandHandler.handleResumeCommand(whatsappSocket, chatId);
                    break;
                case '/profit_today': // Perintah baru
                    await commandHandler.handleProfitTodayCommand(whatsappSocket, chatId);
                    break;
                case '/dxy':
                    if (global.botSettings.recipients.length === 0) return;
                    await analysisHandler.analyzeDXY(whatsappSocket, global.botSettings.recipients);
                    break;
                case '/analisis_semua':
                     if (global.botSettings.recipients.length === 0) return;
                    await analysisHandler.runScheduledAnalysis(SUPPORTED_PAIRS, global.botSettings, whatsappSocket, global.botSettings.recipients);
                    break;
                default:
                    const requestedPair = command.substring(1).toUpperCase();
                    if (SUPPORTED_PAIRS.includes(requestedPair)) {
                        if (global.botSettings.recipients.length === 0) return;
                        await analysisHandler.handleAnalysisRequest(requestedPair, null, global.botSettings, whatsappSocket, global.botSettings.recipients);
                    }
                    break; 
            }
        } catch (error) {
            console.error(`Error saat memproses perintah "${text}":`, error);
            await whatsappSocket.sendMessage(chatId, { text: `Terjadi kesalahan internal: ${error.message}` });
        }
    });

    // --- Jadwal Analisis Otomatis ---
    // PERBAIKAN: Blok cron yang sudah di-upgrade
    cron.schedule('0 */1 * * *', async () => {
        try {
            const statusData = await fs.readFile(path.join(__dirname, 'config', 'bot_status.json'), 'utf8');
            const status = JSON.parse(statusData);

            if (status.isPaused) {
                console.log("[CRON] Analisis terjadwal dilewati karena bot dalam mode jeda (paused).");
                return;
            }

            if (global.botSettings.recipients && global.botSettings.recipients.length > 0) {
                console.log("[CRON] --- Menjalankan Analisis Terjadwal Otomatis ---");
                await analysisHandler.runScheduledAnalysis(SUPPORTED_PAIRS, global.botSettings, whatsappSocket, global.botSettings.recipients);
            } else {
                console.log("[CRON] --- Analisis Terjadwal dilewati, tidak ada penerima notifikasi ---");
            }
        } catch (error) {
            // Jika file bot_status.json belum ada, anggap saja tidak dijeda
            if (error.code === 'ENOENT') {
                 console.log("[CRON] --- Menjalankan Analisis Terjadwal Otomatis (file status tidak ditemukan) ---");
                 await analysisHandler.runScheduledAnalysis(SUPPORTED_PAIRS, global.botSettings, whatsappSocket, global.botSettings.recipients);
            } else {
                console.error("[CRON] Error saat menjalankan analisis terjadwal:", error);
            }
        }
    });

} // PERBAIKAN: Kurung kurawal penutup untuk fungsi main()

// Panggil fungsi main untuk memulai bot
main().catch(error => {
    console.error('Gagal total saat memulai bot:', error);
    process.exit(1);
});
