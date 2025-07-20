/**
 * @fileoverview Module untuk menangani seluruh alur kerja analisis pasar.
 * Bertindak sebagai "otak" dari bot, dari mendapatkan data, menganalisis dengan AI,
 * hingga mengeksekusi trade secara otomatis.
 * @version 3.0.0 (Refactoring & Enhanced Logging)
 */

// --- DEPENDENCIES ---
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const chalk = require('chalk'); // Untuk log yang lebih keren!

// --- MODUL INTERNAL ---
const broker = require('./brokerHandler');
const journalingHandler = require('./journalingHandler');
const circuitBreaker = require('./circuitBreaker');

// --- KONFIGURASI & VARIABEL GLOBAL ---
const PENDING_DIR = path.join(__dirname, '..', 'pending_orders');
const POSITIONS_DIR = path.join(__dirname, '..', 'live_positions');
const JOURNAL_DIR = path.join(__dirname, '..', 'journal_data');
const CACHE_DIR = path.join(__dirname, '..', 'analysis_cache');
const DXY_SYMBOL = 'TVC:DXY';
const API_KEY_STATUS_PATH = path.join(__dirname, '..', 'config', 'api_key_status.json');
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;
const supportedPairs = (process.env.SUPPORTED_PAIRS || '').split(',').map(p => p.trim().toUpperCase());



// --- Memuat Index API Key Terakhir dari File ---
function loadLastKeyIndex() {
    try {
        // Cek dulu apakah file statusnya ada
        if (fsSync.existsSync(API_KEY_STATUS_PATH)) {
            const data = fsSync.readFileSync(API_KEY_STATUS_PATH, 'utf8');
            const status = JSON.parse(data);
            // Pastikan nilai yang dibaca adalah angka yang valid
            if (typeof status.chartImgKeyIndex === 'number') {
                console.log(`[AnalysisHandler] Melanjutkan dari Chart API Key index: ${status.chartImgKeyIndex}`);
                return status.chartImgKeyIndex;
            }
        }
    } catch (error) {
        console.error('[AnalysisHandler] Gagal memuat status API key, memulai dari 0.', error);
    }
    // Jika file tidak ada atau error, aman untuk memulai dari 0
    return 0;
}

let chartImgKeyIndex = loadLastKeyIndex();
// ---------------------------------------------

// ===================================================================================
// SECTION: SISTEM LOGGING PROFESIONAL
// ===================================================================================

/**
 * Logger terpusat dengan level, timestamp, dan konteks.
 * @param {'INFO' | 'WARN' | 'ERROR' | 'DEBUG'} level - Level log (INFO, WARN, ERROR, DEBUG).
 * @param {string} message - Pesan log utama.
 * @param {object | string | null} [data=null] - Data tambahan untuk ditampilkan (opsional).
 */
function log(level, message, data = null) {
    const timestamp = new Date().toLocaleString('id-ID', {
        hour12: false,
        timeZone: 'Asia/Jakarta'
    });

    let coloredLevel;
    switch (level) {
        case 'INFO':
            coloredLevel = chalk.blueBright.bold(`[${level}]`);
            break;
        case 'WARN':
            coloredLevel = chalk.yellowBright.bold(`[${level}]`);
            break;
        case 'ERROR':
            coloredLevel = chalk.redBright.bold.inverse(`[${level}]`);
            break;
        case 'DEBUG':
            coloredLevel = chalk.gray(`[${level}]`);
            break;
        default:
            coloredLevel = `[${level}]`;
    }

    const context = chalk.cyan('[AnalysisHandler]');
    const finalMessage = `${chalk.green(timestamp)} ${coloredLevel} ${context} ${message}`;

    console.log(finalMessage);
    if (data) {
        // Cetak data object dengan format yang rapi
        const formattedData = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
        console.log(chalk.gray(formattedData));
    }
}


// ===================================================================================
// SECTION: FUNGSI HELPER & UTILITAS
// ===================================================================================

/**
 * Mendapatkan semua API key untuk Chart-Img dari file .env.
 * @returns {string[]} Array berisi API keys.
 * @throws {Error} Jika tidak ada API key yang ditemukan.
 */
function getAllChartImgKeys() {
    const keys = [];
    let idx = 1;
    while (process.env[`CHART_IMG_KEY_${idx}`]) {
        keys.push(process.env[`CHART_IMG_KEY_${idx}`]);
        idx++;
    }
    if (keys.length === 0) throw new Error('Tidak ada CHART_IMG_KEY_X di file .env!');
    return keys;
}

/**
 * Mendapatkan API key Chart-Img berikutnya dan MENYIMPAN statusnya.
 * @returns {string} API key berikutnya.
 */
function getNextChartImgKey() {
    const keys = getAllChartImgKeys();

    // Log index yang sedang digunakan saat ini
    log('DEBUG', `Menggunakan Chart API Key index: ${chartImgKeyIndex}`);
    const key = keys[chartImgKeyIndex];

    // Update index ke nilai berikutnya untuk pemanggilan selanjutnya
    const nextIndex = (chartImgKeyIndex + 1) % keys.length;
    chartImgKeyIndex = nextIndex;

    // Simpan index baru (yang akan digunakan selanjutnya) ke file
    try {
        fsSync.writeFileSync(API_KEY_STATUS_PATH, JSON.stringify({ chartImgKeyIndex: chartImgKeyIndex }, null, 2), 'utf8');
    } catch (error) {
        log('ERROR', 'Gagal menyimpan status API key index.', error);
    }

    return key;
}

