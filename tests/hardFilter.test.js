const assert = require('assert');
const {passesHardFilter} = require('../src/utils/hardFilter');

// helper to build candles
function makeCandles(range, bodyRatio, breakSwing){
  const arr=[];
  for(let i=0;i<59;i++){
    arr.push({open:1, high:1+range, low:1, close:1+range*bodyRatio, tick_volume:10, time:new Date(2025,0,1,0,i*5).toUTCString()});
  }
  const lastHigh=breakSwing?1+range*2:1+range*0.8;
  const lastLow=breakSwing?1-range:1;
  arr.push({open:1, high:lastHigh, low:lastLow, close:1+range*bodyRatio, tick_volume:10, time:new Date(2025,0,1,0,59*5).toUTCString()});
  return arr;
}

const api={fetchOhlcv: async ()=> makeCandles(1,1,true)};
passesHardFilter('TEST',true,api).then(res=>{
  assert.strictEqual(res.pass,true);
  console.log('hardFilter valid pass test passed');
});

const apiRange={fetchOhlcv: async ()=> makeCandles(0.2,1,true)};
passesHardFilter('TEST',true,apiRange).then(res=>{
  assert.strictEqual(res.pass,false);
  assert.strictEqual(res.reason.startsWith('range'),true);
  console.log('hardFilter range fail test passed');
});

const apiBody={fetchOhlcv: async ()=> makeCandles(1,0.1,true)};
passesHardFilter('TEST',true,apiBody).then(res=>{
  assert.strictEqual(res.pass,false);
  assert.strictEqual(res.reason,'body_lt_ratio');
  console.log('hardFilter body fail test passed');
});

const apiSwing={fetchOhlcv: async ()=> makeCandles(1,1,false)};
passesHardFilter('TEST',true,apiSwing).then(res=>{
  assert.strictEqual(res.pass,false);
  assert.strictEqual(res.reason,'no_swing_break');
  console.log('hardFilter swing fail test passed');
});
