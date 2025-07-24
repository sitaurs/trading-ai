/**
 * @fileoverview Module untuk menangani semua proses journaling ke Google Sheets
 * dan membersihkan data trade yang sudah selesai.
 * @version 2.0.0 (Perbaikan Final dengan Circuit Breaker & Cleanup)
 */

const fs = require('fs/promises');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { getLogger } = require('./logger');
const log = getLogger('Journaling');

// --- MODUL INTERNAL ---
// Fallback untuk mengambil informasi deal jika data profit tidak tersedia
const broker = require('./brokerHandler');

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
        log.error("[JOURNALING] Dibatalkan: Menerima data trade yang tidak valid.");
        return;
    }

    const { ticket, symbol, type, sl, tp, volume } = closedTradeData;
    const entryPrice = closedTradeData.price || closedTradeData.open_price || 'N/A';
    let profit = (finalBrokerData && finalBrokerData.profit !== undefined) ? finalBrokerData.profit : undefined;

    if (profit === undefined) {
        const dealInfo = await broker.getClosingDealInfo(ticket);
        if (dealInfo && dealInfo.profit !== undefined) {
            profit = dealInfo.profit;
        }
    }
    if (profit === undefined) profit = 'N/A';

    log.info(`[JOURNALING] Memulai proses pencatatan untuk tiket #${ticket}...`);



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
            if (e.code !== 'ENOENT') log.error(`[JOURNALING] Error saat membaca file jurnal:`, e);
        }

        let credentials;
        try {
            const raw = await fs.readFile(CREDENTIALS_PATH, 'utf8');
            if (raw.includes('isi kredensial')) throw new Error('Placeholder');
            credentials = JSON.parse(raw);
        } catch (credErr) {
            log.error('[JOURNALING] google-credentials.json belum dikonfigurasi dengan benar. Pencatatan ke Sheets dilewati.');
            throw credErr;
        }

        const serviceAccountAuth = new JWT({
            email: credentials.client_email,
            key: credentials.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];

        const meta = closedTradeData.meta || {};
        const exitType = /Take Profit/i.test(closeReason) ? 'TP' : (/Stop Loss/i.test(closeReason) ? 'SL' : 'CLOSE_MANUAL');
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
            'Session Segment': meta.session_segment || '',
            'Wick/ATR': meta.wick_atr_ratio || '',
            'Hard Filter Pass': meta.hard_filter_pass !== false,
            'Hard Filter Reason': meta.hard_filter_reason || '',
            'Exit Type': exitType,
            'R_result': 0
        };

        await sheet.addRow(newRow);
        log.info(`[JOURNALING] Tiket #${ticket} berhasil dicatat ke Google Sheet.`);

    } catch (error) {
        // Jika penulisan ke Google Sheets gagal kita tetap ingin
        // membersihkan data lokal agar monitoring tidak berulang
        log.error(`[JOURNALING] Gagal total saat memproses jurnal untuk tiket #${ticket}:`, error);
    } finally {
        // Jalankan cleanup apapun hasilnya
        await cleanupFiles(ticket, symbol);
    }
}

/**
 * Membersihkan semua file yang terkait dengan tiket yang sudah selesai.
 */
async function cleanupFiles(ticket, symbol) {
    log.info(`[JOURNALING] Memulai pembersihan file untuk tiket #${ticket}...`);
    
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
            if (e.code !== 'ENOENT') log.error(`Gagal menghapus file ${filePath}:`, e);
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
                log.info(`[JOURNALING] File jurnal ${path.basename(journalFilePath)} kosong dan telah dihapus.`);
            } else {
                await fs.writeFile(journalFilePath, JSON.stringify(journalData, null, 2), 'utf8');
            }
        }
    } catch (e) {
        if (e.code !== 'ENOENT') {
            log.error(`[JOURNALING] Gagal memperbarui file jurnal untuk tiket #${ticket}:`, e);
        }
    }
    
    log.info(`[JOURNALING] Pembersihan untuk tiket #${ticket} selesai.`);
}


module.exports = {
  recordTrade
};
