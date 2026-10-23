'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','authority','validate_doc_update.js'),'utf8');
const validate=vm.runInNewContext('('+source.slice(source.indexOf('function('))+')');
const sec={admins:{names:[],roles:[]},members:{}};
const user=role=>({name:'u',roles:[role]});
const report=(form,extra={})=>({_id:'r1',type:'data_record',form,fields:{},...extra});
const run=(newDoc,oldDoc,ctx)=>validate(newDoc,oldDoc||null,ctx,sec);
const forbidden=fn=>assert.throws(fn,e=>typeof e.forbidden==='string');

test('authority: each CareLink form is accepted only from its authorised roles',()=>{
 run(report('carelink_request'),null,user('carelink_community'));
 run(report('carelink_request'),null,user('carelink_cho'));
 run(report('carelink_coordination'),null,user('carelink_coordinator'));
 run(report('carelink_visit',{fields:{actor:'u'}}),null,user('carelink_cho'));
 forbidden(()=>run(report('carelink_visit'),null,user('carelink_cho')));
 forbidden(()=>run(report('carelink_visit',{fields:{actor:'someone-else'}}),null,user('carelink_cho')));
 run(report('carelink_referral'),null,user('carelink_coordinator'));
 forbidden(()=>run(report('carelink_coordination'),null,user('carelink_community')));
 forbidden(()=>run(report('carelink_coordination'),null,user('carelink_cho')));
 forbidden(()=>run(report('carelink_visit'),null,user('carelink_coordinator')));
 forbidden(()=>run(report('carelink_visit'),null,user('carelink_supervisor')));
 forbidden(()=>run(report('carelink_referral'),null,user('carelink_community')));
 forbidden(()=>run(report('carelink_request'),null,user('carelink_supervisor')));
});
test('authority: coordination events are append-only and CareLink records cannot be deleted or re-typed',()=>{
 const old={...report('carelink_coordination'),_rev:'1-a'};
 forbidden(()=>run({...old,fields:{status:'completed'}},old,user('carelink_coordinator')));
 forbidden(()=>run({_id:'r1',_rev:'1-a',_deleted:true},old,user('carelink_coordinator')));
 const request={...report('carelink_request'),_rev:'1-a'};
 run({...request,fields:{access_barrier:'distance'}},request,user('carelink_community'));
 forbidden(()=>run({...request,form:'carelink_visit'},request,user('carelink_cho')));
 forbidden(()=>run({...request,form:'other_form'},request,user('carelink_community')));
});
test('authority: admins, non-CareLink documents and other forms are unaffected',()=>{
 run(report('carelink_coordination'),null,{name:'admin',roles:['_admin']});
 run({_id:'c',type:'contact',contact_type:'carelink_household'},null,user('carelink_community'));
 run(report('pregnancy_home_visit'),null,user('carelink_community'));
});

test('authority: plan authors are authenticated, only supervisors decide, service records cannot be forged',()=>{
 const oi=(form,fields)=>report(form,{fields});
 const coordinator={name:'coord',roles:['carelink_coordinator']};
 const supervisor={name:'sup',roles:['carelink_supervisor']};
 run(oi('carelink_oi_review',{actor:'coord',action:'submit'}),null,coordinator);
 for(const action of ['review','approve','reject']){
  forbidden(()=>run(oi('carelink_oi_review',{actor:'coord',action}),null,coordinator));
  run(oi('carelink_oi_review',{actor:'sup',action}),null,supervisor);
 }
 forbidden(()=>run(oi('carelink_oi_review',{actor:'other',action:'approve'}),null,supervisor));
 forbidden(()=>run(oi('carelink_oi_ack',{actor:'sup',result:'accepted'}),null,supervisor));
 forbidden(()=>run(report('carelink_request'),null,{name:'service',roles:['carelink_oi_service']}));
});
test('authority: community volunteers add and edit households only, and record contact outcomes append-only',()=>{
 const volunteer=user('carelink_community');
 const home={_id:'h1',type:'contact',contact_type:'carelink_household',name:'Household'};
 run(home,null,volunteer);
 run({...home,name:'Renamed'},{...home,_rev:'1-a'},volunteer);
 forbidden(()=>run({...home,_deleted:true},{...home,_rev:'1-a'},volunteer));
 for(const type of ['carelink_individual','carelink_community','carelink_facility']){
  forbidden(()=>run({_id:'x',type:'contact',contact_type:type},null,volunteer));
 }
 forbidden(()=>run({...home,contact_type:'carelink_community'},{...home,_rev:'1-a'},volunteer));
 forbidden(()=>run({_id:'t',type:'contact',contact_type:'carelink_household'},{_id:'t',type:'contact',contact_type:'carelink_community',_rev:'1-a'},volunteer));
 run({_id:'p',type:'contact',contact_type:'carelink_individual'},null,user('carelink_cho'));
 run(report('carelink_household_contact'),null,volunteer);
 forbidden(()=>run(report('carelink_household_contact'),null,user('carelink_cho')));
 const note={...report('carelink_household_contact'),_rev:'1-a'};
 forbidden(()=>run({...note,fields:{outcome:'moved'}},note,volunteer));
});
