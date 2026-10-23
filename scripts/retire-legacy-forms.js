'use strict';
const {connection}=require('./client');
(async()=>{
 const db=connection('CHT_COUCH_URL');
 const docs=(await db('/medic/_all_docs?include_docs=true')).rows.map(r=>r.doc);
 const legacy=docs.filter(d=>d.type==='form'&&!d._id.startsWith('form:carelink_')&&!d._id.startsWith('form:contact:carelink_')&&!d._id.startsWith('form:training:'));
 for(const doc of legacy){doc.context={...doc.context,permission:'carelink_legacy_disabled'};await db('/medic/'+encodeURIComponent(doc._id),{method:'PUT',body:JSON.stringify(doc)});}
 console.log(`Disabled ${legacy.length} legacy form menus using supported context.permission. No forms or records deleted.`);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
