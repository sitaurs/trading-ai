const path = require('path');
const axios = require('axios');
const { getLogger } = require('./logger');
const log = getLogger('AnalysisHandler');
const broker = require('./brokerHandler');
const circuitBreaker = require('./circuitBreaker');
const { isWithinSession, classifySegment } = require('../src/utils/session');
const { passesHardFilter } = require('../src/utils/hardFilter');
const {
  fetchOhlcv,
  readJsonFile,
  writeJsonFile,
  getChartImages,
  broadcastMessage,
  getMarketContext,
  getCurrentWIBDatetime,
  fetchCurrentPrice,
  PENDING_DIR,
  POSITIONS_DIR,
  JOURNAL_DIR,
  CACHE_DIR,
  DXY_SYMBOL
} = require('./analysis/helpers');
const { prepareNewAnalysisPrompt, prepareHoldClosePrompt, prepareDxyPrompt } = require('./analysis/promptBuilders');
const { extractTradeDataFromAI } = require('./analysis/extractor');
const { handleOpenDecision, handleCloseDecision, handleNoTradeDecision } = require('./analysis/decisionHandlers');

const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;
const supportedPairs = (process.env.SUPPORTED_PAIRS || '').split(',').map(p => p.trim().toUpperCase());

async function handleAnalysisRequest(pair, dxyAnalysisText, botSettings, whatsappSocket, recipientIds, force = false){
  if(await circuitBreaker.isTripped()){
    const msg = '🛑 *PERINGATAN:* CIRCUIT BREAKER AKTIF.';
    log.warn(msg);
    await broadcastMessage(whatsappSocket, recipientIds, {text: msg});
    return;
  }
  if(!force && !isWithinSession()){
    log.info(`[${pair}] outside_session`);
    await broadcastMessage(whatsappSocket, recipientIds, {
      text: `⚠️ Analisis *${pair}* dilewati: di luar sesi trading yang diizinkan.`
    });
    return;
  }
  const hf = await passesHardFilter(pair);
  if(!hf.pass && !force){
    log.info(`[${pair}] hard_filter_fail reason=${hf.reason} atr=${hf.atr} range=${hf.range} body=${hf.body}`);
    await broadcastMessage(whatsappSocket, recipientIds, {
      text: `⚠️ Analisis *${pair}* dibatalkan karena gagal hard filter.\n*Alasan:* ${hf.reason}`
    });
    return;
  }
  if(force) {
    log.info(`[${pair}] FORCE mode aktif - melewati sesi dan hard filter`);
  } else {
    log.info(`[${pair}] hard_filter_pass wickAtr=${hf.wickAtrRatio}`);
  }
  const analysisMeta={
    session_segment: classifySegment(),
    wick_atr_ratio: hf.wickAtrRatio,
    hard_filter_pass: hf.pass,
    hard_filter_reason: hf.pass ? null : hf.reason
  };
  log.info(`===== MEMULAI SIKLUS ANALISIS UNTUK ${pair} =====`);
  await broadcastMessage(whatsappSocket, recipientIds, {text:`⏳ *Analisis Dimulai untuk ${pair}...*`});
  try{
    const dxyCachePath = path.join(CACHE_DIR,'last_result_DXY.json');
    if(!dxyAnalysisText){
      const dxyCache = await readJsonFile(dxyCachePath);
      dxyAnalysisText = dxyCache? dxyCache.analysis_text : '';
    }
    const currentDatetimeWIB = getCurrentWIBDatetime();
    const currentPrice = await fetchCurrentPrice(pair);
    log.info(`Mencari trade aktif/pending untuk ${pair}...`);
    const liveTradePath = path.join(POSITIONS_DIR, `trade_${pair}.json`);
    const pendingTradePath = path.join(PENDING_DIR, `trade_${pair}.json`);
    const activeTrade = await readJsonFile(liveTradePath) || await readJsonFile(pendingTradePath);
    const { intervals, images, geminiData } = await getChartImages(pair);
    const ohlcvPair = await fetchOhlcv(pair, 'm30', 50);
    const ohlcvStr = JSON.stringify(ohlcvPair, null, 2);
    let promptText;
    if(activeTrade){
      log.info(`Ditemukan trade aktif/pending untuk ${pair} (Tiket: #${activeTrade.ticket}).`);
      await broadcastMessage(whatsappSocket, recipientIds,{text:` Menganalisis trade yang sedang berjalan/pending untuk *${pair}*...`});
      const journalFilePath = path.join(JOURNAL_DIR, `journal_data_${pair}.json`);
      const journalFile = await readJsonFile(journalFilePath);
      let initialAnalysisText='Analisis awal tidak ditemukan.';
      if(journalFile && journalFile[activeTrade.ticket]) initialAnalysisText = journalFile[activeTrade.ticket];
      promptText = await prepareHoldClosePrompt(pair, activeTrade, initialAnalysisText, dxyAnalysisText, ohlcvStr, currentPrice, currentDatetimeWIB);
    }else{
      log.info(`Tidak ada trade aktif untuk ${pair}. Mode: Analisis Baru.`);
      const marketContext = await getMarketContext(botSettings);
      promptText = await prepareNewAnalysisPrompt(pair, marketContext, dxyAnalysisText, ohlcvStr, supportedPairs, currentPrice, currentDatetimeWIB);
    }
    log.debug('Prompt Final:', `\n${promptText}`);
    log.info('Mengirim permintaan analisis naratif ke AI...');
    const narrativeResponse = await axios.post(GEMINI_API_URL,{contents:[{parts:[{text:promptText}, ...geminiData]}]});
    const narrativeAnalysisResult = narrativeResponse.data.candidates[0].content.parts[0].text.trim();
    log.info('Menerima hasil analisis naratif dari AI.');
    for(let i=0;i<images.length;i++){
      await broadcastMessage(whatsappSocket, recipientIds,{image:images[i],caption:`Chart ${pair} - Timeframe ${intervals[i]}`});
      await new Promise(r=>setTimeout(r,500));
    }
    await broadcastMessage(whatsappSocket, recipientIds,{text:narrativeAnalysisResult});
    const extractedData = await extractTradeDataFromAI(narrativeAnalysisResult);
    if(!extractedData || !extractedData.keputusan) throw new Error('Gagal mengekstrak keputusan.');
    log.info(`Keputusan AI: ${extractedData.keputusan}`);
    switch(extractedData.keputusan){
      case 'OPEN':
        await handleOpenDecision(extractedData, narrativeAnalysisResult, whatsappSocket, recipientIds, analysisMeta); break;
      case 'CLOSE_MANUAL':
        await handleCloseDecision(extractedData, activeTrade, whatsappSocket, recipientIds); break;
      case 'HOLD':
        log.info('Keputusan adalah HOLD.'); break;
      case 'NO_TRADE':
        handleNoTradeDecision(extractedData, whatsappSocket, recipientIds); break;
      default:
        log.warn(`Keputusan tidak dikenal: ${extractedData.keputusan}`);
    }
  }catch(err){
    const msg = err.response ? JSON.stringify(err.response.data) : err.message;
    log.error(`Terjadi kesalahan fatal dalam siklus analisis ${pair}.`, msg);
    await broadcastMessage(whatsappSocket, recipientIds,{text:`❌ Maaf, terjadi kesalahan saat memproses analisis untuk *${pair}*.\n*Detail:* ${err.message}`});
  }finally{
    log.info(`===== SIKLUS ANALISIS UNTUK ${pair} SELESAI =====\n`);
  }
}

