'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const mch=require('../lib/mch');
const mo=require('../lib/mch-outreach');
const {linkDocs,dayProgress,dayPlanId,followUpLinkId}=require('../lib/oi-links');
const {exportAggregates}=require('../lib/oi-export');

const DAY='2026-10-23';
// Tolon: household h1 with a mother (ANC, recorded follow-up due by the outreach day) and her child (CWC,
// appointment due that day); household h2 with an open antenatal request and its own pregnant woman; a
// Gburimani household whose mother belongs to another CHO.
function world(){
 const place=(id,type,parent,extra={})=>({_id:id,type:'contact',contact_type:type,name:id,parent:parent&&{_id:parent},reported_date:1,...extra});
 const docs=[place('f','carelink_facility'),place('c1','carelink_community','f'),place('c2','carelink_community','f'),
  place('h1','carelink_household','c1'),place('h2','carelink_household','c1'),place('h3','carelink_household','c2'),
  place('mother','carelink_individual','h1',{care_stage:'anc',responsible_worker_id:'cho'}),
  place('child','carelink_individual','h1',{care_stage:'cwc',mother_id:'mother',responsible_worker_id:'cho'}),
  place('woman2','carelink_individual','h2',{care_stage:'anc',responsible_worker_id:'cho'}),
  place('other','carelink_individual','h3',{care_stage:'anc',responsible_worker_id:'cho-b'}),
  {_id:'org.couchdb.user:sabukari',type:'user-settings',name:'sabukari',contact_id:'cho'},
  {_id:'p1',type:'data_record',form:'carelink_oi_proposal',fields:{patient_id:'f'}}];
 // Realistic record times: n hours after midnight on 20 October (the request comes on the 23rd, after the follow-ups fall due).
 const report=(id,form,patient,fields,at)=>({_id:id,type:'data_record',form,reported_date:Date.parse('2026-10-20T00:00:00Z')+at*3600000,fields:{patient_id:patient,...fields}});
 // Mother: ANC with complete vitals and a recorded follow-up date; danger sign recorded on woman2 (urgent, never routine).
 docs.push(report('anc1',mch.FORMS.anc,'mother',{follow_up_date:'2026-10-22',missing_vitals:'',danger_signs:''},2));
 docs.push(report('appt1',mch.FORMS.appointment,'child',{appointment_id:'a1',state:'scheduled',due_date:DAY},3));
 docs.push(report('anc2',mch.FORMS.anc,'woman2',{follow_up_date:'2026-10-30',missing_vitals:'',danger_signs:'bleeding_reported'},4));
 docs.push(report('req2','carelink_request','h2',{care_need:'antenatal_care'},80));
 docs.push(report('acc2','carelink_coordination','h2',{request_id:'req2',expected_event:'req2',status:'accepted'},81));
 docs.push(report('anc3',mch.FORMS.anc,'other',{follow_up_date:'2026-10-20',missing_vitals:'',danger_signs:''},7));
 const assignment=(id,date,items,community='c1')=>report(id,'carelink_oi_assignment',community,{proposal_id:'p1',worker_id:'cho',worker_name:'Salamatu Abukari',date,community_name:'Tolon',items_planned:items},8);
 return {docs,report,assignment};
}

test('projection: routine follow-ups keep their CHT task ids; danger signs and referrals never become routine work',()=>{
 const {docs}=world();
 const {routine,urgent}=mo.followUps(docs,DAY);
 assert.deepEqual(routine.filter(i=>i.community_id==='c1').map(i=>i.task_id).sort(),
  ['child:appointmentDue:a1','child:firstVisit:registration','mother:scheduledFollowUp:anc1'].sort());
 assert.deepEqual(urgent.map(i=>i.kind),['recordedConcern']);
 const item=routine.find(i=>i.task_id==='mother:scheduledFollowUp:anc1');
 assert.deepEqual([item.person_id,item.household_id,item.community_id,item.worker_id,item.category,item.due_date],['mother','h1','c1','cho','maternal','2026-10-22']);
 assert.equal(routine.find(i=>i.person_id==='child').category,'child');
 // Stable identity: projecting again (or a day later) gives the same ids; a future recorded date is not yet due.
 assert.deepEqual(mo.followUps(docs,DAY).routine.map(i=>i.task_id),routine.map(i=>i.task_id));
 assert.ok(!mo.followUps(docs,'2026-10-21').routine.some(i=>i.task_id==='mother:scheduledFollowUp:anc1'),'no follow-up before its recorded date');
});