/**
 * Membaca konten file prompt.
 * @param {string} name - Nama file prompt (misal: 'prompt_new_analysis.txt').
 * @returns {Promise<string>} Konten dari file prompt.
 */
async function getPrompt(name) {
    const promptPath = path.join(__dirname, '../prompts/', name);
    log('DEBUG', `Membaca prompt dari: ${promptPath}`);
    return fs.readFile(promptPath, 'utf8');
}

/**
 * Mengambil data OHLCV (Open, High, Low, Close, Volume) dari API eksternal.
 * @param {string} symbol - Simbol pair (misal: 'GBPUSD').
 * @param {string} [timeframe='m30'] - Timeframe chart.
 * @param {number} [count=50] - Jumlah candle yang akan diambil.
 * @returns {Promise<object[]>} Array berisi data candle.
 */
async function fetchOhlcv(symbol, timeframe = 'm30', count = 50) {
    log('INFO', `Mengambil data OHLCV untuk ${symbol} (${timeframe}, ${count} lilin)...`);
    try {
        const url = `https://api.mt5.flx.web.id/ohlcv?symbol=${symbol}&timeframe=${timeframe}&count=${count}`;
        const res = await axios.get(url);
        log('INFO', `Berhasil mengambil ${res.data.length} data candle untuk ${symbol}.`);
        return res.data;
    } catch (e) {
        log('ERROR', `Gagal mengambil data OHLCV untuk ${symbol}.`, e.message);
        return [];
    }
}

/**
 * Membaca file JSON secara aman.
 * @param {string} filePath - Path lengkap ke file JSON.
 * @returns {Promise<object|null>} Data JSON atau null jika file tidak ada.
 */
async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            log('DEBUG', `File tidak ditemukan (normal): ${filePath}`);
            return null; // File tidak ada, ini bukan error
        }
        log('ERROR', `Gagal membaca file JSON: ${filePath}`, error);
        throw error; // Error lain, lempar lagi
    }
}

/**
 * Menulis data ke file JSON. Membuat direktori jika belum ada.
 * @param {string} filePath - Path lengkap ke file tujuan.
 * @param {object} data - Objek yang akan ditulis sebagai JSON.
 */
async function writeJsonFile(filePath, data) {
    const dir = path.dirname(filePath);
    try {
        // Cek dan buat direktori jika tidak ada
        if (!fsSync.existsSync(dir)) {
            await fs.mkdir(dir, {
                recursive: true
            });
            log('INFO', `Direktori dibuat: ${dir}`);
        }
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
        log('INFO', `Data berhasil ditulis ke: ${filePath}`);
    } catch (error) {
        log('ERROR', `Gagal menulis file JSON: ${filePath}`, error);
    }
}

// ===================================================================================
// SECTION: LOGIKA INTI ANALISIS & EKSEKUSI
// ===================================================================================

/**
 * Mengekstrak data trading terstruktur dari teks analisis naratif AI.
 * Ini adalah "panggilan AI kedua" yang bertindak sebagai parser cerdas.
 * @param {string} narrativeText - Teks analisis lengkap dari panggilan AI pertama.
 * @returns {Promise<object|null>} Objek berisi data trading atau null jika gagal.
 */
async function extractTradeDataFromAI(narrativeText) {
    log('INFO', 'Memulai ekstraksi data trading dari teks naratif AI...');

    const extractionPromptTemplate = await getPrompt('prompt_extractor.txt');
    const pairsList = supportedPairs.join('|');
    const extractionPrompt = extractionPromptTemplate
        .replace(/{PAIRS_LIST}/g, pairsList)
        .replace(/{NARRATIVE_TEXT}/g, narrativeText);

    log('DEBUG', 'Prompt ekstraksi yang dikirim ke AI:', extractionPrompt);

    try {
        const response = await axios.post(GEMINI_API_URL, {
            contents: [{
                parts: [{
                    text: extractionPrompt
                }]
            }]
        });

        const extractedText = response.data.candidates[0].content.parts[0].text.trim();
        log('INFO', 'Menerima teks hasil ekstraksi dari AI.');
        log('DEBUG', 'Teks Mentah Hasil Ekstraksi:', `\n${extractedText}`);

        // Parsing teks menjadi objek
        const lines = extractedText.split('\n');
        const data = {};
        for (const line of lines) {
            const parts = line.split(':');
            if (parts.length >= 2) {
                const key = parts[0].trim();
                const value = parts.slice(1).join(':').trim();
                // Konversi ke angka jika memungkinkan, jika tidak biarkan sebagai string
                data[key] = !isNaN(parseFloat(value)) && isFinite(value) ? parseFloat(value) : value;
            }
        }
        log('INFO', 'Ekstraksi data trading berhasil.', data);
        return data;

    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        log('ERROR', 'Gagal saat ekstraksi data dari AI.', errorMessage);
        return null;
    }
}


