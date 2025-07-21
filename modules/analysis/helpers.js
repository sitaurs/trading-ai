const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { getLogger } = require('../logger');
const log = getLogger('AnalysisHelpers');

const PENDING_DIR = path.join(__dirname, '..', '..', 'pending_orders');
const POSITIONS_DIR = path.join(__dirname, '..', '..', 'live_positions');
const JOURNAL_DIR = path.join(__dirname, '..', '..', 'journal_data');
const CACHE_DIR = path.join(__dirname, '..', '..', 'analysis_cache');
const DXY_SYMBOL = 'TVC:DXY';
const API_KEY_STATUS_PATH = path.join(__dirname, '..', '..', 'config', 'api_key_status.json');
const NEWS_CACHE_PATH = path.join(CACHE_DIR, 'daily_news.json');

let chartImgKeyIndex = loadLastKeyIndex();

function loadLastKeyIndex() {
    try {
        if (fsSync.existsSync(API_KEY_STATUS_PATH)) {
            const data = fsSync.readFileSync(API_KEY_STATUS_PATH, 'utf8');
            const status = JSON.parse(data);
            if (typeof status.chartImgKeyIndex === 'number') {
                log.info(`Melanjutkan dari Chart API Key index: ${status.chartImgKeyIndex}`);
                return status.chartImgKeyIndex;
            }
        }
    } catch (error) {
        log.error('Gagal memuat status API key, memulai dari 0.', error);
    }
    return 0;
}

function getAllChartImgKeys(){
    const keys=[];
    let idx=1;
    while(process.env[`CHART_IMG_KEY_${idx}`]){
        keys.push(process.env[`CHART_IMG_KEY_${idx}`]);
        idx++;
    }
    if(keys.length===0) throw new Error('Tidak ada CHART_IMG_KEY_X di file .env!');
    return keys;
}

function getNextChartImgKey(){
    const keys = getAllChartImgKeys();
    log.debug(`Menggunakan Chart API Key index: ${chartImgKeyIndex}`);
    const key = keys[chartImgKeyIndex];
    chartImgKeyIndex = (chartImgKeyIndex + 1) % keys.length;
    try{
        fsSync.writeFileSync(API_KEY_STATUS_PATH, JSON.stringify({chartImgKeyIndex}, null, 2), 'utf8');
    }catch(err){
        log.error('Gagal menyimpan status API key index.', err);
    }
    return key;
}

async function getPrompt(name){
    const promptPath = path.join(__dirname, '..', '..', 'prompts', name);
    log.debug(`Membaca prompt dari: ${promptPath}`);
    return fs.readFile(promptPath, 'utf8');
}

async function fetchOhlcv(symbol, timeframe='m30', count=50){
    log.info(`Mengambil data OHLCV untuk ${symbol} (${timeframe}, ${count} lilin)...`);
    try{
        const url = `https://api.mt5.flx.web.id/ohlcv?symbol=${symbol}&timeframe=${timeframe}&count=${count}`;
        const res = await axios.get(url);
        log.info(`Berhasil mengambil ${res.data.length} data candle untuk ${symbol}.`);
        return res.data;
    }catch(e){
        log.error(`Gagal mengambil data OHLCV untuk ${symbol}.`, e.message);
        return [];
    }
}

async function readJsonFile(filePath){
    try{
        const data = await fs.readFile(filePath,'utf8');
        return JSON.parse(data);
    }catch(err){
        if(err.code==='ENOENT'){
            log.debug(`File tidak ditemukan (normal): ${filePath}`);
            return null;
        }
        log.error(`Gagal membaca file JSON: ${filePath}`, err);
        throw err;
    }
}

async function writeJsonFile(filePath,data){
    const dir = path.dirname(filePath);
    try{
        if(!fsSync.existsSync(dir)){
            await fs.mkdir(dir,{recursive:true});
            log.info(`Direktori dibuat: ${dir}`);
        }
        await fs.writeFile(filePath, JSON.stringify(data,null,2),'utf8');
        log.info(`Data berhasil ditulis ke: ${filePath}`);
    }catch(err){
        log.error(`Gagal menulis file JSON: ${filePath}`, err);
    }
}

