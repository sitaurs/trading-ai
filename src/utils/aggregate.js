function aggregateM1toM5(candles){
  if(!candles||!candles.length) return [];
  const sorted = candles.slice().sort((a,b)=> new Date(a.time)-new Date(b.time));
  const result=[];
  let block=null;
  for(const c of sorted){
    const d=new Date(c.time);
    const floormin=Math.floor(d.getUTCMinutes()/5)*5;
    const start=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),d.getUTCHours(),floormin,0));
    if(!block || start.getTime()!==block.startTime){
      if(block){
        result.push({
          open:block.first.open,
          close:block.last.close,
          high:block.high,
          low:block.low,
          tick_volume:block.vol,
          time:new Date(block.startTime).toUTCString(),
          real_volume:0,
          spread:0
        });
      }
      block={startTime:start.getTime(),first:c,last:c,high:c.high,low:c.low,vol:c.tick_volume};
    }else{
      block.last=c;
      if(c.high>block.high) block.high=c.high;
      if(c.low<block.low) block.low=c.low;
      block.vol+=c.tick_volume;
    }
  }
  if(block){
    result.push({
      open:block.first.open,
      close:block.last.close,
      high:block.high,
      low:block.low,
      tick_volume:block.vol,
      time:new Date(block.startTime).toUTCString(),
      real_volume:0,
      spread:0
    });
  }
  return result;
}

module.exports={aggregateM1toM5};
