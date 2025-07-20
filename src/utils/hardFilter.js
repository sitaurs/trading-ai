const axios = require('axios');
const { ATR } = require('technicalindicators');
const { aggregateM1toM5 } = require('./aggregate');

async function fetchOhlcv(symbol, timeframe='m5', count=60){
  const url = `https://api.mt5.flx.web.id/ohlcv?symbol=${symbol}&timeframe=${timeframe}&count=${count}`;
  const res = await axios.get(url);
  return res.data || [];
}

async function passesHardFilter(symbol, useM1Fallback=true, api={fetchOhlcv}){
  let candles = await api.fetchOhlcv(symbol,'m5',60);
  if(candles.length<60 && useM1Fallback){
    const m1 = await api.fetchOhlcv(symbol,'m1',300);
    candles = aggregateM1toM5(m1).slice(-60);
  }
  if(candles.length<60) return {pass:false, reason:'insufficient_data'};

  const highs = candles.map(c=>c.high);
  const lows = candles.map(c=>c.low);
  const closes = candles.map(c=>c.close);
  const atrArr = ATR.calculate({period:14, high:highs, low:lows, close:closes});
  const atr = atrArr[atrArr.length-1];
  const last = candles[candles.length-1];
  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  if(range < (parseFloat(process.env.SWEEP_ATR_MULTIPLIER)||1.5)*atr)
    return {pass:false, reason:'range_lt_multiplier', atr, range, body};
  if(body < (parseFloat(process.env.MIN_BODY_RATIO)||0.7)*range)
    return {pass:false, reason:'body_lt_ratio', atr, range, body};
  const look = parseInt(process.env.SWING_LOOKBACK)||8;
  const prevHigh = Math.max(...highs.slice(-look-1,-1));
  const prevLow = Math.min(...lows.slice(-look-1,-1));
  if(!(last.high > prevHigh || last.low < prevLow))
    return {pass:false, reason:'no_swing_break', atr, range, body};
  return {pass:true, atr, range, body, wickAtrRatio: range/atr};
}

module.exports={passesHardFilter};