async function getChartImages(symbol){
    log.info(`Mengambil gambar chart untuk ${symbol}...`);
    const apiSymbol = symbol === DXY_SYMBOL ? DXY_SYMBOL : `OANDA:${symbol}`;
    let chartConfigs=[];
    if(symbol===DXY_SYMBOL){
        log.info('Menggunakan konfigurasi DXY: interval H1 & M15 dengan Stochastic.');
        const dxyStudies=[{
            name:'Stochastic',forceOverlay:false,
            input:{in_0:5,in_1:3,in_2:2},
            override:{'%K.visible':true,'%K.linewidth':1,'%K.plottype':'line','%K.color':'rgb(33,150,243)',
                      '%D.visible':true,'%D.linewidth':1,'%D.plottype':'line','%D.color':'rgb(255,109,0)',
                      'UpperLimit.visible':true,'UpperLimit.linestyle':2,'UpperLimit.linewidth':1,'UpperLimit.value':80,'UpperLimit.color':'rgb(120,123,134)',
                      'LowerLimit.visible':true,'LowerLimit.linestyle':2,'LowerLimit.linewidth':1,'LowerLimit.value':20,'LowerLimit.color':'rgb(120,123,134)',
                      'Hlines Background.visible':true,'Hlines Background.color':'rgba(33,150,243,0.1)'}
        }];
        chartConfigs=[
            {interval:'1h',studies:dxyStudies,name:'DXY H1 - Stochastic'},
            {interval:'15m',studies:dxyStudies,name:'DXY M15 - Stochastic'}
        ];
    }else{
        log.info(`Menggunakan konfigurasi 4-chart untuk pair ${symbol}.`);
        chartConfigs=[
            {interval:'1h',name:'H1 with EMA(50) & RSI(14)',studies:[{name:'Moving Average Exponential',input:{length:50}},{name:'Relative Strength Index',forceOverlay:false,input:{length:14}}]},
            {interval:'5m',name:'M5 Clean',studies:[]},
            {interval:'15m',name:'M15 with EMA(21) & EMA(50)',studies:[{name:'Moving Average Exponential',input:{length:21}},{name:'Moving Average Exponential',input:{length:50}}]},
            {interval:'15m',name:'M15 with Bollinger Bands & RSI(14)',studies:[{name:'Bollinger Bands',input:{in_0:20,in_1:2}},{name:'Relative Strength Index',forceOverlay:false,input:{length:14}}]}
        ];
    }

    const imagePromises = chartConfigs.map(cfg =>
        axios.post('https://api.chart-img.com/v2/tradingview/advanced-chart', {
            symbol: apiSymbol,
            interval: cfg.interval,
            studies: cfg.studies
        }, {
            headers:{'x-api-key': getNextChartImgKey(),'Content-Type':'application/json'},
            responseType:'arraybuffer'
        })
    );

    const responses = await Promise.all(imagePromises);
    log.info(`Berhasil mengambil ${responses.length} gambar chart.`);
    return {
        intervals: chartConfigs.map(c=>c.name),
        images: responses.map(r=>Buffer.from(r.data)),
        geminiData: responses.map(r=>({inlineData:{mimeType:'image/png',data:Buffer.from(r.data).toString('base64')}}))
    };
}

async function broadcastMessage(sock, ids, message){
    if(!ids||ids.length===0) return;
    log.info(`Mengirim pesan ke ${ids.length} penerima...`);
    for(const id of ids){
        try{ await sock.sendMessage(id, message); }catch(err){ log.error(`Gagal mengirim pesan ke ${id}`, err.message); }
    }
}

async function getEconomicNews(){
    log.info('Mencari berita ekonomi penting via Google Search Tool...');
    try{
        const promptBerita = await getPrompt('prompt_news.txt');
        const body={contents:[{parts:[{text:promptBerita}]}],tools:[{'google_search':{}}]};
        const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, body);
        if(res.data.candidates && res.data.candidates[0].content.parts[0].text){
            const newsText = res.data.candidates[0].content.parts[0].text;
            log.info('Berhasil mendapatkan berita ekonomi.');
            return newsText;
        }
        log.warn('Tidak ada berita ekonomi yang ditemukan.');
        return 'Tidak ada berita ditemukan.';
    }catch(err){
        log.error('Gagal mendapatkan data berita ekonomi.', err.message);
        return 'Gagal mendapatkan data berita.';
    }
}

async function getDailyNews(){
    const today = new Date().toISOString().slice(0,10);
    const cached = await readJsonFile(NEWS_CACHE_PATH);
    if(cached && cached.date === today && cached.news){
        log.info('Menggunakan berita ekonomi dari cache.');
        return cached.news;
    }
    const news = await getEconomicNews();
    await writeJsonFile(NEWS_CACHE_PATH, {date: today, news});
    return news;
}

async function getMarketContext(botSettings){
    let news='Pengecekan berita dinonaktifkan.';
    if(botSettings.isNewsEnabled){
        log.info('Fitur berita aktif, mengambil data berita...');
        news=await getDailyNews();
    }
    const context={session:getCurrentMarketSession(), news};
    log.info('Konteks pasar berhasil dibuat.', context);
    return context;
}

function getCurrentMarketSession(){
    const h=new Date().getUTCHours();
    if(h>=1&&h<8) return 'Asia';
    if(h>=8&&h<16) return 'London';
    if(h>=13&&h<17) return 'London/New York Overlap';
    if(h>=17&&h<22) return 'New York';
    return 'Closed/Sydney';
}

function getCurrentWIBDatetime(){
    return new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta',hour12:false}).replace(/\//g,'-').replace(',', '')+' WIB';
}

async function fetchCurrentPrice(pair){
    try{
        const url=`https://api.mt5.flx.web.id/data/tick/${pair}`;
        const res=await axios.get(url);
        let tick=res.data;
        if(Array.isArray(tick)) tick=tick[0];
        log.debug(`API response for ${pair}:`, res.data);
        if(tick && typeof tick === 'object'){
            if(typeof tick.ask!=='undefined') return tick.ask;
            if(typeof tick.bid!=='undefined') return tick.bid;
        }
        throw new Error('No price data');
    }catch(e){
        log.error(`Gagal fetch current price untuk ${pair}`, e.message);
        return null;
    }
}

module.exports={
    getPrompt,
    fetchOhlcv,
    readJsonFile,
    writeJsonFile,
    getChartImages,
    broadcastMessage,
    getDailyNews,
    getMarketContext,
    getCurrentMarketSession,
    getCurrentWIBDatetime,
    fetchCurrentPrice,
    PENDING_DIR,
    POSITIONS_DIR,
    JOURNAL_DIR,
    CACHE_DIR,
    DXY_SYMBOL
};
