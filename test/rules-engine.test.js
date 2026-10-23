'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {generate}=require('../lib/demo-data');
const emitter=require('@medic/rules-engine/src/rules-emitter');
const settings=require('../app_settings.json');
const data=generate();
async function emissions(role,id,docs=data.docs){
 emitter.shutdown();
 assert.equal(emitter.initialize({rules:settings.tasks.rules,contact:{_id:id,carelink_role:role},rulesAreDeclarative:true}),true);
 return emitter.getEmissionsFor(docs.filter(d=>d.type==='contact'),docs.filter(d=>d.type==='data_record'));
}
test('actual CHT declarative engine emits exactly the two pending visits for CHO B',async()=>{
 const result=await emissions('carelink_cho','carelink-demo-cho-2');
 const tasks=result.tasks.filter(t=>!t.resolved);
 assert.equal(tasks.length,2);assert.ok(tasks.every(t=>t.actions[0].form==='carelink_visit'));
 assert.ok(tasks.every(t=>t.actions[0].content.expected_event.endsWith('-scheduled')));
});
test('actual CHT engine emits no CHO B assignments to CHO A or the community contact',async()=>{
 assert.equal((await emissions('carelink_cho','carelink-demo-cho-1')).tasks.filter(t=>!t.resolved&&t.actions[0].form==='carelink_visit').length,0);
 assert.equal((await emissions('carelink_community','carelink-demo-contact-1')).tasks.length,0);
});
test('coordinator tasks include unresolved requests and resolve documented completed visits',async()=>{
 const result=await emissions('carelink_coordinator','carelink-demo-coordinator');
 assert.equal(result.tasks.filter(t=>!t.resolved).length,5);
});
test('compiled targets count valid underlying records, not assignment transmissions as visits',async()=>{
 const result=await emissions('carelink_supervisor','carelink-demo-supervisor');
 const count=id=>result.targets.filter(t=>t.type==='carelink-'+id&&!t.deleted).length;
 assert.equal(count('communities'),3);assert.equal(count('requests'),8);assert.equal(count('awaiting'),3);assert.equal(count('completed'),3);assert.equal(count('assigned'),2);assert.equal(count('transport'),2);
});