test('no double counting: obligations, people, households and encounters are counted separately',()=>{
 const {docs}=world();
 const c1=mo.communityWorkload(docs,DAY).get('c1');
 // mother 1 + child 2 obligations; woman2 has none routine (her follow-up is not due, her danger sign is urgent);
 // the antenatal request in h2 stands alone because woman2 has no open routine follow-up.
 assert.deepEqual(c1,{open_requests:1,open_maternal_followups:1,open_child_followups:2,unique_people:2,unique_households:2,encounters:3,urgent_items_excluded:1,
  encounters_request:1,encounters_anc:1,encounters_pnc:0,encounters_cwc:1});
 // Once woman2's ANC follow-up is due, her follow-up and the antenatal request are one encounter.
 const later=mo.communityWorkload(docs,'2026-10-30').get('c1');
 assert.equal(later.encounters,3,'request merged with the same-stage follow-up of a household member');
 assert.equal(later.open_requests,1);assert.equal(later.unique_people,3);
 // The exporter carries exactly these counts (and counts a re-synced document once).
 const out=exportAggregates([...docs,{...docs.find(d=>d._id==='anc1')}],DAY,'x').dataset;
 const row=out.current.find(r=>r.community_id==='c1');
 assert.deepEqual([row.pending_followups,row.open_requests,row.open_maternal_followups,row.open_child_followups,row.unique_people],[3,1,1,2,2]);
 assert.ok(!JSON.stringify(out).includes('mother'),'no person id reaches the engine');
});

test('an approved day links the day CHO\'s follow-ups within its encounter capacity, once, and never another CHO\'s',()=>{
 const {docs,assignment}=world();
 docs.push(assignment('day1',DAY,2));
 const out=linkDocs(docs,'f','2026-10-21');
 const plan=out.find(d=>d._id===dayPlanId('day1'));
 // Capacity 2 encounters, oldest first: the mother (due 2026-10-22) and the child (due 2026-10-23); the request waits.
 assert.deepEqual(plan.fields.followups.map(f=>f.task_id).sort(),['child:appointmentDue:a1','child:firstVisit:registration','mother:scheduledFollowUp:anc1'].sort());
 assert.deepEqual(plan.fields.request_ids,[]);
 assert.equal(plan.fields.encounters_planned,2);
 assert.deepEqual(out.filter(d=>d.form==='carelink_oi_followup_link').map(d=>d.fields.patient_id).sort(),['child','child','mother']);
 assert.ok(!out.some(d=>d.fields.patient_id==='other'||(d.fields.followups||[]).some(f=>f.person_id==='other')),'another CHO\'s patient is never linked');
 docs.push(...out);
 assert.deepEqual(linkDocs(docs,'f','2026-10-21'),[],'a repeated cycle writes nothing');
 // A second approved day cannot take obligations held by the pending first day; it takes the waiting request.
 docs.push(assignment('day2','2026-10-26',5));
 const second=linkDocs(docs,'f','2026-10-21').find(d=>d._id===dayPlanId('day2'));
 assert.deepEqual(second.fields.followups,[]);
 assert.deepEqual(second.fields.request_ids,['req2']);
});

test('only recorded resolutions complete a planned follow-up; partial, unrelated and unverified outcomes stay visible',()=>{
 const {docs,assignment,report}=world();
 docs.push(assignment('day1',DAY,2));docs.push(...linkDocs(docs,'f','2026-10-21'));
 const plan=()=>docs.find(d=>d._id===dayPlanId('day1'));
 // The CHO sees the mother (ANC visit recorded) and resolves her follow-up; the child is not seen.
 docs.push(report('anc4',mch.FORMS.anc,'mother',{missing_vitals:'',danger_signs:''},100));
 let p=dayProgress(plan(),docs).followups;
 assert.deepEqual([p.completed,p.partly,p.open],[0,1,2],'a visit alone does not resolve the follow-up');
 docs.push(report('res1',mch.FORMS.resolution,'mother',{task_id:'mother:scheduledFollowUp:anc1',task_kind:'scheduledFollowUp',reason:'Seen at outreach.',actor:'sabukari',assignment_id:'day1'},101));
 p=dayProgress(plan(),docs).followups;
 assert.deepEqual([p.planned,p.completed,p.open],[3,1,2]);
 assert.ok(mch.projectTasks({_id:'child'},docs.filter(d=>d.fields&&d.fields.patient_id==='child'),DAY).length===2,'the child\'s follow-ups stay open');
 // Replaying the same resolution, or a second resolution of the same task, completes nothing more.
 docs.push({...docs.find(d=>d._id==='res1')});
 docs.push(report('res1b',mch.FORMS.resolution,'mother',{task_id:'mother:scheduledFollowUp:anc1',task_kind:'scheduledFollowUp',reason:'Again.',actor:'sabukari'},102));
 assert.equal(dayProgress(plan(),docs).followups.completed,1);
 const resolvedWeeks=exportAggregates(docs,DAY,'x').dataset.history.reduce((n,r)=>n+r.followups_resolved,0);
 assert.equal(resolvedWeeks,1,'a follow-up resolved twice counts once in history');
 // The appointment attended (a later record) closes that obligation without a resolution; a resolution by another user is unverified.
 docs.push(report('appt2',mch.FORMS.appointment,'child',{appointment_id:'a1',expected_event:'appt1',state:'attended',due_date:DAY,actor:'sabukari'},103));
 docs.push(report('res2',mch.FORMS.resolution,'child',{task_id:'child:firstVisit:registration',task_kind:'firstVisit',reason:'x',actor:'someone-else'},104));
 p=dayProgress(plan(),docs).followups;
 assert.deepEqual([p.completed,p.closed,p.unverified,p.open],[1,1,1,0]);
});