/**
 * Menyimpan data order ke file sistem setelah berhasil dieksekusi oleh broker.
 * @param {object} orderData - Data order lengkap, termasuk `ticket` dari broker.
 * @param {string} initialAnalysisText - Teks analisis awal untuk disimpan ke jurnal.
 */
async function saveOrderData(orderData, initialAnalysisText) {
    const {
        ticket,
        symbol
    } = orderData;
    log('INFO', `Menyimpan data untuk order #${ticket} (${symbol}).`);

    const isPending = orderData.type.includes('LIMIT') || orderData.type.includes('STOP');
    const targetDir = isPending ? PENDING_DIR : POSITIONS_DIR;
    const fileName = `trade_${symbol}.json`; // Gunakan nama file yang konsisten
    const orderFilePath = path.join(targetDir, fileName);
    const journalFilePath = path.join(JOURNAL_DIR, `journal_data_${symbol}.json`);

    try {
        // Simpan data order (pending atau live)
        await writeJsonFile(orderFilePath, orderData);

        // Baca data jurnal yang ada atau buat objek baru
        let journalData = await readJsonFile(journalFilePath) || {};
        journalData[ticket] = initialAnalysisText; // Tambahkan analisis untuk tiket ini

        // Simpan kembali data jurnal
        await writeJsonFile(journalFilePath, journalData);
        log('INFO', `Pencatatan untuk order #${ticket} selesai.`);
    } catch (error) {
        log('ERROR', `Gagal menyimpan data untuk order #${ticket}.`, error);
    }
}


/**
 * Fungsi utama untuk menangani satu siklus permintaan analisis.
 * @param {string} pair - Simbol pair yang akan dianalisis, misal: 'GBPUSD'.
 * @param {string | null} dxyAnalysisText - Teks analisis DXY. Bisa null jika dipanggil dari perintah manual.
 * @param {object} botSettings - Objek pengaturan bot.
 * @param {object} whatsappSocket - Instance koneksi WhatsApp.
 * @param {string[]} recipientIds - Array berisi ID penerima pesan.
 */
