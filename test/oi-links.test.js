'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const w=require('../lib/workflow');
const {linkDocs,dayProgress,linkId,dayPlanId}=require('../lib/oi-links');

// One facility, one community, three households; r1 and r2 accepted by the facility, r3 not yet reviewed.
function world(){
 const place=(id,type,parent)=>({_id:id,type:'contact',contact_type:type,name:id,parent:parent&&{_id:parent}});
 const docs=[place('f','carelink_facility'),place('c1','carelink_community','f'),
  ...['h1','h2','h3'].map(h=>({...place(h,'carelink_household','c1'),parent:{_id:'c1',parent:{_id:'f'}},name:'Household '+h})),
  {_id:'org.couchdb.user:sabukari',type:'user-settings',name:'sabukari',contact_id:'cho'},
  {_id:'p1',type:'data_record',form:'carelink_oi_proposal',fields:{patient_id:'f'}}];
 const report=(id,form,patient,fields,at)=>({_id:id,type:'data_record',form,reported_date:at,fields:{patient_id:patient,...fields}});
 [['r1','h1',1],['r2','h2',2],['r3','h3',3]].forEach(([id,h,at])=>docs.push(report(id,w.FORMS.request,h,{},at)));
 docs.push(report('a1',w.FORMS.coordination,'h1',{request_id:'r1',expected_event:'r1',status:'accepted'},4));
 docs.push(report('a2',w.FORMS.coordination,'h2',{request_id:'r2',expected_event:'r2',status:'accepted'},5));
 const assignment=(id,proposal,date,items)=>report(id,'carelink_oi_assignment','c1',{proposal_id:proposal,worker_id:'cho',worker_name:'Salamatu Abukari',date,community_name:'Tolon',items_planned:items},6);
 return {docs,report,assignment};
}
const state=(docs,id)=>w.workflow(docs.find(d=>d._id===id),docs.filter(d=>d.type==='data_record'&&d.fields.patient_id===docs.find(x=>x._id===id).fields.patient_id));

test('an approved day takes on accepted requests oldest first, up to its planned workload, and writes nothing twice',()=>{
 const {docs,assignment}=world();
 docs.push(assignment('day1','p1','2026-10-23',5));
 const out=linkDocs(docs,'f','2026-10-21');
 const plan=out.find(d=>d._id===dayPlanId('day1'));
 assert.deepEqual(plan.fields.request_ids,['r1','r2'],'r3 has not been accepted by the facility');
 assert.equal(plan.fields.worker_username,'sabukari');
 assert.deepEqual(out.filter(d=>d.form===w.FORMS.planLink).map(d=>d._id),[linkId('day1','r1'),linkId('day1','r2')]);
 docs.push(...out);
 assert.equal(state(docs,'r1').state,'scheduled');
 assert.equal(state(docs,'r3').state,'awaiting_assignment');
 assert.deepEqual(linkDocs(docs,'f','2026-10-21'),[],'a repeated cycle writes nothing');
 const small=world();small.docs.push(small.assignment('day1','p1','2026-10-23',1));
 assert.deepEqual(linkDocs(small.docs,'f','2026-10-21').find(d=>d.form==='carelink_oi_day_plan').fields.request_ids,['r1']);
});

