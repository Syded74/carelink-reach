'use strict';
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const {connection,stateDir}=require('./client');
(async()=>{
 const api=connection();const couch=connection('CHT_COUCH_URL');
 const credentials=JSON.parse(fs.readFileSync(path.join(stateDir,'demo-credentials.json')));
 const results=[];
 async function request(user,route,options={}){const r=await fetch('http://localhost:5988'+route,{...options,headers:{Authorization:'Basic '+Buffer.from(user+':'+credentials[user].password).toString('base64'),'Content-Type':'application/json'}});const raw=await r.text();let body;try{body=JSON.parse(raw);}catch{body=raw;}return{status:r.status,body};}
 const ids=async user=>{const r=await request(user,'/api/v1/replication/get-ids');assert.equal(r.status,200);return r.body.doc_ids_revs.map(d=>d.id);};
 const community=await ids('carelink_contact_1');
 assert.ok(community.includes('carelink-demo-household-1'));assert.ok(!community.includes('carelink-demo-household-8'));
 results.push({check:'Community 1 replication excludes Community 3 household',passed:true});
 const forbidden=await request('carelink_contact_1','/medic/carelink-demo-household-8');assert.ok([403,404].includes(forbidden.status));
 results.push({check:'Direct cross-community document read blocked',status:forbidden.status,passed:true});
 const manage=await request('carelink_contact_1','/api/v1/users');assert.equal(manage.status,403);
 results.push({check:'Community contact cannot list users',status:manage.status,passed:true});
 const cho=await ids('carelink_cho_a');assert.ok(cho.includes('carelink-demo-household-5'));assert.ok(!cho.includes('carelink-demo-household-8'));
 results.push({check:'CHO A has Community 1 and 2 only',passed:true});
 const fixture={_id:'carelink-demo-security-facility-other',type:'contact',contact_type:'carelink_facility',name:'DEMO isolated security test facility',demo:true};
 try{
  await couch('/medic/'+fixture._id,{method:'PUT',body:JSON.stringify(fixture)});
  const supervisor=await ids('carelink_supervisor');assert.ok(!supervisor.includes(fixture._id));
  const direct=await request('carelink_supervisor','/medic/'+fixture._id);assert.ok([403,404].includes(direct.status));
  results.push({check:'Supervisor scope excludes independent facility',status:direct.status,passed:true});
 }finally{const doc=await couch('/medic/'+fixture._id);await couch('/medic/'+fixture._id+'?rev='+doc._rev,{method:'DELETE'});}
 // Server-side authority (_design/carelink-authority): the rejection reason must come from CareLink's rule, not CHT scope filtering
 const event=(id,submitter)=>({_id:id,type:'data_record',form:'carelink_coordination',content_type:'xml',reported_date:Date.now(),contact:{_id:submitter},fields:{patient_id:'carelink-demo-household-1',request_id:'carelink-demo-request-1',status:'accepted',demo:'true'}});
 const posted=[];
 try{
  const denied=await request('carelink_contact_1','/medic/_bulk_docs',{method:'POST',body:JSON.stringify({docs:[event('carelink-demo-security-forged-coordination','carelink-demo-contact-1')]})});
  assert.equal(denied.body[0]?.error,'forbidden',JSON.stringify(denied.body));assert.match(denied.body[0].reason,/not authorised to submit carelink_coordination/);
  results.push({check:'Community contact cannot write a coordination event through the API',status:denied.status,error:denied.body[0].error,passed:true});
  const allowed=await request('carelink_coordinator','/medic/_bulk_docs',{method:'POST',body:JSON.stringify({docs:[event('carelink-demo-security-coordinator-event','carelink-demo-coordinator')]})});
  assert.ok(allowed.body[0]?.ok,JSON.stringify(allowed.body));posted.push('carelink-demo-security-coordinator-event');
  const rev=allowed.body[0].rev;
  const edit=await request('carelink_coordinator','/medic/_bulk_docs',{method:'POST',body:JSON.stringify({docs:[{...event('carelink-demo-security-coordinator-event','carelink-demo-coordinator'),_rev:rev,fields:{status:'completed'}}]})});
  assert.equal(edit.body[0]?.error,'forbidden',JSON.stringify(edit.body));assert.match(edit.body[0].reason,/append-only/);
  results.push({check:'Coordinator can append a coordination event but cannot rewrite it',passed:true});
 }finally{for(const id of posted){const doc=await couch('/medic/'+id);await couch('/medic/'+id+'?rev='+doc._rev,{method:'DELETE'});}}
 // Maternal and child records (fictional seed mother in Community 1)
 const MOTHER='carelink-demo-mch-mother';
 assert.ok(cho.includes(MOTHER));assert.ok(!(await ids('carelink_cho_b')).includes(MOTHER));
 results.push({check:'Maternal record replicates to CHO A only, not to CHO B in another community',passed:true});
 const mchDoc=(id,form,submitter,fields)=>({_id:id,type:'data_record',form,content_type:'xml',reported_date:Date.now(),contact:{_id:submitter},fields:{patient_id:MOTHER,demo:'true',...fields}});
 const mchPosted=[];
 try{
  const anc=await request('carelink_contact_1','/medic/_bulk_docs',{method:'POST',body:JSON.stringify({docs:[mchDoc('carelink-demo-security-forged-anc','carelink_anc_visit','carelink-demo-contact-1',{stage:'anc'})]})});
  assert.equal(anc.body[0]?.error,'forbidden',JSON.stringify(anc.body));assert.match(anc.body[0].reason,/not authorised to submit carelink_anc_visit/);
  results.push({check:'Community contact cannot write an ANC visit through the API',error:anc.body[0].error,passed:true});
  const created=await request('carelink_coordinator','/medic/_bulk_docs',{method:'POST',body:JSON.stringify({docs:[mchDoc('carelink-demo-security-coordinator-referral','carelink_mch_referral','carelink-demo-coordinator',{referral_id:'security-check',state:'created'})]})});
  assert.equal(created.body[0]?.error,'forbidden',JSON.stringify(created.body));assert.match(created.body[0].reason,/not authorised to record this referral state/);
  const ack=await request('carelink_coordinator','/medic/_bulk_docs',{method:'POST',body:JSON.stringify({docs:[mchDoc('carelink-demo-security-coordinator-ack','carelink_mch_referral','carelink-demo-coordinator',{referral_id:'security-check',state:'acknowledged'})]})});
  assert.ok(ack.body[0]?.ok,JSON.stringify(ack.body));mchPosted.push('carelink-demo-security-coordinator-ack');
  results.push({check:'Coordinator may acknowledge a referral but not create one (referral roles per state)',passed:true});
 }finally{for(const id of mchPosted){const doc=await couch('/medic/'+id);await couch('/medic/'+id+'?rev='+doc._rev,{method:'DELETE'});}}
 const result={timestamp:new Date().toISOString(),checks:results,limitations:['Server-side checks cover which role may submit each CareLink form; they do not verify that the contact field matches the submitting user.','Maternal and child records are fictional seed data. Revocation and cached-device erasure are not validated.']};
 fs.writeFileSync(path.join(__dirname,'../evidence/access-tests.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
