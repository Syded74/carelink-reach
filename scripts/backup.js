'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { connection, stateDir } = require('./client');
(async()=>{
  const couch=connection('CHT_COUCH_URL');
  const destination=path.join(stateDir,'backups',new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(destination,{recursive:true,mode:0o700});
  for(const db of ['medic','_users']){
    const docs=await couch('/'+db+'/_all_docs?include_docs=true&attachments=true');
    fs.writeFileSync(path.join(destination,db+'.json'),JSON.stringify(docs,null,2),{mode:0o600});
  }
  fs.writeFileSync(path.join(stateDir,'latest-backup'),destination,{mode:0o600});
  console.log(destination);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
