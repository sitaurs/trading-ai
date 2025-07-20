const chalk = require('chalk');

const levelMap = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const envLevel = process.env.LOG_LEVEL ? process.env.LOG_LEVEL.toUpperCase() : 'INFO';
const minLevel = levelMap[envLevel] !== undefined ? levelMap[envLevel] : 2;

function format(level, context, message) {
  const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
  const colored = {
    ERROR: chalk.redBright.bold.inverse(`[${level}]`),
    WARN: chalk.yellowBright.bold(`[${level}]`),
    INFO: chalk.blueBright.bold(`[${level}]`),
    DEBUG: chalk.gray(`[${level}]`)
  }[level] || `[${level}]`;
  const ctx = chalk.cyan(`[${context}]`);
  return `${chalk.green(timestamp)} ${colored} ${ctx} ${message}`;
}

function getLogger(context){
  return {
    info:(msg,data)=>log('INFO',context,msg,data),
    warn:(msg,data)=>log('WARN',context,msg,data),
    error:(msg,data)=>log('ERROR',context,msg,data),
    debug:(msg,data)=>log('DEBUG',context,msg,data)
  };
}

function log(level, context, message, data){
  if(levelMap[level] <= minLevel){
    console.log(format(level, context, message));
    if(data){
      const out = typeof data==='object'? JSON.stringify(data,null,2):data;
      console.log(chalk.gray(out));
    }
  }
}

module.exports = { getLogger };
