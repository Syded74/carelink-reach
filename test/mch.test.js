'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const mch=require('../lib/mch');
const s=require('../lib/schedules');
const F=mch.FORMS;
const TODAY='2026-10-21';
const mother={_id:'m1',contact_type:'carelink_individual',care_stage:'anc'};
let clock=1000;
const report=(id,form,fields,at)=>({_id:id,type:'data_record',form,reported_date:at??(clock+=1000),fields:{patient_id:'m1',...fields}});
const visit=(id,fields={})=>report(id,F.anc,{stage:'anc',missing_vitals:'',danger_signs:'',follow_up_date:'',...fields});
const appt=(id,appointment_id,state,due_date,expected_event='',at)=>report(id,F.appointment,{appointment_id,state,due_date,expected_event},at);
const ref=(id,referral_id,state,expected_event='')=>report(id,F.referral,{referral_id,state,expected_event});
const resolve=(task_id,reason='Fictional reason')=>report('res-'+task_id,F.resolution,{task_id,reason});
const kinds=(reports,today=TODAY)=>mch.projectTasks(mother,reports,today).map(t=>t.kind).sort();

test('mch tasks: first visit until any visit; missing assessment and concern come from the latest visit only',()=>{
 assert.deepEqual(kinds([]),['firstVisit']);
 const v1=visit('v1',{missing_vitals:'weight_kg',danger_signs:'bleeding_reported'});
 assert.deepEqual(kinds([v1]),['missingAssessment','recordedConcern']);
 assert.deepEqual(kinds([v1,visit('v2')]),[],'a newer complete visit clears both');
});
test('mch tasks: follow-up due on or before today, persists across later visits until resolved; future dates are not due',()=>{
 const v1=visit('v1',{follow_up_date:'2026-10-10'});
 const later=visit('v2',{follow_up_date:'2026-11-30'});
 assert.deepEqual(kinds([v1,later]),['scheduledFollowUp']);
 assert.equal(mch.projectTasks(mother,[v1,later],TODAY)[0].id,'m1:scheduledFollowUp:v1');
 assert.deepEqual(kinds([v1,later,resolve('m1:scheduledFollowUp:v1')]),[]);
 assert.deepEqual(kinds([v1,later,resolve('m1:scheduledFollowUp:v1','')]),['scheduledFollowUp'],'a resolution needs a reason');
});
test('mch tasks: missed is only ever recorded, never inferred from elapsed time',()=>{
 const a=appt('a1','A','scheduled','2026-01-01');
 assert.deepEqual(kinds([visit('v'),a]),['appointmentDue'],'a long-past appointment is still due, not missed');
 const missed=appt('a2','A','missed','2026-01-01','a1');
 assert.deepEqual(kinds([visit('v'),a,missed]),['missedAppointment']);
 assert.deepEqual(kinds([visit('v'),appt('a3','B','scheduled','2026-12-01')]),[],'future appointment not due');
});
test('mch appointments: transition table, reschedule must change the date, other events must not, no backdating',()=>{
 const root=appt('a1','A','scheduled','2026-10-01',undefined,5000);
 const state=events=>mch.appointments([root,...events])[0];
 assert.equal(state([appt('a2','A','rescheduled','2026-10-30','a1',6000)]).state,'rescheduled');
 assert.ok(state([appt('a2','A','rescheduled','2026-10-01','a1',6000)]).conflict,'reschedule without a new date');
 assert.ok(state([appt('a2','A','attended','2026-10-05','a1',6000)]).conflict,'attended changing the date');
 assert.ok(state([appt('a2','A','attended','2026-10-01','a1',4000)]).conflict,'backdated event');
 const attended=appt('a2','A','attended','2026-10-01','a1',6000);
 assert.ok(state([attended,appt('a3','A','missed','2026-10-01','a2',7000)]).conflict,'attended is terminal');
 assert.ok(state([appt('b','A','attended','2026-10-01','a1',6000),appt('c','A','missed','2026-10-01','a1',6500)]).conflict,'offline branch');
 assert.deepEqual(mch.APPOINTMENT_TRANSITIONS,{scheduled:['attended','missed','rescheduled','cancelled'],missed:['rescheduled','cancelled'],
  rescheduled:['attended','missed','rescheduled','cancelled'],attended:[],cancelled:[]});
});
test('mch tasks: conflicting appointment chains raise no task',()=>{
 const root=appt('a1','A','scheduled','2026-10-01');
 assert.deepEqual(kinds([visit('v'),root,appt('b','A','missed','2026-10-01','a1'),appt('c','A','attended','2026-10-01','a1')]),[]);
});
test('mch referrals: follow-up task until closed or cancelled; a resolution can never clear it',()=>{
 const created=ref('r1','R','created');
 assert.deepEqual(kinds([visit('v'),created]),['referralFollowUp']);
 assert.deepEqual(kinds([visit('v'),created,resolve('m1:referralFollowUp:R')]),['referralFollowUp']);
 const chain=[created,ref('r2','R','acknowledged','r1'),ref('r3','R','arrival_confirmed','r2'),ref('r4','R','outcome_recorded','r3'),ref('r5','R','closed','r4')];
 assert.equal(mch.referrals(chain)[0].state,'closed');
 assert.deepEqual(kinds([visit('v'),...chain]),[]);
 assert.ok(mch.referrals([created,ref('x','R','closed','r1')])[0].conflict,'cannot close without an outcome');
 assert.deepEqual(kinds([visit('v'),created,ref('x','R','closed','r1')]),[],'a conflicting referral issues no task');
});
test('mch urgency: band and reason follow the Flutter precedence',()=>{
 const u=reports=>mch.urgency(mother,reports,TODAY);
 assert.deepEqual(u([]),{level:'routine',reason:'First visit due'});
 assert.deepEqual(u([visit('v')]),{level:'routine',reason:'Routine follow-up'});
 assert.deepEqual(u([visit('v',{follow_up_date:'2026-10-01'})]),{level:'priority',reason:'Scheduled follow-up due'});
 assert.deepEqual(u([visit('v',{missing_vitals:'weight_kg',follow_up_date:'2026-10-01'}),ref('r','R','created')]),{level:'priority',reason:'Referral awaiting follow-up'});
 assert.deepEqual(u([visit('v',{danger_signs:'convulsions_reported'}),ref('r','R','created')]),{level:'urgent',reason:'Recorded danger sign'});
});
test('mch display rules: next due, EDD hidden after PNC or 42 days, delivery validity, duplicate doses',()=>{
 assert.equal(mch.nextDue([visit('v',{follow_up_date:'2026-11-02'}),appt('a','A','scheduled','2026-10-25')]),'2026-10-25');
 assert.equal(mch.nextDue([visit('v',{follow_up_date:'2026-11-02'})]),'2026-11-02');
 assert.equal(mch.showEdd('2026-09-10',[],TODAY),true);
 assert.equal(mch.showEdd('2026-09-08',[],TODAY),false,'more than 42 days past');
 assert.equal(mch.showEdd('2026-12-01',[report('p',F.pnc,{stage:'pnc'})],TODAY),false,'a PNC visit exists');
 const delivery=child_ids=>report('d',F.delivery,{delivery_date:'2026-10-20',child_ids});
 assert.equal(mch.deliveryValid(delivery('c1 c2')),true);
 for(const bad of ['','c1 c1','c1 m1']){assert.equal(mch.deliveryValid(delivery(bad)),false,bad);}
 const cwc=(id,dose)=>report(id,F.cwc,{stage:'cwc',vaccines:{dose}});
 const doses=mch.recordedDoses([cwc('c1',{vaccine:'BCG',dose:'1'}),cwc('c2',[{vaccine:' bcg ',dose:'1'},{vaccine:'OPV',dose:'0'}])]);
 assert.deepEqual(doses.map(d=>d.duplicate),[false,true,false]);
});
test('mch schedules: every absent Flutter rule stays inactive and pending clinical review',()=>{
 assert.equal(s.INACTIVE.length,7);
 for(const rule of s.INACTIVE){assert.equal(rule.active,false);assert.equal(rule.approval_status,'pending_clinical_review');assert.equal(rule.release_authorized,false);}
 assert.equal(s.followUpDue('2026-10-21',TODAY),true);assert.equal(s.followUpDue('2026-10-22',TODAY),false);assert.equal(s.followUpDue('2026-02-30',TODAY),false);
});
test('mch authority: forms per role, referral state per role, and the role table matches lib/mch.js',()=>{
 const source=fs.readFileSync(path.join(__dirname,'..','authority','validate_doc_update.js'),'utf8');
 const validate=vm.runInNewContext('('+source.slice(source.indexOf('function('))+')');
 const run=(form,role,fields={})=>validate({_id:'x',type:'data_record',form,fields},null,{name:'u',roles:[role]},{admins:{}});
 const forbidden=fn=>assert.throws(fn,e=>typeof e.forbidden==='string');
 for(const form of [F.pregnancy,F.delivery,F.anc,F.pnc,F.cwc,F.appointment,F.resolution]){
  // Resolutions and appointment events name their author (the signed-in user), so completions can be verified.
  const signed=[F.appointment,F.resolution].includes(form)?{actor:'u'}:{};
  run(form,'carelink_cho',signed);
  for(const role of ['carelink_community','carelink_coordinator','carelink_supervisor']){forbidden(()=>run(form,role,signed));}
 }
 for(const form of [F.appointment,F.resolution]){
  forbidden(()=>run(form,'carelink_cho'));
  forbidden(()=>run(form,'carelink_cho',{actor:'someone-else'}));
 }
 forbidden(()=>run('carelink_oi_followup_link','carelink_cho'));
 run('carelink_oi_followup_link','carelink_oi_service');
 for(const [state,roles] of Object.entries(mch.REFERRAL_ROLES)){
  for(const role of ['carelink_community','carelink_cho','carelink_coordinator','carelink_supervisor']){
   if(roles.includes(role)){run(F.referral,role,{state,actor:'u'});}else{forbidden(()=>run(F.referral,role,{state,actor:'u'}));}
  }
 }
 forbidden(()=>run(F.referral,'carelink_cho',{state:'queued_offline',actor:'u'}));
 // Every referral event names its author, so an acknowledgement shows who acknowledged.
 forbidden(()=>run(F.referral,'carelink_coordinator',{state:'acknowledged'}));
 forbidden(()=>run(F.referral,'carelink_coordinator',{state:'acknowledged',actor:'someone-else'}));
 forbidden(()=>run(F.referral,'carelink_community',{state:'acknowledged',actor:'u'}));
 run('carelink_resource_status','carelink_coordinator',{actor:'u'});
 forbidden(()=>run('carelink_resource_status','carelink_cho',{actor:'u'}));
 forbidden(()=>run('carelink_resource_status','carelink_coordinator'));
});
