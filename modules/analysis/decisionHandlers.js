const path = require('path');
const broker = require('../brokerHandler');
const journalingHandler = require('../journalingHandler');
const { getLogger } = require('../logger');
const { writeJsonFile, readJsonFile, broadcastMessage, PENDING_DIR, POSITIONS_DIR, JOURNAL_DIR } = require('./helpers');
const log = getLogger('DecisionHandlers');

async function saveOrderData(orderData, initialAnalysisText, meta = {}) {
    const { ticket, symbol } = orderData;
    log.info(`Menyimpan data untuk order #${ticket} (${symbol}).`);
    const isPending = orderData.type.includes('LIMIT') || orderData.type.includes('STOP');
    const targetDir = isPending ? PENDING_DIR : POSITIONS_DIR;
    const fileName = `trade_${symbol}.json`;
    const orderFilePath = path.join(targetDir, fileName);
    const journalFilePath = path.join(JOURNAL_DIR, `journal_data_${symbol}.json`);
    try {
        await writeJsonFile(orderFilePath, { ...orderData, meta });
        let journalData = await readJsonFile(journalFilePath) || {};
        journalData[ticket] = initialAnalysisText;
        await writeJsonFile(journalFilePath, journalData);
        log.info(`Pencatatan untuk order #${ticket} selesai.`);
    } catch (err) {
        log.error(`Gagal menyimpan data untuk order #${ticket}.`, err);
    }
}

async function handleOpenDecision(extractedData, narrativeAnalysisResult, whatsappSocket, recipientIds, analysisMeta = {}) {
    const { pair, arah, harga, sl, tp } = extractedData;
    log.info(`AI memutuskan OPEN. Mencoba eksekusi trade untuk ${pair}...`);
    const orderPayload = { symbol: pair, type: arah, price: harga || 0, sl, tp, volume: parseFloat(process.env.TRADE_VOLUME) || 0.01, comment: `BotV7 | ${pair}` };
    log.debug('Payload order yang dikirim ke broker:', orderPayload);
    const brokerResult = await broker.openOrder(orderPayload);
    const ticketId = brokerResult.order || brokerResult.deal || brokerResult.ticket;
    if (!ticketId) throw new Error('Eksekusi order berhasil, tetapi gagal mendapatkan ticket ID dari broker.');
    log.info(`Broker berhasil mengeksekusi order. Tiket: #${ticketId}`);
    const finalOrderData = { ...orderPayload, ticket: ticketId };
    await saveOrderData(finalOrderData, narrativeAnalysisResult, analysisMeta);
    await broadcastMessage(whatsappSocket, recipientIds, { text: `✅ *AKSI DIAMBIL!* Order ${pair} (${arah}) telah dieksekusi.\n*Tiket:* #${ticketId}` });
}

async function handleCloseDecision(extractedData, activeTrade, whatsappSocket, recipientIds) {
    const pair = activeTrade ? activeTrade.symbol : extractedData.pair;
    log.info(`AI memutuskan CLOSE_MANUAL untuk ${pair}.`);
    if (!activeTrade || !activeTrade.ticket) {
        log.warn(`AI menyarankan tutup, tapi tidak ada data trade aktif tercatat untuk ${pair}.`);
        await broadcastMessage(whatsappSocket, recipientIds, { text: `ℹ️ *Info:* Analisis menyarankan tutup, tetapi tidak ada posisi aktif yang tercatat untuk ${pair}. Mungkin sudah ditutup manual.` });
        return;
    }
    const { ticket } = activeTrade;
    let actionText = '';
    try {
        const isPending = activeTrade.type.includes('LIMIT') || activeTrade.type.includes('STOP');
        if (isPending) {
            log.info(`Mencoba membatalkan PENDING order #${ticket}...`);
            await broker.cancelPendingOrder(ticket);
            actionText = 'dibatalkan';
        } else {
            log.info(`Mencoba menutup LIVE posisi #${ticket}...`);
            await broker.closePosition(ticket);
            actionText = 'ditutup';
        }
        log.info(`Order/Posisi #${ticket} berhasil ${actionText} di broker.`);
    } catch (err) {
        if (err.message && err.message.includes('Invalid request')) {
            log.warn(`Gagal batalkan pending #${ticket}. Mencoba menutup sebagai posisi LIVE...`);
            await broker.closePosition(ticket);
            actionText = 'ditutup (fallback)';
            log.info(`Fallback berhasil! Posisi #${ticket} ditutup sebagai live.`);
        } else {
            throw err;
        }
    }
    const closeReason = `Manual Close by AI (${extractedData.alasan || 'No reason specified'})`;
    const closingDeal = await broker.getClosingDealInfo(ticket);
    await journalingHandler.recordTrade(activeTrade, closeReason, closingDeal || {});
    await broadcastMessage(whatsappSocket, recipientIds, { text: `✅ Posisi ${pair} (#${ticket}) ${actionText}.` });
}

function handleNoTradeDecision(extractedData, whatsappSocket, recipientIds) {
    const { alasan, pair } = extractedData;
    log.info(`Keputusan untuk ${pair || 'pair tidak diketahui'} adalah TIDAK ADA TRADE.`, `Alasan: ${alasan}`);
    broadcastMessage(whatsappSocket, recipientIds, { text: `🔵 *Tidak Ada Trade Disarankan*\n*Alasan:* ${alasan}` });
}

module.exports = { handleOpenDecision, handleCloseDecision, handleNoTradeDecision, saveOrderData };