async function handleAnalysisRequest(pair, dxyAnalysisText, botSettings, whatsappSocket, recipientIds) {
        // LETAKKAN TEPAT DI DALAM FUNGSI handleAnalysisRequest
    if (await circuitBreaker.isTripped()) {
        const message = `🛑 *PERINGATAN:* CIRCUIT BREAKER AKTIF.\nTrading baru dihentikan untuk hari ini karena batas kerugian beruntun telah tercapai.`;
        log('WARN', message);
        if (whatsappSocket && recipientIds) {
            await broadcastMessage(whatsappSocket, recipientIds, { text: message });
        }
        return; 
    }
    log('INFO', `===== MEMULAI SIKLUS ANALISIS UNTUK ${pair} =====`);
    await broadcastMessage(whatsappSocket, recipientIds, {
        text: `⏳ *Analisis Dimulai untuk ${pair}...*`
    });

    try {
        // =================================================================
        // PERBAIKAN: Mengembalikan logika pembacaan cache DXY yang benar
        // =================================================================
        if (!dxyAnalysisText) {
            log('INFO', 'Data DXY tidak disediakan, membaca dari cache...');
            const dxyCachePath = path.join(CACHE_DIR, 'last_result_DXY.json');
            const dxyCache = await readJsonFile(dxyCachePath);
            if (dxyCache && dxyCache.analysis_text) {
                dxyAnalysisText = dxyCache.analysis_text;
                log('INFO', 'Berhasil memuat analisis DXY dari cache.');
            } else {
                log('WARN', 'Cache DXY tidak ditemukan. Analisis dilanjutkan tanpa data DXY.');
                dxyAnalysisText = "Data analisis DXY tidak tersedia.";
            }
        }
        // =================================================================
        
        // --- Ambil waktu sekarang WIB dan harga pasar terkini pair
        const currentDatetimeWIB = getCurrentWIBDatetime();
        const currentPrice = await fetchCurrentPrice(pair);

        
        // Cek "Memori" Trade: Apakah sudah ada posisi pending atau live?
        // Cek "Memori" Trade: Apakah sudah ada posisi pending atau live?
        log('INFO', `Mencari trade aktif/pending untuk ${pair}...`);
        const liveTradePath = path.join(POSITIONS_DIR, `trade_${pair}.json`);
        const pendingTradePath = path.join(PENDING_DIR, `trade_${pair}.json`);

        // Cek posisi live dulu, baru pending.
        const activeTrade = await readJsonFile(liveTradePath) || await readJsonFile(pendingTradePath);

        // Ambil data visual (chart) dan data harga (OHLCV)
        const {
            intervals,
            images,
            geminiData
        } = await getChartImages(pair);
        const ohlcvPair = await fetchOhlcv(pair, 'm30', 50);
        const ohlcvStr = JSON.stringify(ohlcvPair, null, 2);

        let promptText;

        if (activeTrade) {
            // --- Skenario 1: Manajemen Posisi Aktif ---
            // Kode di blok ini sudah benar dan tidak diubah.
            log('INFO', `Ditemukan trade aktif/pending untuk ${pair} (Tiket: #${activeTrade.ticket}). Mode: Manajemen Posisi.`);
            await broadcastMessage(whatsappSocket, recipientIds, {
                text: ` Menganalisis trade yang sedang berjalan/pending untuk *${pair}*...`
            });
            const journalFilePath = path.join(JOURNAL_DIR, `journal_data_${pair}.json`);
            const journalFile = await readJsonFile(journalFilePath);
            let initialAnalysisText = 'Analisis awal tidak ditemukan.';
            if (journalFile && journalFile[activeTrade.ticket]) {
                initialAnalysisText = journalFile[activeTrade.ticket];
                log('INFO', `Berhasil memuat analisis awal untuk tiket #${activeTrade.ticket}.`);
            } else {
                log('WARN', `Analisis awal untuk tiket #${activeTrade.ticket} tidak ditemukan.`);
            }
            promptText = await prepareHoldClosePrompt(pair, activeTrade, initialAnalysisText, dxyAnalysisText, ohlcvStr, currentPrice, currentDatetimeWIB);

        } else {
            // --- Skenario 2: Analisis Posisi Baru ---
            log('INFO', `Tidak ada trade aktif untuk ${pair}. Mode: Analisis Baru.`);
            const marketContext = await getMarketContext(botSettings);
            
            // Panggil dengan semua argumen yang benar, termasuk dxyAnalysisText yang sudah dibaca dari cache
            promptText = await prepareNewAnalysisPrompt(pair, marketContext, dxyAnalysisText, ohlcvStr, supportedPairs, currentPrice, currentDatetimeWIB);
        }

        log('DEBUG', `Prompt Final yang dikirim ke Gemini untuk ${pair}:`, `\n${promptText}`);

        // Panggil AI untuk analisis naratif
        log('INFO', 'Mengirim permintaan analisis naratif ke AI...');
        const narrativeResponse = await axios.post(GEMINI_API_URL, {
            contents: [{
                parts: [{
                    text: promptText
                }, ...geminiData]
            }]
        });
        const narrativeAnalysisResult = narrativeResponse.data.candidates[0].content.parts[0].text.trim();
        log('INFO', `Menerima hasil analisis naratif dari AI untuk ${pair}.`);
        log('DEBUG', 'Teks Naratif:', `\n${narrativeAnalysisResult}`);


        // Kirim hasil visual dan naratif ke pengguna
        for (let i = 0; i < images.length; i++) {
            const processedImageBuffer = await sharp(images[i]).png().toBuffer();
            await broadcastMessage(whatsappSocket, recipientIds, {
                image: processedImageBuffer,
                caption: `Chart ${pair} - Timeframe ${intervals[i]}`
            });
            await new Promise(resolve => setTimeout(resolve, 500)); // Jeda antar gambar
        }
        await broadcastMessage(whatsappSocket, recipientIds, {
            text: narrativeAnalysisResult
        });
        log('INFO', `Berhasil mengirim gambar dan teks analisis ke pengguna.`);

        // Ekstrak data terstruktur dari narasi
        const extractedData = await extractTradeDataFromAI(narrativeAnalysisResult);
        if (!extractedData || !extractedData.keputusan) {
            throw new Error("Gagal mengekstrak 'keputusan' dari hasil analisis AI.");
        }

        // Logika Aksi Internal Berdasarkan Keputusan AI
        log('INFO', `Keputusan AI yang diekstrak: ${extractedData.keputusan}`);
        switch (extractedData.keputusan) {
            case 'OPEN':
                await handleOpenDecision(extractedData, narrativeAnalysisResult, whatsappSocket, recipientIds);
                break;
            case 'CLOSE_MANUAL':
                await handleCloseDecision(extractedData, activeTrade, whatsappSocket, recipientIds);
                break;
            case 'HOLD':
                log('INFO', `Keputusan adalah HOLD. Tidak ada aksi trading yang diambil.`);
                break;
            case 'NO_TRADE':
                handleNoTradeDecision(extractedData, whatsappSocket, recipientIds);
                break;
            default:
                log('WARN', `Keputusan tidak dikenal: "${extractedData.keputusan}". Tidak ada aksi trading.`);
        }

    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        log('ERROR', `Terjadi kesalahan fatal dalam siklus analisis ${pair}.`, errorMessage);
        await broadcastMessage(whatsappSocket, recipientIds, {
            text: `❌ Maaf, terjadi kesalahan saat memproses analisis untuk *${pair}*.\n*Detail:* ${error.message}`
        });
    } finally {
        log('INFO', `===== SIKLUS ANALISIS UNTUK ${pair} SELESAI =====\n`);
    }
}

// ===================================================================================
// SECTION: FUNGSI PENANGAN KEPUTUSAN (DECISION HANDLERS)
// ===================================================================================

