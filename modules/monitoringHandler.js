/**
 * @fileoverview Module untuk memonitor semua trade yang aktif dan pending.
 * @version 2.0.0 (Perbaikan Kritis dengan Fallback Notifikasi)
 */

const fs = require('fs').promises;
const path = require('path');
const broker = require('./brokerHandler');
const journaling = require('./journalingHandler'); // Menggunakan nama alias 'journaling' agar lebih singkat

// --- LOKASI DIREKTORI ---
const PENDING_DIR = path.join(__dirname, '..', 'pending_orders');
const POSITIONS_DIR = path.join(__dirname, '..', 'live_positions');

/**
 * Fungsi pembungkus untuk memastikan fungsi broadcast global tersedia sebelum digunakan.
 * @param {string} message - Pesan yang akan dikirim.
 */
const broadcast = (message) => {
    if (global.broadcastMessage) {
        global.broadcastMessage(message);
    } else {
        console.warn('[MONITORING] Peringatan: fungsi broadcastMessage global tidak ditemukan.');
    }
};

/**
 * Fungsi utama yang memeriksa semua status trade.
 * - Cek pending order yang menjadi live.
 * - Cek posisi live yang sudah ditutup.
 */
async function checkAllTrades() {
    console.log(`[MONITORING] Memulai pengecekan...`);

    try {
        // Ambil daftar posisi yang sedang aktif dari broker
        const activePositions = await broker.getActivePositions();
        const activeTickets = activePositions.map(p => p.ticket);

        // --- TUGAS A: Cek pending order yang menjadi posisi live ---
        // Logika ini sudah cukup baik dan tidak perlu diubah secara signifikan.
        const pendingFiles = await fs.readdir(PENDING_DIR).catch(() => []);
        for (const fileName of pendingFiles) {
            if (!fileName.endsWith('.json')) continue;

            const filePath = path.join(PENDING_DIR, fileName);
            const pendingData = JSON.parse(await fs.readFile(filePath, 'utf8'));

            // Jika tiket pending order ada di daftar posisi aktif, berarti sudah tereksekusi
            if (activeTickets.includes(pendingData.ticket)) {
                console.log(`[MONITORING] DETEKSI: Pending order #${pendingData.ticket} telah tereksekusi!`);
                
                // Pindahkan file dari folder 'pending_orders' ke 'live_positions'
                // Pindahkan file dari folder 'pending_orders' ke 'live_positions'
const newPositionFileName = `trade_${pendingData.symbol}.json`; // <-- NAMA FILE DISTANDARISASI
const newPath = path.join(POSITIONS_DIR, newPositionFileName);
// Langsung ganti nama file untuk memindahkannya. Ini lebih efisien.
await fs.rename(filePath, newPath);

broadcast(`✅ *Order Terekseskusi:* Pending order untuk ${pendingData.symbol} (#${pendingData.ticket}) telah menjadi posisi aktif.`);
            }
        }

        // ===================================================================================
        // == PERBAIKAN UTAMA DIMULAI DI SINI ==
        // ===================================================================================

        // --- TUGAS B: Cek posisi live yang sudah ditutup ---
        const localPositionFiles = await fs.readdir(POSITIONS_DIR).catch(() => []);
        for (const fileName of localPositionFiles) {
            if (!fileName.endsWith('.json')) continue;

            const filePath = path.join(POSITIONS_DIR, fileName);
            const positionData = JSON.parse(await fs.readFile(filePath, 'utf8'));

            // Jika tiket posisi yang tersimpan di lokal TIDAK ADA di daftar posisi aktif, berarti sudah ditutup
            if (!activeTickets.includes(positionData.ticket)) {
                console.log(`[MONITORING] DETEKSI: Posisi #${positionData.ticket} (${positionData.symbol}) telah ditutup.`);

                // Panggil fungsi BARU dari brokerHandler yang sudah diperbaiki
                const closingDeal = await broker.getClosingDealInfo(positionData.ticket);

                // --- LOGIKA JARING PENGAMAN (FALLBACK) ---
                if (closingDeal) {
                    // KASUS 1: SUKSES! Detail penutupan ditemukan.
                    const profit = closingDeal.profit;
                    const reasonCode = closingDeal.reason;
                    let closeReasonText = 'Ditutup Manual';
                    let notificationMessage = '';

                    // Reason 5 = Take Profit, Reason 4 = Stop Loss (sesuaikan jika berbeda di broker Anda)
                    if (reasonCode === 5) {
                        closeReasonText = 'Take Profit Hit';
                        notificationMessage = `✅ *TP HIT:* Posisi ${positionData.symbol} (#${positionData.ticket}) mencapai Take Profit.\nProfit: ${profit.toFixed(2)}`;
                    } else if (reasonCode === 4) {
                        closeReasonText = 'Stop Loss Hit';
                        notificationMessage = `🛑 *SL HIT:* Posisi ${positionData.symbol} (#${positionData.ticket}) menyentuh Stop Loss.\nProfit: ${profit.toFixed(2)}`;
                    } else {
                        notificationMessage = `ℹ️ *POSISI DITUTUP:* Posisi ${positionData.symbol} (#${positionData.ticket}) telah ditutup.\nProfit/Loss: ${profit.toFixed(2)}`;
                    }
                    
                    broadcast(notificationMessage);
                    // Kirim data yang akurat ke journaling
                    await journaling.recordTrade(positionData, closeReasonText, closingDeal);

                } else {
                    // KASUS 2: GAGAL! Detail penutupan TIDAK ditemukan.
                    console.warn(`[MONITORING] PERINGATAN: Tidak dapat menemukan detail closing deal untuk #${positionData.ticket}. Mengirim notifikasi darurat.`);
                    
                    // Kirim notifikasi darurat ke pengguna
                    const fallbackMessage = `⚠️ *NOTIFIKASI MANUAL:* Posisi #${positionData.ticket} (${positionData.symbol}) telah ditutup, namun detail profit/loss tidak dapat diambil secara otomatis. Silakan cek terminal Anda.`;
                    broadcast(fallbackMessage);

                    // Tetap arsipkan jurnal agar tidak diperiksa lagi, tandai sebagai "Unknown"
                    // Ini mencegah bot mengirim notifikasi yang sama berulang kali.
                    await journaling.recordTrade(positionData, 'Closed - Reason Unknown', { profit: 0 });
                }
            }
        }
        // ===================================================================================
        // == PERBAIKAN UTAMA SELESAI ==
        // ===================================================================================

    } catch (mainError) {
        console.error('[MONITORING] Terjadi error besar di dalam loop monitoring:', mainError);
    }
    console.log(`[MONITORING] Pengecekan selesai.`);
}

module.exports = {
  checkAllTrades
};
