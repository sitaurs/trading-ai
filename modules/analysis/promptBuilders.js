const { getPrompt } = require('./helpers');

async function prepareNewAnalysisPrompt(pair, marketContext, dxyAnalysisText, ohlcvStr, supportedPairs, currentPrice, currentDatetimeWIB){
    let prompt = await getPrompt('prompt_new_analysis.txt');
    return prompt
        .replace(/\{PAIR\}/g, pair)
        .replace(/\{DXY_ANALYSIS\}/g, dxyAnalysisText)
        .replace(/\{NEWS\}/g, marketContext.news || 'N/A')
        .replace(/\{SESSION\}/g, marketContext.session || 'N/A')
        .replace(/\{OHLCV\}/g, ohlcvStr)
        .replace(/\{PAIRS_LIST\}/g, supportedPairs.join('|'))
        .replace(/\{CURRENT_PRICE\}/g, currentPrice)
        .replace(/\{DATETIME_WIB\}/g, currentDatetimeWIB);
}

async function prepareHoldClosePrompt(pair, activeTrade, initialAnalysisText, dxyAnalysisText, ohlcvStr, currentPrice, currentDatetimeWIB){
    let prompt = await getPrompt('prompt_hold_close.txt');
    const tradeDetails = JSON.stringify(activeTrade, null, 2);
    return prompt
        .replace(/\{PAIR\}/g, pair)
        .replace(/\{TRADE_DETAILS\}/g, tradeDetails)
        .replace(/\{DXY_ANALYSIS\}/g, dxyAnalysisText)
        .replace(/\{INIT_ANALYSIS\}/g, initialAnalysisText)
        .replace(/\{OHLCV\}/g, ohlcvStr)
        .replace(/\{CURRENT_PRICE\}/g, currentPrice)
        .replace(/\{DATETIME_WIB\}/g, currentDatetimeWIB);
}

async function prepareDxyPrompt(ohlcvStr){
    let prompt = await getPrompt('prompt_analyzeDXY.txt');
    return prompt.replace(/\{OHLCV\}/g, ohlcvStr);
}

module.exports = { prepareNewAnalysisPrompt, prepareHoldClosePrompt, prepareDxyPrompt };
