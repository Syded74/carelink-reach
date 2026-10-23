'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {generate}=require('../lib/demo-data');
const w=require('../lib/workflow');
const data=generate();
const requests=data.docs.filter(d=>d.form===w.FORMS.request);
const settings=require('../app_settings/base_settings.json');
function event(id,previous,status,request=requests[5]){return {_id:id,form:w.FORMS.coordination,fields:{request_id:request._id,expected_event:previous,status}};}
test('six-level hierarchy and seed counts are exact, stable and fictional',()=>{
 const counts=t=>data.docs.filter(d=>d.contact_type==='carelink_'+t).length;
 assert.equal(counts('region'),1);assert.equal(counts('district'),1);assert.equal(counts('facility'),1);assert.equal(counts('community'),3);assert.equal(counts('household'),10);
 assert.equal(requests.length,8);assert.equal(data.docs.filter(d=>d.form===w.FORMS.visit).length,3);
 assert.equal(data.docs.filter(d=>d.fields?.access_barrier?.startsWith('transport')).length,2);
 assert.equal(new Set(data.docs.map(d=>d._id)).size,data.docs.length);
 assert.deepEqual(data.docs.map(d=>d._id),generate().docs.map(d=>d._id));
 for(const d of data.docs) assert.equal(d.demo,true);
 for(const h of data.docs.filter(d=>d.contact_type==='carelink_household')){assert.match(h.parent._id,/community-/);assert.ok(data.docs.find(d=>d._id===h.responsible_worker_id));assert.ok(h.community_contact_id);}
});
test('only documented outcomes complete requests; five assigned is not five completed',()=>{
 const states=requests.map(r=>w.workflow(r,data.docs).state);
 assert.equal(states.filter(s=>s==='completed').length,3);assert.equal(states.filter(s=>s==='scheduled').length,2);assert.equal(states.filter(s=>s==='awaiting_assignment').length,3);
});
test('concurrent assignments block downstream tasks instead of silently choosing a worker',()=>{
 const r=requests[5],accepted=event('accepted',r._id,'accepted',r);
 const a=event('a','accepted','assigned',r),b=event('b','accepted','assigned',r);
 assert.equal(w.workflow(r,[accepted,a,b]).state,'conflict');
});
test('invalid transitions and stale predecessors cannot create a completed visit',()=>{
 const r=requests[5];assert.equal(w.workflow(r,[event('bad',r._id,'completed',r)]).state,'conflict');
 const result=w.workflow(r,[event('stale','missing','completed',r)]);assert.equal(result.state,'awaiting_assignment');assert.equal(result.orphaned.length,1);
});
test('same event replay does not create an extra outcome when reports are deduplicated by CouchDB ID',()=>{
 const r=requests[0];const records=new Map(data.docs.map(d=>[d._id,d]));for(const d of data.docs)records.set(d._id,d);
 assert.equal(w.workflow(r,[...records.values()]).state,'completed');assert.equal(records.size,data.docs.length);
});
test('community role has no clinical, messaging, task assignment, export or user-management permissions',()=>{
 for(const permission of ['can_update_reports','can_delete_reports','can_view_tasks','can_create_users','can_view_messages','can_export_all'])assert.ok(!settings.permissions[permission].includes('carelink_community'));
 assert.equal(settings.replication_depth.find(d=>d.role==='carelink_community').report_depth,1);
 for(const role of ['carelink_community','carelink_cho','carelink_coordinator','carelink_supervisor'])assert.equal(settings.roles[role].offline,true);
});
test('forms contain explicit consent, dates, linkage and no clinical risk thresholds',()=>{
 const read=n=>fs.readFileSync(path.join(__dirname,'../forms/app/'+n+'.xml'),'utf8');
 assert.match(read('carelink_request'),/Consent is needed/);assert.match(read('carelink_visit'),/cannot be in the future/);
 assert.match(read('carelink_coordination'),/expected_event/);assert.match(read('carelink_coordination'),/responsible_worker_id/);
 for(const file of fs.readdirSync(path.join(__dirname,'../forms/app')).filter(n=>n.endsWith('.xml'))){const xml=fs.readFileSync(path.join(__dirname,'../forms/app',file),'utf8');assert.match(xml,/instanceID/);assert.ok(!/nodeset="[^"]*(blood_pressure|diagnosis|prescription|triage_score|risk)/.test(xml),file);}
});
test('all configured target, role and contact labels have English translations; audio remains disabled',()=>{
 const en=fs.readFileSync(path.join(__dirname,'../translations/messages-en.properties'),'utf8');
 for(const t of require('../targets')){assert.ok(en.includes(t.translation_key+' ='));assert.ok(en.includes(t.subtitle_translation_key+' ='));}
 for(const r of Object.values(settings.roles))assert.ok(en.includes(r.name+' ='));
 for(const type of settings.contact_types)assert.ok(en.includes(type.name_key+' ='));
 assert.equal(require('../audio/manifest.json').enabled,false);
});
