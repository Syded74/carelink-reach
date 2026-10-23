'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {connection}=require('./client');
const ID='_design/carelink-authority';
(async()=>{
  const couch=connection('CHT_COUCH_URL');
  const source=fs.readFileSync(path.join(__dirname,'..','authority','validate_doc_update.js'),'utf8');
  // CouchDB expects a bare function expression; drop the leading comment block.
  const doc={_id:ID,validate_doc_update:source.slice(source.indexOf('function(')).trim()};
  if(process.argv.includes('--remove')){
    const current=await couch('/medic/'+encodeURIComponent(ID));
    await couch('/medic/'+encodeURIComponent(ID)+'?rev='+current._rev,{method:'DELETE'});
    console.log('Removed '+ID+'. CHT design docs were not touched.');return;
  }
  try {doc._rev=(await couch('/medic/'+encodeURIComponent(ID)))._rev;}
  catch(e){if(e.status!==404){throw e;}}
  await couch('/medic/'+encodeURIComponent(ID),{method:'PUT',body:JSON.stringify(doc)});
  console.log('Deployed '+ID+' (separate from CHT design docs, which CHT never removes on startup).');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