async function analyzeDXY(whatsappSocket, recipientIds){
  log.info('===== MEMULAI ANALISIS DXY =====');
  await broadcastMessage(whatsappSocket, recipientIds,{text:'⏳ *Analisis DXY (Indeks Dolar) dimulai...*'});
  try{
    const {intervals,images,geminiData} = await getChartImages(DXY_SYMBOL);
    const ohlcvDxy = await fetchOhlcv('DXY','m30',50);
    const ohlcvStr = JSON.stringify(ohlcvDxy,null,2);
    const promptDXY = await prepareDxyPrompt(ohlcvStr);
    log.info('Mengirim permintaan analisis DXY ke AI...');
    const body={contents:[{parts:[{text:promptDXY},...geminiData]}]};
    const response = await axios.post(GEMINI_API_URL, body);
    const dxyAnalysisText = response.data.candidates[0].content.parts[0].text.trim();
    await writeJsonFile(path.join(CACHE_DIR,'last_result_DXY.json'),{analysis_text:dxyAnalysisText,last_updated:new Date().toISOString()});
    for(let i=0;i<images.length;i++){
      await broadcastMessage(whatsappSocket, recipientIds,{image:images[i],caption:`Chart DXY - Timeframe ${intervals[i]}`});
      await new Promise(r=>setTimeout(r,500));
    }
    await broadcastMessage(whatsappSocket, recipientIds,{text:`✅ *Analisis DXY Selesai*:\n\n${dxyAnalysisText}`});
    log.info('===== ANALISIS DXY SELESAI =====\n');
    return {analysis_text:dxyAnalysisText};
  }catch(err){
    log.error('Gagal menganalisis DXY.', err.message);
    await broadcastMessage(whatsappSocket, recipientIds,{text:`❌ Gagal menganalisis DXY. Error: ${err.message}`});
    throw err;
  }
}

async function runScheduledAnalysis(pairsToAnalyze, botSettings, whatsappSocket, recipientIds){
  if(!whatsappSocket || !recipientIds || recipientIds.length===0){
    log.warn('Jadwal analisis dilewati: WhatsApp tidak siap atau tidak ada penerima.');
    return;
  }
  log.info('<<<<< MEMULAI SIKLUS ANALISIS TERJADWAL >>>>>');
  await broadcastMessage(whatsappSocket, recipientIds,{text:'🤖 *Analisis Terjadwal Dimulai...*'});
  try{
    const {analysis_text:dxyAnalysisText} = await analyzeDXY(whatsappSocket, recipientIds);
    const delayMinutes = 2;
    log.info(`Memulai jeda ${delayMinutes} menit sebelum analisis pair...`);
    await broadcastMessage(whatsappSocket, recipientIds,{text:`⏳ *Memulai jeda ${delayMinutes} menit...* Analisis pair akan dimulai setelah ini.`});
    await new Promise(r=>setTimeout(r, delayMinutes*60*1000));
    log.info(`Jeda ${delayMinutes} menit selesai. Melanjutkan ke analisis pair.`);
    await broadcastMessage(whatsappSocket, recipientIds,{text:'🔔 *Jeda selesai.* Memulai analisis untuk semua pair...'});
    for(const pair of pairsToAnalyze){
      await handleAnalysisRequest(pair, dxyAnalysisText, botSettings, whatsappSocket, recipientIds);
      await new Promise(r=>setTimeout(r,5000));
    }
    await broadcastMessage(whatsappSocket, recipientIds,{text:'✅ *Analisis Terjadwal Selesai.*'});
    log.info('<<<<< SIKLUS ANALISIS TERJADWAL SELESAI >>>>>');
  }catch(err){
    log.error('Analisis terjadwal dibatalkan karena DXY gagal dianalisis.');
    await broadcastMessage(whatsappSocket, recipientIds,{text:'⚠️ Analisis terjadwal dibatalkan karena DXY gagal dianalisis.'});
  }
}

module.exports = { handleAnalysisRequest, runScheduledAnalysis, analyzeDXY };
