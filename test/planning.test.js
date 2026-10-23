'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {generate}=require('../lib/demo-data');
const {assess,WEIGHTS}=require('../lib/need-score');
const {plan,weekday}=require('../lib/scheduler');
const mch=require('../lib/mch');
const {isoDay}=require('../lib/schedules');
const RESOURCES=require('./fixtures/planning-resources.json');
const NOW=Date.parse('2026-10-21T09:00:00Z');
const TODAY=isoDay(NOW);
const docs=generate(NOW).docs;
const assessment=assess(docs,TODAY);
const clone=o=>JSON.parse(JSON.stringify(o));
const minutes=hhmm=>{const [h,m]=hhmm.split(':').map(Number);return h*60+m;};

test('need score: every point traces to a record or to the coverage floor, and totals add up',()=>{
 for(const h of assessment.households){
  assert.equal(h.score,h.items.reduce((s,i)=>s+i.points,0));
  for(const i of h.items){assert.ok(i.record,`${h.id} ${i.kind} has no record`);assert.ok(docs.some(d=>d._id===i.record)||i.kind!=='open_request');}
 }
 for(const c of assessment.communities){
  const members=assessment.households.filter(h=>h.community===c.id);
  assert.equal(c.score,members.reduce((s,h)=>s+h.score,0)+c.coverage_points);
 }
});
test('need score: maternal and child items are exactly the CHT task projection; closed requests add nothing',()=>{
 const people=docs.filter(d=>d.type==='contact'&&mch.isMch(d));
 assert.ok(people.length);
 for(const p of people){
  const own=docs.filter(d=>d.fields&&d.fields.patient_id===p._id);
  const expected=mch.projectTasks(p,own,TODAY).map(t=>t.kind).sort();
  const scored=assessment.households.flatMap(h=>h.items).filter(i=>i.person===p._id).map(i=>i.kind).sort();
  assert.deepEqual(scored,expected);
 }
 const completed=['carelink-demo-household-1','carelink-demo-household-2','carelink-demo-household-5'];
 for(const id of completed){assert.ok(!assessment.households.find(h=>h.id===id).items.some(i=>i.kind==='open_request'||i.kind==='barrier'),id);}
});
test('need score: quiet communities are never read as "no need" (coverage floor)',()=>{
 const river=assessment.communities.find(c=>c.id==='carelink-demo-community-3');
 assert.equal(river.last_visit,null);assert.equal(river.coverage_points,WEIGHTS.coverage_cap);
 const baobab=assessment.communities.find(c=>c.id==='carelink-demo-community-1');
 assert.equal(baobab.coverage_points,0,'visited today');
 const later=assess(docs,'2026-11-24');
 assert.equal(later.communities.find(c=>c.id==='carelink-demo-community-1').coverage_points,Math.min(WEIGHTS.coverage_cap,34-WEIGHTS.coverage_grace_days));
});

const scenarios={
 'dry, demo resources':[RESOURCES,'dry'],
 'rainy, demo resources':[RESOURCES,'rainy'],
 'rainy, 5-hour day':[{...clone(RESOURCES),working_hours:{start:'08:00',end:'13:00'}},'rainy'],
 'two vehicles, 2 households a day':[{...clone(RESOURCES),max_households_per_worker_per_day:2,vehicles:[...RESOURCES.vehicles,{id:'motorbike-2',available:['mon','wed']}]},'dry'],
 'no vehicles on Tuesday or Thursday':[{...clone(RESOURCES),vehicles:[{id:'motorbike-1',available:['mon','wed','fri']}]},'dry'],
};
for(const [name,[resources,season]] of Object.entries(scenarios)){
 test(`scheduler hard constraints hold: ${name}`,()=>{
  const p=plan(assessment,resources,{start:'2026-10-22',season});
  const budget=minutes(resources.working_hours.end)-minutes(resources.working_hours.start);
  const targets=assessment.households.filter(h=>h.score>0);
  for(const v of p.visits){
   const staff=resources.staff.find(s=>s.id===v.worker);
   assert.ok(staff.available.includes(weekday(v.date)),`${v.worker} on ${v.date}`);
   assert.ok(resources.vehicles.find(x=>x.id===v.vehicle).available.includes(weekday(v.date)));
   assert.ok(v.total_minutes<=budget,`${v.total_minutes} > ${budget}`);
   assert.ok(v.households<=resources.max_households_per_worker_per_day);
   for(const s of v.stops){for(const t of s.targets){const h=targets.find(x=>x.id===t.id);if(h){assert.equal(h.worker,v.worker,'responsible worker only');}}}
  }
  const byDayVehicle=p.visits.map(v=>v.date+'|'+v.vehicle);
  assert.equal(new Set(byDayVehicle).size,byDayVehicle.length,'one worker per vehicle per day');
  const ids=p.visits.flatMap(v=>v.stops.flatMap(s=>s.targets.map(t=>t.id)));
  assert.equal(new Set(ids).size,ids.length,'no target scheduled twice');
  assert.equal(ids.length+p.unmet.length,p.totals.targets,'every target is scheduled or reported unmet');
  for(const u of p.unmet){assert.ok(u.why.length&&u.why.every(Boolean),`${u.id} has no reason`);}
  assert.deepEqual(plan(assessment,resources,{start:'2026-10-22',season}),p,'deterministic');
 });
}
test('scheduler: the highest need goes first, and infeasible trips are reported as unmet with the reason',()=>{
 const p=plan(assessment,RESOURCES,{start:'2026-10-22',season:'dry'});
 const first=p.visits[0].stops[0].targets[0];
 assert.equal(first.score,Math.max(...assessment.households.map(h=>h.score)));
 const short=plan(assessment,{...clone(RESOURCES),working_hours:{start:'08:00',end:'12:00'}},{start:'2026-10-22',season:'rainy'});
 const river=short.unmet.filter(u=>u.community_name&&u.community_name.includes('River Plain'));
 assert.ok(river.length,'River Plain cannot be reached in a 4-hour rainy-season day');
 for(const u of river){assert.ok(u.why.some(r=>/Round trip to .*River Plain.* leaves no time/.test(r)),u.why.join(' | '));}
});
