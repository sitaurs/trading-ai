const assert = require('assert');
const {aggregateM1toM5} = require('../src/utils/aggregate');

const start = new Date('2025-06-30T00:00:00Z');
const data=[];
for(let i=0;i<10;i++){
  data.push({
    open:i,
    high:i+0.5,
    low:i-0.5,
    close:i+0.2,
    tick_volume:10,
    time:new Date(start.getTime()+i*60000).toUTCString(),
    real_volume:0,
    spread:0
  });
}
const res = aggregateM1toM5(data);
assert.strictEqual(res.length,2);
assert.strictEqual(res[0].open,0);
assert.strictEqual(res[0].close,4.2);
assert.strictEqual(res[1].open,5);
assert.strictEqual(res[1].close,9.2);
console.log('aggregate tests passed');