/**
 * Menangani logika setelah AI memutuskan untuk 'OPEN' posisi.
 * @param {object} extractedData - Data trade yang diekstrak.
 * @param {string} narrativeAnalysisResult - Teks analisis untuk disimpan ke jurnal.
 * @param {object} whatsappSocket - Instance koneksi WhatsApp.
 * @param {string[]} recipientIds - Array ID penerima pesan.
 */
async function handleOpenDecision(extractedData, narrativeAnalysisResult, whatsappSocket, recipientIds) {
    const {
        pair,
        arah,
        harga,
        sl,
        tp
    } = extractedData;
    log('INFO', `AI memutuskan OPEN. Mencoba eksekusi trade untuk ${pair}...`);

    const orderPayload = {
        symbol: pair,
        type: arah,
        price: harga || 0,
        sl: sl,
        tp: tp,
        volume: parseFloat(process.env.TRADE_VOLUME) || 0.01,
        comment: `BotV7 | ${pair}`
    };

    log('DEBUG', 'Payload order yang dikirim ke broker:', orderPayload);
    const brokerResult = await broker.openOrder(orderPayload);
    const ticketId = brokerResult.order || brokerResult.deal || brokerResult.ticket;

    if (!ticketId) {
        throw new Error("Eksekusi order berhasil, tetapi gagal mendapatkan ticket ID dari broker.");
    }
    log('INFO', `Broker berhasil mengeksekusi order. Tiket: #${ticketId}`);

    const finalOrderData = { ...orderPayload,
        ticket: ticketId
    };
    await saveOrderData(finalOrderData, narrativeAnalysisResult);

    await broadcastMessage(whatsappSocket, recipientIds, {
        text: `✅ *AKSI DIAMBIL!* Order ${pair} (${arah}) telah dieksekusi.\n*Tiket:* #${ticketId}`
    });
}

/**
 * Menangani logika setelah AI memutuskan untuk 'CLOSE_MANUAL'.
 * Termasuk fallback cerdas jika pending order sudah tereksekusi.
 * @param {object} extractedData - Data yang diekstrak dari AI.
 * @param {object} activeTrade - Objek trade aktif yang sedang dikelola.
 * @param {object} whatsappSocket - Instance koneksi WhatsApp.
 * @param {string[]} recipientIds - Array ID penerima pesan.
 */
async function handleCloseDecision(extractedData, activeTrade, whatsappSocket, recipientIds) {
    const pair = activeTrade ? activeTrade.symbol : extractedData.pair;
    log('INFO', `AI memutuskan CLOSE_MANUAL untuk ${pair}.`);

    if (!activeTrade || !activeTrade.ticket) {
        log('WARN', `AI menyarankan tutup, tapi tidak ada data trade aktif tercatat untuk ${pair}.`);
        await broadcastMessage(whatsappSocket, recipientIds, {
            text: `ℹ️ *Info:* Analisis menyarankan tutup, tetapi tidak ada posisi aktif yang tercatat untuk ${pair}. Mungkin sudah ditutup manual.`
        });
        return;
    }

    const {
        ticket
    } = activeTrade;
    let closeReason = `Manual Close by AI (${extractedData.alasan || 'No reason specified'})`;
    let actionText = '';

    try {
        const isPending = activeTrade.type.includes('LIMIT') || activeTrade.type.includes('STOP');
        if (isPending) {
            log('INFO', `Mencoba membatalkan PENDING order #${ticket}...`);
            await broker.cancelPendingOrder(ticket);
            actionText = 'dibatalkan';
        } else {
            log('INFO', `Mencoba menutup LIVE posisi #${ticket}...`);
            await broker.closePosition(ticket);
            actionText = 'ditutup';
        }
        log('INFO', `Order/Posisi #${ticket} berhasil ${actionText} di broker.`);

    } catch (error) {
        // Fallback: Jika gagal membatalkan pending (kemungkinan sudah jadi live)
        if (error.message && error.message.includes("Invalid request")) {
            log('WARN', `Gagal batalkan pending #${ticket}. Mencoba menutup sebagai posisi LIVE...`);
            await broker.closePosition(ticket);
            actionText = 'ditutup (fallback)';
            log('INFO', `Fallback berhasil! Posisi #${ticket} ditutup sebagai live.`);
        }
        // Fallback: Jika posisi sudah tidak ada di broker
        else if (error.message && error.message.includes("tidak ditemukan")) {
            log('WARN', `Posisi #${ticket} sudah tidak ditemukan di broker. Dianggap sudah tertutup.`);
            actionText = 'dibersihkan (tidak ditemukan)';
            closeReason = 'Closed (Not Found on Broker)';
        } else {
            // Error lain yang tidak terduga
            log('ERROR', `Gagal menutup/membatalkan order #${ticket}.`, error);
            throw error; // Lempar lagi untuk ditangani di blok catch utama
        }
    }

    // Panggil journalingHandler untuk mencatat dan membersihkan file
    await journalingHandler.recordTrade(activeTrade, closeReason);
    await broadcastMessage(whatsappSocket, recipientIds, {
        text: `✅ *AKSI DIAMBIL!* Order ${pair} (#${ticket}) telah ${actionText} berdasarkan analisis.`
    });
}