test('recording the outreach day releases unfinished follow-ups for a later plan without changing their history',()=>{
 const {docs,assignment,report}=world();
 docs.push(assignment('day1',DAY,2));docs.push(...linkDocs(docs,'f','2026-10-21'));
 const before=docs.filter(d=>d.fields&&d.fields.patient_id==='child').length;
 docs.push(report('d1','carelink_oi_outreach_day','c1',{assignment_id:'day1',outcome:'partly'},30));
 docs.push(assignment('day3','2026-10-27',5));
 const later=linkDocs(docs,'f','2026-10-21').find(d=>d._id===dayPlanId('day3'));
 assert.ok(later.fields.followups.some(f=>f.task_id==='child:appointmentDue:a1'),'released follow-up planned again');
 assert.equal(docs.filter(d=>d.fields&&d.fields.patient_id==='child').length,before,'no record about the child was changed or removed');
 // A follow-up resolved before its link is written is not linked.
 const w2=world();w2.docs.push(w2.assignment('day1',DAY,2));
 const plan=linkDocs(w2.docs,'f','2026-10-21').find(d=>d.form==='carelink_oi_day_plan');w2.docs.push(plan);
 w2.docs.push(w2.report('res',mch.FORMS.resolution,'mother',{task_id:'mother:scheduledFollowUp:anc1',task_kind:'scheduledFollowUp',reason:'done',actor:'sabukari'},9));
 assert.ok(!linkDocs(w2.docs,'f','2026-10-21').some(d=>d._id===followUpLinkId('day1','mother:scheduledFollowUp:anc1')));
});

test('a day planned by visit type takes on units of those types only',()=>{
 const {docs,report}=world();
 // One child welfare visit and one household request planned; the mother's ANC follow-up waits.
 docs.push(report('typed','carelink_oi_assignment','c1',{proposal_id:'p1',worker_id:'cho',worker_name:'Salamatu Abukari',date:DAY,community_name:'Tolon',items_planned:2,served_by_type:{cwc:1,request:1}},8));
 const plan=linkDocs(docs,'f','2026-10-21').find(d=>d._id===dayPlanId('typed'));
 assert.deepEqual([...new Set(plan.fields.followups.map(f=>f.person_id))],['child']);
 assert.deepEqual(plan.fields.request_ids,['req2']);
});

test('coverage indicators: unserved planned work from past days and days since outreach, without test plans',()=>{
 const {docs,assignment,report}=world();
 docs.push(assignment('day1',DAY,2));docs.push(...linkDocs(docs,'f','2026-10-21'));
 const later='2026-10-24';
 // The day passed; one of four planned follow-ups was resolved by the CHO.
 docs.push(report('res1',mch.FORMS.resolution,'mother',{task_id:'mother:scheduledFollowUp:anc1',task_kind:'scheduledFollowUp',reason:'Seen.',actor:'sabukari'},100));
 let row=exportAggregates(docs,later,'x').dataset.current.find(r=>r.community_id==='c1');
 assert.equal(row.unserved_planned,2,'two child follow-ups planned and not done');
 assert.ok(row.days_since_outreach>=0,'ANC visits count as documented outreach');
 // A day plan from a test plan never counts operationally.
 const plan=docs.find(d=>d._id===dayPlanId('day1'));plan.fields.includes_test_records=true;
 row=exportAggregates(docs,later,'x').dataset.current.find(r=>r.community_id==='c1');
 assert.equal(row.unserved_planned,0);
 assert.equal(exportAggregates(docs,later,'x',{includeTestRecords:true}).dataset.current.find(r=>r.community_id==='c1').unserved_planned,2);
});

test('commitments: a recorded outreach day and test plans are not fixed commitments in an operational export',()=>{
 const {docs,assignment,report}=world();
 docs.push(assignment('day1',DAY,2));
 const confirmed=d=>exportAggregates(d,'2026-10-21','x').dataset.confirmed_assignments.filter(a=>a.day===DAY);
 assert.equal(confirmed(docs).length,1,'an approved, unrecorded day is a commitment');
 docs.push(report('d1','carelink_oi_outreach_day','c1',{assignment_id:'day1',outcome:'not_done'},50));
 assert.equal(confirmed(docs).length,0,'a recorded day is over');
 const t=world();t.docs.push(t.assignment('day1',DAY,2));t.docs.find(d=>d._id==='p1').fields.includes_test_records=true;
 assert.equal(confirmed(t.docs).length,0,'a test plan never commits a real day');
 assert.equal(exportAggregates(t.docs,'2026-10-21','x',{includeTestRecords:true}).dataset.confirmed_assignments.filter(a=>a.day===DAY).length,1);
});
