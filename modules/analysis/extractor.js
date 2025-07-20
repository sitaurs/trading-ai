const axios = require('axios');
const { getLogger } = require('../logger');
const { getPrompt } = require('./helpers');
const log = getLogger('Extractor');
const supportedPairs = (process.env.SUPPORTED_PAIRS || '').split(',').map(p=>p.trim().toUpperCase());
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;

async function extractTradeDataFromAI(narrativeText){
    log.info('Memulai ekstraksi data trading dari teks naratif AI...');
    const extractionPromptTemplate = await getPrompt('prompt_extractor.txt');
    const pairsList = supportedPairs.join('|');
    const extractionPrompt = extractionPromptTemplate
        .replace(/\{PAIRS_LIST\}/g, pairsList)
        .replace(/\{NARRATIVE_TEXT\}/g, narrativeText);
    log.debug('Prompt ekstraksi yang dikirim ke AI:', extractionPrompt);
    try{
        const response = await axios.post(GEMINI_API_URL,{contents:[{parts:[{text:extractionPrompt}]}]});
        const extractedText = response.data.candidates[0].content.parts[0].text.trim();
        log.info('Menerima teks hasil ekstraksi dari AI.');
        log.debug('Teks Mentah Hasil Ekstraksi:', `\n${extractedText}`);
        const lines = extractedText.split('\n');
        const data={};
        for(const line of lines){
            const parts=line.split(':');
            if(parts.length>=2){
                const key=parts[0].trim();
                const value=parts.slice(1).join(':').trim();
                data[key]=!isNaN(parseFloat(value)) && isFinite(value) ? parseFloat(value) : value;
            }
        }
        log.info('Ekstraksi data trading berhasil.', data);
        return data;
    }catch(err){
        const msg = err.response ? JSON.stringify(err.response.data) : err.message;
        log.error('Gagal saat ekstraksi data dari AI.', msg);
        return null;
    }
}

module.exports = { extractTradeDataFromAI };
