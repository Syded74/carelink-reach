'use strict';
// Test-only adapter for cht-conf-test-harness 5.0.4 on this Apple Silicon machine.
// Its bundled Chromium cannot start here. Use the installed Chrome without editing
// CHT Core or node_modules. Set CHROME_BIN to override the executable location.
const Module=require('node:module');
const original=Module._load;
Module._load=function(name,parent,isMain){
 if(name==='puppeteer-chromium-resolver'){
  return async()=>({executablePath:process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',puppeteer:original.call(this,'puppeteer-core',parent,isMain)});
 }
 return original.call(this,name,parent,isMain);
};
