const assert = require('assert');
const {passesHardFilter} = require('../src/utils/hardFilter');

function baseCandles(){
  const arr=[];
  for(let i=0;i<59;i++){
    arr.push({open:1, high:2, low:1, close:2, tick_volume:10, time:new Date(2025,0,1,0,i*5).toUTCString()});
  }
  return arr;
}

(async()=>{
  const arrPass = baseCandles();
  arrPass.push({open:0, high:3, low:0, close:3, tick_volume:10, time:new Date(2025,0,1,0,59*5).toUTCString()});
  const resPass = await passesHardFilter('TEST', true, {fetchOhlcv: async()=>arrPass});
  assert.strictEqual(resPass.pass, true);
  console.log('hardFilter pass test passed');

  const arrRange = baseCandles();
  arrRange.push({open:1, high:1.4, low:1, close:1.4, tick_volume:10, time:new Date(2025,0,1,0,59*5).toUTCString()});
  const resRange = await passesHardFilter('TEST', true, {fetchOhlcv: async()=>arrRange});
  assert.strictEqual(resRange.pass, false);
  console.log('hardFilter range fail test passed');
})();
