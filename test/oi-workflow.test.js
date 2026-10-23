'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const oi=require('../lib/oi-workflow');
const proposal={_id:'p',form:oi.FORMS.proposal,fields:{requested_by:'coord',requested_by_contact:'c-coord'}};
const event=(id,action,actor,expected)=>({_id:id,form:oi.FORMS.review,reported_date:1,fields:{proposal_id:'p',action,actor,expected_event:expected}});
const ack=(e,state)=>({_id:'ack-'+e._id,form:oi.FORMS.ack,reported_date:1,fields:{proposal_id:'p',event_id:e._id,previous_event:e.fields.expected_event,action:e.fields.action,actor:e.fields.actor,actor_contact:'c-sup',result:'accepted',state_after:state}});

test('OI: offline decisions do not become approved without server acknowledgements',()=>{
 const e=event('approve','approve','sup','review');
 const s=oi.proposalStatus(proposal,[e]);
 assert.equal(s.approvedOnServer,false);assert.equal(s.pending.length,1);
});
test('OI: server state follows predecessor links rather than tied timestamps or ID sort order',()=>{
 const submit=event('z-submit','submit','coord','p'),review=event('a-review','review','sup','z-submit'),approve=event('0-approve','approve','sup','a-review');
 const records=[approve,review,submit,ack(approve,'approved'),ack(submit,'proposed'),ack(review,'reviewed')];
 const s=oi.proposalStatus(proposal,records);
 assert.equal(s.approvedOnServer,true);assert.equal(s.lastEvent,'0-approve');assert.equal(s.pending.length,0);
});
test('OI: only supervisors are offered another author’s review and decision steps',()=>{
 const s={state:'proposed',pending:[],requestedByContact:'c-coord'};
 assert.equal(oi.nextActionFor(s,'c-other','carelink_coordinator'),null);
 assert.equal(oi.nextActionFor(s,'c-coord','carelink_supervisor'),null);
 assert.equal(oi.nextActionFor(s,'c-sup','carelink_supervisor'),'review');
 const settings=require('../app_settings/base_settings.json');
 for(const permission of ['can_edit','can_view_tasks','can_carelink_oi'])assert.ok(settings.permissions[permission].includes('carelink_supervisor'));
});
test('OI extension refreshes newly replicated records without another navigation and releases its listeners',async()=>{
 class Element{constructor(){this.children=[];}append(v){this.children.push(v);}setAttribute(){}addEventListener(){}attachShadow(){return this;}}
 const listeners=new Set();let tick,cleared=false;
 const sandbox={module:{exports:{}},oiWorkflow:oi,oiLinks:require('../lib/oi-links'),oiMch:require('../lib/mch'),oiRequests:require('../lib/workflow'),HTMLElement:Element,Node:Element,navigator:{onLine:true},
  document:{createElement:()=>new Element()},window:{addEventListener:(n)=>listeners.add(n),removeEventListener:(n)=>listeners.delete(n)},
  setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{cleared=true;}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../ui-extensions-src/carelink-outreach-intelligence.js'),'utf8'),sandbox);
 const Extension=sandbox.module.exports,e=new Extension();let docs=[];
 e.cht={v1:{report:{getUuidsByForms:async function*(){for(const d of docs)yield d._id;},getByIds:async function*(){yield* docs;}}}};
 e.show=()=>{e.renders=(e.renders||0)+1;};e.needsSection=e.resourcesSection=e.planSection=e.progressSection=()=>null;
 e.connectedCallback();await new Promise(setImmediate);
 const before=e.renders;
 docs=[{...proposal,_rev:'1-a',reported_date:10,fields:{...proposal.fields,planning_date:'2026-10-22',request_id:'r'}}];
 await tick();assert.equal(e.renders,before+1);assert.equal(e.selected,'p');
 await tick(); // selection also enters the change signature
 const settled=e.renders;await tick();assert.equal(e.renders,settled,'unchanged data should not reset scroll');
 e.disconnectedCallback();assert.equal(cleared,true);assert.equal(listeners.size,0);
});

test('OI: invalid input or infeasible proposals cannot offer submit/review/approval actions',()=>{
 for(const status of ['INVALID_INPUT','INFEASIBLE','UNKNOWN']){
  const s=oi.proposalStatus({...proposal,fields:{...proposal.fields,schedule:{status}}},[]);
  assert.equal(oi.nextActionFor(s,'c-coord','carelink_coordinator'),null);
 }
});
test('the built OI extension bundle loads every lib module it requires',()=>{
 const {execFileSync}=require('node:child_process');
 execFileSync(process.execPath,[path.join(__dirname,'..','scripts','build-oi-extension.js')]);
 const bundle=fs.readFileSync(path.join(__dirname,'..','ui-extensions','carelink-outreach-intelligence.js'),'utf8');
 class Element{}
 const sandbox={module:{exports:{}},HTMLElement:Element,console};
 vm.runInNewContext(bundle,sandbox);
 assert.equal(typeof sandbox.module.exports,'function');
});
