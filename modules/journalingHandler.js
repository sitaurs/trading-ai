/**
 * @fileoverview Module untuk menangani semua proses journaling ke Google Sheets
 * dan membersihkan data trade yang sudah selesai.
 * @version 2.0.0 (Perbaikan Final dengan Circuit Breaker & Cleanup)
 */

const fs = require('fs/promises');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// --- MODUL INTERNAL ---
// PERBAIKAN: Menambahkan impor yang hilang untuk circuitBreaker
const circuitBreaker = require('./circuitBreaker');

// --- KONFIGURASI ---
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const CREDENTIALS_PATH = path.join(__dirname, '..', 'config', 'google-credentials.json');

const PENDING_DIR = path.join(__dirname, '..', 'pending_orders');
const POSITIONS_DIR = path.join(__dirname, '..', 'live_positions');
const JOURNAL_DIR = path.join(__dirname, '..', 'journal_data');


/**
 * Fungsi utama untuk mencatat trade yang sudah selesai.
 */
async function recordTrade(closedTradeData, closeReason, finalBrokerData = {}) {
    if (!closedTradeData || !closedTradeData.ticket) {
        console.error("[JOURNALING] Dibatalkan: Menerima data trade yang tidak valid.");
        return;
    }

    const { ticket, symbol, type, sl, tp, volume } = closedTradeData;
    const entryPrice = closedTradeData.price || closedTradeData.open_price || 'N/A';
    // PERBAIKAN: Memastikan 'profit' diambil dengan aman
    const profit = (finalBrokerData && finalBrokerData.profit !== undefined) ? finalBrokerData.profit : 'N/A';

    console.log(`[JOURNALING] Memulai proses pencatatan untuk tiket #${ticket}...`);

    // --- LOGIKA UNTUK MELAPORKAN KE CIRCUIT BREAKER ---
    const profitValue = parseFloat(profit);
    if (!isNaN(profitValue)) { 
        if (profitValue < 0) {
            await circuitBreaker.recordLoss();
        } else {
            await circuitBreaker.recordWin();
        }
    }
    // --- AKHIR DARI LOGIKA PELAPORAN ---

    try {
        const journalFilePath = path.join(JOURNAL_DIR, `journal_data_${symbol}.json`);
        let initialAnalysisText = 'Analisis awal tidak ditemukan.';
        try {
            const journalFile = await fs.readFile(journalFilePath, 'utf8');
            const journalData = JSON.parse(journalFile);
            if (journalData && journalData[ticket]) {
                initialAnalysisText = journalData[ticket];
            }
        } catch (e) {
            if (e.code !== 'ENOENT') console.error(`[JOURNALING] Error saat membaca file jurnal:`, e);
        }

        const serviceAccountAuth = new JWT({
            email: require(CREDENTIALS_PATH).client_email,
            key: require(CREDENTIALS_PATH).private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];

        const newRow = {
            'Tanggal': new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
            'Tiket': ticket,
            'Pair': symbol,
            'Arah': type,
            'Harga Buka': entryPrice,
            'Stop Loss': sl,
            'Take Profit': tp,
            'Volume': volume,
            'Status Penutupan': closeReason,
            'Profit': profit,
            'Analisis Awal': initialAnalysisText,
        };

        await sheet.addRow(newRow);
        console.log(`[JOURNALING] Tiket #${ticket} berhasil dicatat ke Google Sheet.`);
        await cleanupFiles(ticket, symbol);

    } catch (error) {
        console.error(`[JOURNALING] Gagal total saat memproses jurnal untuk tiket #${ticket}:`, error);
    }
}

/**
 * Membersihkan semua file yang terkait dengan tiket yang sudah selesai.
 */
async function cleanupFiles(ticket, symbol) {
    console.log(`[JOURNALING] Memulai pembersihan file untuk tiket #${ticket}...`);
    
    // PERBAIKAN: Membuat daftar file yang mungkin ada untuk dihapus agar lebih andal
    const filesToDelete = [
        path.join(PENDING_DIR, `pending_${symbol}.json`),
        path.join(PENDING_DIR, `trade_${symbol}.json`),
        path.join(POSITIONS_DIR, `position_${symbol}.json`),
        path.join(POSITIONS_DIR, `trade_${symbol}.json`)
    ];

    for (const filePath of filesToDelete) {
        await fs.unlink(filePath).catch(e => {
            // Abaikan error jika file tidak ada (ENOENT), karena itu tujuannya.
            if (e.code !== 'ENOENT') console.error(`Gagal menghapus file ${filePath}:`, e);
        });
    }

    // Hapus entri dari file jurnal
    const journalFilePath = path.join(JOURNAL_DIR, `journal_data_${symbol}.json`);
    try {
        const journalFile = await fs.readFile(journalFilePath, 'utf8');
        const journalData = JSON.parse(journalFile);
        
        if (journalData[ticket]) {
            delete journalData[ticket];
            // Jika objek jurnal kosong setelah dihapus, hapus file nya sekalian
            if (Object.keys(journalData).length === 0) {
                await fs.unlink(journalFilePath);
                console.log(`[JOURNALING] File jurnal ${path.basename(journalFilePath)} kosong dan telah dihapus.`);
            } else {
                await fs.writeFile(journalFilePath, JSON.stringify(journalData, null, 2), 'utf8');
            }
        }
    } catch (e) {
        if (e.code !== 'ENOENT') {
            console.error(`[JOURNALING] Gagal memperbarui file jurnal untuk tiket #${ticket}:`, e);
        }
    }
    
    console.log(`[JOURNALING] Pembersihan untuk tiket #${ticket} selesai.`);
}


module.exports = {
  recordTrade
};
