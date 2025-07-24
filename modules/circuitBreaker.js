const fs = require('fs').promises;
const path = require('path');
const { getLogger } = require('./logger');
const log = getLogger('CircuitBreaker');

const DAILY_LOG_PATH = path.join(__dirname, '..', 'config', 'daily_profit_log.json');
const MAX_CONSECUTIVE_LOSSES = 3; // batas kerugian harian

async function readJson(file){
  try{
    const data = await fs.readFile(file, 'utf8');
    return JSON.parse(data);
  }catch(err){
    return null;
  }
}

async function isTripped(){
  const today = new Date().toISOString().split('T')[0];
  const data = await readJson(DAILY_LOG_PATH);
  if(data && data[today] && data[today].losses >= MAX_CONSECUTIVE_LOSSES){
    log.warn(`!!! CIRCUIT BREAKER AKTIF: mencapai ${data[today].losses} kerugian hari ini.`);
    return true;
  }
  return false;
}

module.exports = { isTripped };
