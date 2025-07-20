const tz = 'Asia/Jakarta';

function parseRawSessions(str) {
  return (str || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const parts = s.split('-');
      if (parts.length < 2) return null;
      const [start, end] = parts;
      if (!start || !end) return null;
      return { start: start.trim(), end: end.trim() };
    })
    .filter(Boolean);
}

function toMinutes(t){
  const [h,m] = t.split(':').map(Number);
  return h*60 + m;
}

function expandSlot(slot){
  const s = toMinutes(slot.start);
  let e = toMinutes(slot.end);
  if (e <= s) e += 1440; // rollover
  return {start:s, end:e};
}

function mergeIntervals(intervals){
  if(!intervals.length) return [];
  const sorted = intervals.sort((a,b)=>a.start-b.start);
  const result=[sorted[0]];
  for(let i=1;i<sorted.length;i++){
    const cur = sorted[i];
    const last = result[result.length-1];
    if(cur.start <= last.end){
      last.end = Math.max(last.end, cur.end);
    } else {
      result.push({...cur});
    }
  }
  return result;
}

const DEFAULT_SESSIONS = '14:00-23:00,19:00-04:00';
let cachedWindows=null;
function buildWindows(){
  if(cachedWindows) return cachedWindows;
  const raw = parseRawSessions(process.env.TRADING_SESSIONS || DEFAULT_SESSIONS);
  const expanded = raw.map(expandSlot);
  cachedWindows = mergeIntervals(expanded);
  return cachedWindows;
}

function getMinutesWIB(date){
  const d = new Date(date || Date.now());
  const local = new Date(d.toLocaleString('en-US',{timeZone:tz}));
  return local.getHours()*60 + local.getMinutes();
}

function isWithinSession(date){
  const mins = getMinutesWIB(date);
  const windows = buildWindows();
  for(const w of windows){
    let m = mins;
    if(m < w.start) m += 1440;
    if(m >= w.start && m < w.end) return true;
  }
  return false;
}

function classifySegment(date){
  const d = new Date(date || Date.now());
  const local = new Date(d.toLocaleString('en-US',{timeZone:tz}));
  const h = local.getHours();
  const m = local.getMinutes();
  const min = h*60 + m;
  if(min>=14*60 && min<19*60) return 'LONDON';
  if(min>=19*60 && min<23*60) return 'OVERLAP';
  if(min>=23*60 || min<4*60) return 'NY_LATE';
  return 'OUT';
}

module.exports={parseRawSessions,expandSlot,mergeIntervals,buildWindows,isWithinSession,classifySegment};
