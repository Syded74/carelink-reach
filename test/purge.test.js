'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fn}=require('../purge');

const reports=['carelink_oi_assignment','carelink_oi_day_plan','carelink_oi_outreach_day','carelink_oi_followup_link','carelink_oi_request_link','carelink_request','carelink_anc_visit']
 .map(form=>({_id:form,form}));
const real={_id:'h',contact_type:'carelink_household',reported_date:0};

test('purge: volunteers do not receive service-only planning records; staff keep everything',()=>{
 assert.deepEqual(fn({roles:['carelink_community']},real,reports),['carelink_oi_assignment','carelink_oi_day_plan','carelink_oi_outreach_day','carelink_oi_followup_link']);
 for(const role of ['carelink_cho','carelink_coordinator','carelink_supervisor']){assert.deepEqual(fn({roles:[role]},real,reports),[]);}
});
test('purge: reports about a test contact leave every phone a day after the run, never sooner; real records stay',()=>{
 const old={...real,record_origin:'test',reported_date:Date.now()-2*864e5};
 const fresh={...real,record_origin:'test',reported_date:Date.now()};
 assert.equal(fn({roles:['carelink_cho']},old,reports).length,reports.length);
 assert.deepEqual(fn({roles:['carelink_cho']},fresh,reports),[]);
 assert.deepEqual(fn({roles:['carelink_cho']},{...real,reported_date:0},reports),[]);
});
