'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {generate}=require('../lib/demo-data');
const {exportAggregates}=require('../lib/oi-export');
const {assess}=require('../lib/need-score');
const NOW=Date.parse('2026-10-21T09:00:00Z');
const docs=generate(NOW).docs;
const {dataset,provenance}=exportAggregates(docs,'2026-10-21','2026-10-21T10:00:00Z');

test('oi export: no person, name, phone or record id reaches the engine dataset',()=>{
 const text=JSON.stringify(dataset);
 // Staff are person contacts too; only their id may appear, as the community's responsible worker.
 const people=docs.filter(d=>d.type==='contact'&&d.contact_type==='carelink_individual'&&!d.carelink_role);
 assert.ok(people.length);
 const staff=docs.filter(d=>d.carelink_role).map(d=>d._id);
 for(const c of dataset.communities){assert.ok(!c.responsible_worker||staff.includes(c.responsible_worker),c.responsible_worker);}
 for(const p of people){assert.ok(!text.includes(p._id),p._id);assert.ok(!text.includes(p.name),p.name);if(p.phone){assert.ok(!text.includes(p.phone));}}
 for(const h of docs.filter(d=>d.contact_type==='carelink_household')){assert.ok(!text.includes(h._id),h._id);}
 for(const r of docs.filter(d=>d.type==='data_record')){assert.ok(!text.includes(r._id),r._id);}
 const keys=new Set(dataset.history.flatMap(Object.keys));
 assert.deepEqual([...keys].sort(),['community_id','followups_due','followups_resolved','missed_appointments','period_start','referrals_open','reported','requests_created','transport_barriers','visits_completed']);
});
test('oi export: workload counts match the CHT need score in encounters; danger signs and referrals stay out of routine work',()=>{
 const a=assess(docs,'2026-10-21');
 const mch=require('../lib/mch');
 const STAGE={antenatal_care:'anc',postnatal_care:'pnc',child_welfare:'cwc'};
 const ROUTINE=['firstVisit','scheduledFollowUp','appointmentDue','missedAppointment','missingAssessment'];
 for(const c of dataset.current){
  const households=a.households.filter(h=>h.community===c.community_id);
  const items=households.flatMap(h=>h.items);
  assert.equal(c.urgent_items_excluded,items.filter(i=>['recordedConcern','referralFollowUp'].includes(i.kind)).length);
  const people=[...new Set(items.filter(i=>ROUTINE.includes(i.kind)).map(i=>i.person))];
  const requests=items.filter(i=>i.kind==='open_request');
  // A request merges with a household member whose follow-ups are for the same service stage.
  const stageOf=id=>{const p=docs.find(d=>d._id===id);return mch.currentStage(p,docs.filter(r=>r.fields&&r.fields.patient_id===id));};
  const used=new Set();
  const merged=requests.filter(r=>{
   const req=docs.find(d=>d._id===r.record);const h=households.find(x=>x.items.includes(r));
   const match=people.find(p=>!used.has(p)&&docs.find(d=>d._id===p).parent._id===h.id&&stageOf(p)===STAGE[req.fields.care_need]);
   if(match){used.add(match);return true;}return false;}).length;
  assert.equal(c.pending_followups,people.length+requests.length-merged);
  assert.equal(c.open_requests,requests.length);
  assert.equal(c.unique_people,people.length);
  assert.equal(c.open_maternal_followups+c.open_child_followups,items.filter(i=>ROUTINE.includes(i.kind)).length);
 }
 const requests=docs.filter(d=>d.form==='carelink_request').length;
 assert.equal(dataset.history.reduce((s,r)=>s+r.requests_created,0),requests);
});
test('oi export: a repeated (re-synced) report document is counted once',()=>{
 const request=docs.find(d=>d.form==='carelink_request');
 const again=exportAggregates([...docs,{...request}],'2026-10-21','x').dataset;
 assert.equal(again.history.reduce((s,r)=>s+r.requests_created,0),dataset.history.reduce((s,r)=>s+r.requests_created,0));
});

test('oi export: a facility-scoped engine never aggregates a different facility or its records',()=>{
 const {scopeToFacility}=require('../lib/oi-export');
 const foreign=[{_id:'other-facility',type:'contact',contact_type:'carelink_facility'},
  {_id:'other-community',type:'contact',contact_type:'carelink_community',parent:{_id:'other-facility'}},
  {_id:'other-household',type:'contact',contact_type:'carelink_household',parent:{_id:'other-community'}},
  {_id:'other-request',type:'data_record',form:'carelink_request',fields:{patient_id:'other-household'}}];
 const own=scopeToFacility([...docs,...foreign],'carelink-demo-facility');
 for(const d of foreign)assert.ok(!own.some(x=>x._id===d._id));
 assert.ok(own.some(d=>d._id==='carelink-demo-household-1'));
});

test('oi export: confirmed plan capacity is preserved, not reduced to one visit',()=>{
 const assignment={_id:'confirmed-plan-test',type:'data_record',form:'carelink_oi_assignment',fields:{patient_id:'carelink-demo-community-3',worker_id:'carelink-demo-cho-2',date:'2026-11-04',items_planned:7}};
 const d=exportAggregates([...docs,assignment],'2026-10-21','x').dataset;
 assert.equal(d.confirmed_assignments.find(a=>a.day==='2026-11-04').min_followups,7);
});
test('test-created records are left out of demand exports',()=>{
 const community={_id:'c1',type:'contact',contact_type:'carelink_community',name:'Tolon'};
 const real={_id:'h1',type:'contact',contact_type:'carelink_household',name:'Real',parent:{_id:'c1'}};
 const test={_id:'h2',type:'contact',contact_type:'carelink_household',name:'Test',record_origin:'test',parent:{_id:'c1'}};
 const person={_id:'p2',type:'contact',contact_type:'carelink_individual',name:'Member',parent:{_id:'h2',parent:{_id:'c1'}}};
 const request=(id,patient)=>({_id:id,type:'data_record',form:'carelink_request',reported_date:Date.parse('2026-10-20T10:00:00Z'),fields:{patient_id:patient,followup_type:'visit'}});
 const out=exportAggregates([community,real,test,person,request('r1','h1'),request('r2','h2'),request('r3','p2')],'2026-10-21').dataset;
 const week=out.history.filter(r=>r.community_id==='c1').reduce((n,r)=>n+r.requests_created,0);
 assert.equal(week,1);
 const pending=out.current.find(c=>c.community_id==='c1').pending_followups;
 assert.equal(pending,1,'only the real household\'s open request is pending now');
});
