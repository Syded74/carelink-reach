'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const targets=require('../targets');
const mch=require('../lib/mch');
const t=id=>targets.find(x=>x.id==='carelink-'+id);
const today=new Date().toISOString().slice(0,10);
const report=(id,form,patient,fields)=>({_id:id,type:'data_record',form,reported_date:Date.now(),fields:{patient_id:patient,...fields}});

test('targets: obligations, people and planned encounters are different units; test data never counts',()=>{
 const mother={_id:'m',type:'contact',contact_type:'carelink_individual',care_stage:'anc',responsible_worker_id:'cho'};
 // A recorded follow-up due today and a missing assessment on the same visit: two obligations, one person.
 const reports=[report('anc',mch.FORMS.anc,'m',{follow_up_date:today,missing_vitals:'fundal_height_cm',danger_signs:'bleeding_reported'})];
 const c={contact:mother,reports};
 assert.ok(t('open-obligations').appliesIf(c));
 assert.deepEqual(t('open-obligations').idType(c).sort(),['m:missingAssessment:anc','m:scheduledFollowUp:anc'],'the danger sign is urgent, never routine');
 assert.ok(t('people-awaiting').appliesIf(c));
 assert.ok(!t('open-obligations').appliesIf({contact:{...mother,record_origin:'test'},reports}));
 // Staff person records (the CHO, volunteer, coordinator) are individuals without a care stage: never patients.
 const staff={contact:{_id:'carelink-person-sabukari',type:'contact',contact_type:'carelink_individual'},reports:[]};
 assert.ok(!t('open-obligations').appliesIf(staff),'a staff record has no routine obligation');
 assert.ok(!t('people-awaiting').appliesIf(staff),'a staff record is not a person awaiting follow-up');
 const plan=report('dp','carelink_oi_day_plan','c1',{request_ids:['r1'],followups:[{task_id:'m:a:1',person_id:'m'},{task_id:'m:b:1',person_id:'m'}]});
 const community={contact:{_id:'c1',contact_type:'carelink_community'},reports:[plan]};
 assert.ok(t('planned-encounters').appliesIf(community,plan));
 assert.deepEqual(t('planned-encounters').idType(community,plan),['dp:r1','dp:m'],'one encounter per request and per person');
 const testPlan={...plan,fields:{...plan.fields,includes_test_records:true}};
 assert.ok(!t('planned-encounters').appliesIf(community,testPlan));
});

test('targets: plans awaiting supervisor decision follow server acknowledgements only',()=>{
 const proposal=report('p','carelink_oi_proposal','f',{requested_by:'rseidu',schedule:{status:'OPTIMAL'}});
 const facility={contact:{_id:'f',contact_type:'carelink_facility'},reports:[proposal]};
 assert.ok(!t('plans-awaiting-review').appliesIf(facility,proposal),'a draft is not awaiting the supervisor');
 const submit=report('s','carelink_oi_review','f',{proposal_id:'p',action:'submit',actor:'rseidu',expected_event:'p'});
 const ack=report('a','carelink_oi_ack','f',{proposal_id:'p',event_id:'s',action:'submit',result:'accepted',state_before:'draft',state_after:'proposed',previous_event:'p',actor:'rseidu'});
 facility.reports.push(submit);
 assert.ok(!t('plans-awaiting-review').appliesIf(facility,proposal),'an unacknowledged submission does not count');
 facility.reports.push(ack);
 assert.ok(t('plans-awaiting-review').appliesIf(facility,proposal));
});

test('targets: referral counts follow the chain once; readiness needing confirmation is unknown or older than 7 days',()=>{
 const created=report('ref1',mch.FORMS.referral,'m',{referral_id:'R1',state:'created',reason:'x',receiving_facility_id:'f',actor:'sabukari'});
 const ack=report('ref2',mch.FORMS.referral,'m',{referral_id:'R1',state:'acknowledged',expected_event:'ref1',actor:'rseidu'});
 const c={contact:{_id:'m',contact_type:'carelink_individual',care_stage:'anc'},reports:[created]};
 assert.ok(t('referrals-created').appliesIf(c,created) && t('referrals-awaiting-ack').appliesIf(c,created));
 assert.ok(!t('referrals-created').appliesIf({...c,reports:[created,ack]},ack),'only the root counts');
 const acked={...c,reports:[created,ack,{...ack}]};
 assert.ok(t('referrals-acknowledged').appliesIf(acked,created) && !t('referrals-awaiting-ack').appliesIf(acked,created));
 const dup=report('ref3',mch.FORMS.referral,'m',{referral_id:'R1',state:'acknowledged',expected_event:'ref1',actor:'rseidu'});
 assert.ok(!t('referrals-acknowledged').appliesIf({...c,reports:[created,ack,dup]},created),'two acknowledgements of one step are a conflict, not two counts');
 const fac={contact:{_id:'f',contact_type:'carelink_facility'},reports:[
  report('s1','carelink_resource_status','f',{resource_id:'fuel',status:'confirmed',quantity:5,verified_date:new Date(Date.now()-10*864e5).toISOString().slice(0,10)}),
  report('s2','carelink_resource_status','f',{resource_id:'cwc',status:'unknown',verified_date:today}),
  report('s3','carelink_resource_status','f',{resource_id:'anc',status:'confirmed',quantity:3,verified_date:today})]};
 assert.deepEqual(t('resources-need-confirmation').idType(fac).sort(),['f:cwc','f:fuel']);
});