/**
 * Menangani logika jika keputusan AI adalah NO_TRADE.
 * @param {object} extractedData - Data yang diekstrak.
 * @param {object} whatsappSocket - Instance koneksi WhatsApp.
 * @param {string[]} recipientIds - Array ID penerima pesan.
 */
function handleNoTradeDecision(extractedData, whatsappSocket, recipientIds) {
    const {
        alasan,
        pair
    } = extractedData;
    log('INFO', `Keputusan untuk ${pair || 'pair tidak diketahui'} adalah TIDAK ADA TRADE.`, `Alasan: ${alasan}`);
    // Pesan NO_TRADE biasanya sudah ada di narasi, tapi kita bisa kirim konfirmasi
    broadcastMessage(whatsappSocket, recipientIds, {
        text: `🔵 *Tidak Ada Trade Disarankan*\n*Alasan:* ${alasan}`
    });
}


// ===================================================================================
// SECTION: FUNGSI ANALISIS TERJADWAL & DXY
// ===================================================================================

async function analyzeDXY(whatsappSocket, recipientIds) {
    log('INFO', '===== MEMULAI ANALISIS DXY =====');
    await broadcastMessage(whatsappSocket, recipientIds, {
        text: `⏳ *Analisis DXY (Indeks Dolar) dimulai...*`
    });
    try {
        const {
            intervals,
            images,
            geminiData
        } = await getChartImages(DXY_SYMBOL);
        const ohlcvDxy = await fetchOhlcv('DXY', 'm30', 50);
        const ohlcvStr = JSON.stringify(ohlcvDxy, null, 2);
        const promptDXY = await prepareDxyPrompt(ohlcvStr);

        log('INFO', 'Mengirim permintaan analisis DXY ke AI...');
        const body = {
            contents: [{
                parts: [{
                    text: promptDXY
                }, ...geminiData]
            }]
        };
        const response = await axios.post(GEMINI_API_URL, body);
        const dxyAnalysisText = response.data.candidates[0].content.parts[0].text.trim();
        log('INFO', 'Menerima hasil analisis DXY dari AI.');

        await writeJsonFile(path.join(CACHE_DIR, 'last_result_DXY.json'), {
            analysis_text: dxyAnalysisText,
            last_updated: new Date().toISOString()
        });

        for (let i = 0; i < images.length; i++) {
            await broadcastMessage(whatsappSocket, recipientIds, {
                image: images[i],
                caption: `Chart DXY - Timeframe ${intervals[i]}`
            });
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        await broadcastMessage(whatsappSocket, recipientIds, {
            text: `✅ *Analisis DXY Selesai*:\n\n${dxyAnalysisText}`
        });
        log('INFO', '===== ANALISIS DXY SELESAI =====\n');
        return {
            analysis_text: dxyAnalysisText
        };
    } catch (error) {
        log('ERROR', 'Gagal menganalisis DXY.', error.message);
        await broadcastMessage(whatsappSocket, recipientIds, {
            text: `❌ Gagal menganalisis DXY. Error: ${error.message}`
        });
        throw error;
    }
}


async function runScheduledAnalysis(pairsToAnalyze, botSettings, whatsappSocket, recipientIds) {
    if (!whatsappSocket || !recipientIds || recipientIds.length === 0) {
        log('WARN', "Jadwal analisis dilewati: WhatsApp tidak siap atau tidak ada penerima.");
        return;
    }
    log('INFO', '<<<<< MEMULAI SIKLUS ANALISIS TERJADWAL >>>>>');
    await broadcastMessage(whatsappSocket, recipientIds, {
        text: `🤖 *Analisis Terjadwal Dimulai...*`
    });

    try {
        const {
            analysis_text: dxyAnalysisText
        } = await analyzeDXY(whatsappSocket, recipientIds);
        const delayMinutes = 2;
        log('INFO', `Memulai jeda ${delayMinutes} menit sebelum analisis pair...`);
        await broadcastMessage(whatsappSocket, recipientIds, {
            text: `⏳ *Memulai jeda ${delayMinutes} menit...* Analisis pair akan dimulai setelah ini.`
        });
        await new Promise(resolve => setTimeout(resolve, delayMinutes * 60 * 1000));

        log('INFO', `Jeda ${delayMinutes} menit selesai. Melanjutkan ke analisis pair.`);
        await broadcastMessage(whatsappSocket, recipientIds, {
            text: `🔔 *Jeda selesai.* Memulai analisis untuk semua pair...`
        });

        for (const pair of pairsToAnalyze) {
            await handleAnalysisRequest(pair, dxyAnalysisText, botSettings, whatsappSocket, recipientIds);
            await new Promise(resolve => setTimeout(resolve, 5000)); // Jeda antar pair
        }
        await broadcastMessage(whatsappSocket, recipientIds, {
            text: `✅ *Analisis Terjadwal Selesai.*`
        });
        log('INFO', '<<<<< SIKLUS ANALISIS TERJADWAL SELESAI >>>>>');

    } catch (error) {
        log('ERROR', 'Analisis terjadwal dibatalkan karena DXY gagal dianalisis.');
        await broadcastMessage(whatsappSocket, recipientIds, {
            text: `⚠️ Analisis terjadwal dibatalkan karena DXY gagal dianalisis.`
        });
    }
}


// --- HELPER LAINNYA ---

// --- HELPER LAINNYA ---

async function getChartImages(symbol) {
  log('INFO', `Mengambil gambar chart untuk ${symbol}...`);
  const apiSymbol = symbol === DXY_SYMBOL ? DXY_SYMBOL : `OANDA:${symbol}`;

  let chartConfigs = [];

  if (symbol === DXY_SYMBOL) {
      // --- KONFIGURASI BARU UNTUK DXY ---
      // Mengubah interval ke H1 (1h) dan M15 (15m)
      log('INFO', `Menggunakan konfigurasi DXY: interval H1 & M15 dengan Stochastic.`);
      const dxyStudies = [{
          "name": "Stochastic",
          "forceOverlay": false,
          "input": { "in_0": 5, "in_1": 3, "in_2": 2 },
          "override": {
              "%K.visible": true, "%K.linewidth": 1, "%K.plottype": "line", "%K.color": "rgb(33,150,243)",
              "%D.visible": true, "%D.linewidth": 1, "%D.plottype": "line", "%D.color": "rgb(255,109,0)",
              "UpperLimit.visible": true, "UpperLimit.linestyle": 2, "UpperLimit.linewidth": 1, "UpperLimit.value": 80, "UpperLimit.color": "rgb(120,123,134)",
              "LowerLimit.visible": true, "LowerLimit.linestyle": 2, "LowerLimit.linewidth": 1, "LowerLimit.value": 20, "LowerLimit.color": "rgb(120,123,134)",
              "Hlines Background.visible": true, "Hlines Background.color": "rgba(33,150,243,0.1)"
          }
      }];
      chartConfigs = [
          { interval: '1h', studies: dxyStudies, name: 'DXY H1 - Stochastic' },
          { interval: '15m', studies: dxyStudies, name: 'DXY M15 - Stochastic' }
      ];

  } else {
      // --- KONFIGURASI BARU UNTUK PAIR (4 GAMBAR) ---
      log('INFO', `Menggunakan konfigurasi 4-chart untuk pair ${symbol}.`);
      chartConfigs = [
          // Gambar 1: Chart H1 dengan EMA(50) dan RSI(14).
          {
              interval: '1h',
              name: 'H1 with EMA(50) & RSI(14)',
              studies: [
                  { "name": "Moving Average Exponential", "input": { "length": 50 } },
                  { "name": "Relative Strength Index", "forceOverlay": false, "input": { "length": 14 } }
              ]
          },
          // Gambar 2: Chart M5 bersih (tanpa indikator).
          {
              interval: '5m',
              name: 'M5 Clean',
              studies: []
          },
          // Gambar 3: Chart M15 dengan EMA(21) dan EMA(50).
          {
              interval: '15m',
              name: 'M15 with EMA(21) & EMA(50)',
              studies: [
                  { "name": "Moving Average Exponential", "input": { "length": 21 } },
                  { "name": "Moving Average Exponential", "input": { "length": 50 } }
              ]
          },
          // Gambar 4: Chart M15 dengan Bollinger Bands dan RSI(14).
          {
              interval: '15m',
              name: 'M15 with Bollinger Bands & RSI(14)',
              studies: [
                  { "name": "Bollinger Bands", "input": { "in_0": 20, "in_1": 2 } },
                  { "name": "Relative Strength Index", "forceOverlay": false, "input": { "length": 14 } }
              ]
          }
      ];
  }

  // Membuat daftar permintaan gambar berdasarkan konfigurasi di atas
  const imagePromises = chartConfigs.map(config =>
      axios.post('https://api.chart-img.com/v2/tradingview/advanced-chart', {
          symbol: apiSymbol,
          interval: config.interval,
          studies: config.studies
      }, {
          headers: {
              'x-api-key': getNextChartImgKey(),
              'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer'
      })
  );

  const responses = await Promise.all(imagePromises);
  log('INFO', `Berhasil mengambil ${responses.length} gambar chart.`);

  // Mengembalikan data dengan format yang sama seperti sebelumnya
  return {
      intervals: chartConfigs.map(c => c.name), // Menggunakan nama deskriptif untuk caption
      images: responses.map(res => Buffer.from(res.data)),
      geminiData: responses.map(res => ({
          inlineData: {
              mimeType: 'image/png',
              data: Buffer.from(res.data).toString('base64')
          }
      }))
  };
}

async function broadcastMessage(whatsappSocket, recipientIds, messageObject) {
    if (!recipientIds || recipientIds.length === 0) return;
    log('INFO', `Mengirim pesan ke ${recipientIds.length} penerima...`);
    for (const id of recipientIds) {
        try {
            await whatsappSocket.sendMessage(id, messageObject);
        } catch (err) {
            log('ERROR', `Gagal mengirim pesan ke ${id}`, err.message);
        }
    }
}

async function getEconomicNews() {
    log('INFO', 'Mencari berita ekonomi penting via Google Search Tool...');
    try {
        const promptBerita = await getPrompt('prompt_news.txt');
        const body = {
            contents: [{
                parts: [{
                    text: promptBerita
                }]
            }],
            tools: [{
                "google_search": {}
            }]
        };
        const response = await axios.post(GEMINI_API_URL, body);
        if (response.data.candidates && response.data.candidates[0].content.parts[0].text) {
            const newsText = response.data.candidates[0].content.parts[0].text;
            log('INFO', 'Berhasil mendapatkan berita ekonomi.');
            return newsText;
        }
        log('WARN', 'Tidak ada berita ekonomi yang ditemukan.');
        return "Tidak ada berita ditemukan.";
    } catch (error) {
        log('ERROR', 'Gagal mendapatkan data berita ekonomi.', error.message);
        return "Gagal mendapatkan data berita.";
    }
}

async function getMarketContext(botSettings) {
    let news = 'Pengecekan berita dinonaktifkan.';
    if (botSettings.isNewsEnabled) {
        log('INFO', "Fitur berita aktif, mengambil data berita...");
        news = await getEconomicNews();
    }
    const context = {
        session: getCurrentMarketSession(),
        news: news,
    };
    log('INFO', 'Konteks pasar berhasil dibuat.', context);
    return context;
}


function getCurrentMarketSession() {
    const currentUTCHour = new Date().getUTCHours();
    if (currentUTCHour >= 1 && currentUTCHour < 8) return 'Asia';
    if (currentUTCHour >= 8 && currentUTCHour < 16) return 'London';
    if (currentUTCHour >= 13 && currentUTCHour < 17) return 'London/New York Overlap';
    if (currentUTCHour >= 17 && currentUTCHour < 22) return 'New York';
    return 'Closed/Sydney';
}

/**
 * Mengembalikan string tanggal & waktu sekarang dalam format WIB.
 * @returns {string} Contoh: "2025-06-29 21:07:35 WIB"
 **/
function getCurrentWIBDatetime() {
    return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }).replace(/\//g, '-').replace(',', '') + ' WIB';
}

/**
 * Mengambil harga pasar terkini (current price) untuk symbol pair tertentu.
 * @param {string} pair - Pair seperti 'EURUSD', 'GBPUSD'
 * @returns {Promise<number>} Nilai harga terkini (ask/bid)
 */
async function fetchCurrentPrice(pair) {
    try {
        const url = `https://api.mt5.flx.web.id/data/tick/${pair}`;
        const res = await axios.get(url);
        let tick = res.data;

        // Fix: handle array OR object!
        if (Array.isArray(tick)) {
            tick = tick[0];
        }

        log('DEBUG', `API response for ${pair}:`, res.data);

        if (tick && typeof tick === "object") {
            if (typeof tick.ask !== "undefined") return tick.ask;
            if (typeof tick.bid !== "undefined") return tick.bid;
        }

        throw new Error('No price data');
    } catch (e) {
        log('ERROR', `Gagal fetch current price untuk ${pair}`, e.message);
        return null;
    }
}




async function prepareNewAnalysisPrompt(pair, marketContext, dxyAnalysisText, ohlcvStr, supportedPairs, currentPrice, currentDatetimeWIB) {
    let prompt = await getPrompt('prompt_new_analysis.txt');
    prompt = prompt
        .replace(/{PAIR}/g, pair)
        .replace(/{DXY_ANALYSIS}/g, dxyAnalysisText)
        .replace(/{NEWS}/g, marketContext.news || 'N/A')
        .replace(/{SESSION}/g, marketContext.session || 'N/A')
        .replace(/{OHLCV}/g, ohlcvStr)
        .replace(/{PAIRS_LIST}/g, supportedPairs.join('|'))
        .replace(/{CURRENT_PRICE}/g, currentPrice)
        .replace(/{DATETIME_WIB}/g, currentDatetimeWIB);
    return prompt;
}

async function prepareHoldClosePrompt(pair, activeTrade, initialAnalysisText, dxyAnalysisText, ohlcvStr, currentPrice, currentDatetimeWIB) {
    let prompt = await getPrompt('prompt_hold_close.txt');
    // Tambahkan data trade aktif ke prompt
    const tradeDetails = JSON.stringify(activeTrade, null, 2);
    return prompt
        .replace(/{PAIR}/g, pair)
        .replace(/{TRADE_DETAILS}/g, tradeDetails)
        .replace(/{DXY_ANALYSIS}/g, dxyAnalysisText)
        .replace(/{INIT_ANALYSIS}/g, initialAnalysisText)
        .replace(/{OHLCV}/g, ohlcvStr)
        .replace(/{CURRENT_PRICE}/g, currentPrice)
        .replace(/{DATETIME_WIB}/g, currentDatetimeWIB);
}

async function prepareDxyPrompt(ohlcvStr) {
    let prompt = await getPrompt('prompt_analyzeDXY.txt');
    return prompt.replace(/{OHLCV}/g, ohlcvStr);
}

// --- EKSPOR MODUL ---
module.exports = {
    handleAnalysisRequest,
    runScheduledAnalysis,
    analyzeDXY
};