test('a request held by a pending day is never planned twice; recording the day releases only unvisited requests',()=>{
 const {docs,assignment,report}=world();
 docs.push(assignment('day1','p1','2026-10-23',5));docs.push(...linkDocs(docs,'f','2026-10-21'));
 docs.push({_id:'p2',type:'data_record',form:'carelink_oi_proposal',fields:{patient_id:'f'}},assignment('day2','p2','2026-10-24',5));
 const day2=linkDocs(docs,'f','2026-10-21');
 assert.deepEqual(day2.find(d=>d._id===dayPlanId('day2')).fields.request_ids,[],'both requests already held by day 1');
 docs.push(...day2);
 // The CHO completes r1; recording the outreach day closes nothing.
 docs.push(report('v1',w.FORMS.visit,'h1',{request_id:'r1',expected_event:linkId('day1','r1'),status:'completed',actor:'sabukari',assignment_id:'day1'},8));
 docs.push(report('d1','carelink_oi_outreach_day','c1',{assignment_id:'day1',outcome:'partly'},9));
 assert.equal(state(docs,'r1').state,'completed');
 assert.equal(state(docs,'r2').state,'scheduled','the unvisited request stays open');
 const {counts}=dayProgress(docs.find(d=>d._id===dayPlanId('day1')),docs);
 assert.deepEqual([counts.planned,counts.completed,counts.open],[2,1,1]);
 // A later day may take on the released r2, never the completed r1.
 docs.push({_id:'p3',type:'data_record',form:'carelink_oi_proposal',fields:{patient_id:'f'}},assignment('day3','p3','2026-10-27',5));
 const later=linkDocs(docs,'f','2026-10-21').filter(d=>[dayPlanId('day3'),linkId('day3','r2')].includes(d._id)||d.fields.assignment_id==='day3');
 assert.deepEqual(later.find(d=>d._id===dayPlanId('day3')).fields.request_ids,['r2']);
 docs.push(...linkDocs(docs,'f','2026-10-21'));
 const r2=state(docs,'r2');assert.equal(r2.state,'scheduled');assert.equal(r2.last._id,linkId('day3','r2'));
});

test('day progress keeps partial and unsuccessful outcomes and flags a visit not made by the assigned CHO',()=>{
 const {docs,assignment,report}=world();
 docs.push(assignment('day1','p1','2026-10-23',5));docs.push(...linkDocs(docs,'f','2026-10-21'));
 docs.push(report('v1',w.FORMS.visit,'h1',{request_id:'r1',expected_event:linkId('day1','r1'),status:'in_progress',actor:'sabukari'},8));
 docs.push(report('v2',w.FORMS.visit,'h2',{request_id:'r2',expected_event:linkId('day1','r2'),status:'unable_to_complete',actor:'sabukari'},9));
 let {counts}=dayProgress(docs.find(d=>d._id===dayPlanId('day1')),docs);
 assert.deepEqual([counts.partly,counts.unable,counts.completed],[1,1,0]);
 assert.equal(state(docs,'r1').state,'in_progress');
 docs.push(report('v3',w.FORMS.visit,'h1',{request_id:'r1',expected_event:'v1',status:'completed',actor:'sabukari'},10));
 ({counts}=dayProgress(docs.find(d=>d._id===dayPlanId('day1')),docs));
 assert.equal(counts.completed,1,'a partly done visit followed by a completed one counts as completed');
 const other=world();other.docs.push(other.assignment('day1','p1','2026-10-23',5));other.docs.push(...linkDocs(other.docs,'f','2026-10-21'));
 other.docs.push(other.report('v1',w.FORMS.visit,'h1',{request_id:'r1',expected_event:linkId('day1','r1'),status:'completed',actor:'another-user'},8));
 assert.equal(dayProgress(other.docs.find(d=>d._id===dayPlanId('day1')),other.docs).counts.unverified,1);
});

test('past or already recorded days never take on requests',()=>{
 const {docs,assignment,report}=world();
 docs.push(assignment('past','p1','2026-10-01',5),assignment('done','p1','2026-12-01',5),report('d','carelink_oi_outreach_day','c1',{assignment_id:'done'},7));
 assert.deepEqual(linkDocs(docs,'f','2026-10-21'),[]);
});

test('links are never written onto a request that moved on, and a forged link is a conflict',()=>{
 const {docs,assignment,report}=world();
 docs.push(assignment('day1','p1','2026-10-23',5));
 const plan=linkDocs(docs,'f','2026-10-21').find(d=>d.form==='carelink_oi_day_plan');docs.push(plan);
 // The coordinator cancels r2 before the links are written (for example a crash between the two writes).
 docs.push(report('x2',w.FORMS.coordination,'h2',{request_id:'r2',expected_event:'a2',status:'cancelled'},7));
 assert.deepEqual(linkDocs(docs,'f','2026-10-21').map(d=>d._id),[linkId('day1','r1')]);
 const forged=world();
 forged.docs.push(forged.report('fake',w.FORMS.planLink,'h1',{request_id:'r1',expected_event:'a1',status:'scheduled'},7));
 assert.equal(state(forged.docs,'r1').state,'conflict');
});
