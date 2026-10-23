'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {connection}=require('./client');
const w=require('../lib/workflow');
(async()=>{
 const couch=connection('CHT_COUCH_URL');const api=connection();
 const docs=(await couch('/medic/_all_docs?include_docs=true')).rows.map(r=>r.doc);
 const requests=docs.filter(d=>d.form===w.FORMS.request&&d.fields.demo==='true');
 const states=requests.map(r=>w.workflow(r,docs));
 const result={timestamp:new Date().toISOString(),health:await api('/setup/poll'),counts:{
  communities:docs.filter(d=>d.contact_type==='carelink_community'&&d.demo).length,
  households:docs.filter(d=>d.contact_type==='carelink_household'&&d.demo).length,
  requests_delivered_to_this_server:requests.length,
  awaiting_review:states.filter(s=>s.state==='awaiting_assignment').length,
  requests_ever_assigned:requests.filter(r=>docs.some(d=>d.form===w.FORMS.coordination&&d.fields.request_id===r._id&&d.fields.status==='assigned')).length,
  active_assignments:states.filter(s=>['assigned','scheduled','in_progress'].includes(s.state)).length,
  completed_visits:states.filter(s=>s.state==='completed').length,
  unresolved_requests:states.filter(s=>!w.TERMINAL.includes(s.state)).length,
  reported_transport_barriers:requests.filter(r=>['transport_unavailable','transport_cost'].includes(r.fields.access_barrier)).length,
  conflicts:states.filter(s=>s.conflict).length,
 },note:'Server snapshot, fictional records. Device targets are scoped and may include pending local records. No clinical outcomes inferred.'};
 fs.writeFileSync(path.join(__dirname,'../evidence/server-verification.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
