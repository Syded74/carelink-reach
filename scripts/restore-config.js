'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {connection}=require('./client');
(async()=>{
  if(!process.env.CARELINK_BACKUP){throw Error('Set CARELINK_BACKUP to the reviewed backup directory.');}
  const couch=connection('CHT_COUCH_URL');
  const before=JSON.parse(fs.readFileSync(path.join(process.env.CARELINK_BACKUP,'medic.json'))).rows.map(r=>r.doc);
  // Configuration only: never restore user hashes or overwrite patient/data records.
  const docs=before.filter(d=>['settings','branding','resources','privacy-policies'].includes(d._id)||d.type==='form'||d.type==='translations');
  for(const doc of docs){
    try { const current=await couch('/medic/'+encodeURIComponent(doc._id));doc._rev=current._rev; }
    catch(e){if(e.status!==404){throw e;}delete doc._rev;}
    await couch('/medic/'+encodeURIComponent(doc._id),{method:'PUT',body:JSON.stringify(doc)});
  }
  console.log(`Restored ${docs.length} configuration documents. Demo records and extra CareLink form docs were not deleted; use manifest cleanup separately.`);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
