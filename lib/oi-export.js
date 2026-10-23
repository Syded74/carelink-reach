'use strict';
/*
  Community-level export for the Outreach Intelligence service (outreach-intelligence/). Only
  counts per community and week leave CHT: no person, name, phone, note or clinical value. Record
  ids that back each count go to a separate provenance object, kept privately and never given to
  the engines. Counts reuse lib/need-score.js, lib/workflow.js and lib/mch.js, so they match the
  tasks and targets CHT shows.
*/
const { withoutTestRecords } = require('./test-records');
const w = require('./workflow');
const mch = require('./mch');
const { assess } = require('./need-score');
const mchOutreach = require('./mch-outreach');
const { dayProgress } = require('./oi-links');
const { isoDay } = require('./schedules');

const TRANSPORT = ['distance', 'transport_unavailable', 'transport_cost'];
// Danger signs and referral follow-ups go through their own pathways, never routine planning (lib/mch-outreach.js).
const ROUTINE_MCH = mchOutreach.OUTREACH_KINDS;

const monday = day => {
  const d = new Date(day + 'T00:00:00Z');
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
};

// Scope routine input records before aggregation. UI scopes alone cannot protect the
// server-side engine from accidentally mixing facilities in a larger deployment.
function scopeToFacility(docs, facility) {
  if (!facility) { return docs; }
  const contacts = new Map(docs.filter(d => d && d.type === 'contact').map(d => [d._id, d]));
  const belongs = id => {
    const seen = new Set();
    while (id && !seen.has(id)) {
      if (id === facility) { return true; }
      seen.add(id);
      const c = contacts.get(id);
      id = c && c.parent && c.parent._id;
    }
    return false;
  };
  return docs.filter(d => d && (d.type === 'contact' ? belongs(d._id) :
    d.type === 'data_record' ? belongs(d.fields && (d.fields.patient_id || d.fields.place_id)) : true));
}

// includeTestRecords is only for regression tests that follow their own records through the pipeline;
// operational exports always leave records created by tests out (lib/test-records.js).
function exportAggregates(docs, today = isoDay(), exportedAt = new Date().toISOString(), { includeTestRecords = false } = {}) {
  const kept = docs.filter(d => d && !d._deleted);
  const live = includeTestRecords ? kept : withoutTestRecords(kept);
  const contacts = new Map(live.filter(d => d.type === 'contact').map(d => [d._id, d]));
  const communityOf = id => {
    let c = contacts.get(id);
    for (let i = 0; c && i < 4; i++) {
      if (c.contact_type === 'carelink_community') { return c._id; }
      c = c.parent && contacts.get(c.parent._id);
    }
    return null;
  };
  const assessment = assess(live, today);
  const communities = assessment.communities;
  const history = new Map();
  const provenance = {};
  const note = (community, feature, id) => {
    provenance[community] = provenance[community] || {};
    (provenance[community][feature] = provenance[community][feature] || []).push(id);
  };
  const row = (community, week) => {
    const key = `${community}|${week}`;
    if (!history.has(key)) {
      history.set(key, { community_id: community, period_start: week, reported: true, requests_created: 0, followups_due: 0,
        missed_appointments: 0, referrals_open: 0, visits_completed: 0, transport_barriers: 0, followups_resolved: 0 });
    }
    return history.get(key);
  };
  const seen = new Set();
  const resolvedTasks = new Set();
  live.filter(d => d.type === 'data_record' && d.fields).sort((a, b) => (a.reported_date || 0) - (b.reported_date || 0)).forEach(r => {
    if (seen.has(r._id)) { return; }
    seen.add(r._id);
    const community = communityOf(r.fields.patient_id);
    if (!community) { return; }
    const week = monday(isoDay(r.reported_date));
    if (r.form === w.FORMS.request) {
      row(community, week).requests_created++; note(community, 'requests_created', r._id);
      if (TRANSPORT.includes(r.fields.access_barrier)) { row(community, week).transport_barriers++; note(community, 'transport_barriers', r._id); }
    } else if (r.form === mch.FORMS.appointment && r.fields.state === 'missed') {
      row(community, week).missed_appointments++; note(community, 'missed_appointments', r._id);
    } else if ((r.form === w.FORMS.visit && r.fields.status === 'completed') || mch.VISIT_FORMS.includes(r.form)) {
      row(community, week).visits_completed++; note(community, 'visits_completed', r._id);
    } else if (r.form === mch.FORMS.resolution && r.fields.reason && mchOutreach.OUTREACH_KINDS.includes(r.fields.task_kind)) {
      // A routine maternal/child follow-up closed by its own recorded resolution (one per task id).
      if (!resolvedTasks.has(r.fields.task_id)) {
        resolvedTasks.add(r.fields.task_id);
        row(community, week).followups_resolved++; note(community, 'followups_resolved', r._id);
      }
    }
  });
  // Snapshot-only measures belong to the current week.
  const current = [];
  const thisWeek = monday(today);
  const workload = mchOutreach.communityWorkload(live, today);
  // Unserved planned work: items approved outreach days took on that have passed (or were recorded)
  // and were not completed. Test plans count only in an explicitly test-inclusive export.
  const reportsLive = live.filter(d => d.type === 'data_record' && d.fields);
  const recordedDays = new Set(reportsLive.filter(r => r.form === 'carelink_oi_outreach_day').map(r => r.fields.assignment_id));
  const unservedPlanned = new Map();
  reportsLive.filter(r => r.form === 'carelink_oi_day_plan' && (includeTestRecords || !r.fields.includes_test_records) &&
    (r.fields.date < today || recordedDays.has(r.fields.assignment_id))).forEach(plan => {
    const { counts, followups } = dayProgress(plan, reportsLive);
    const left = (counts.planned - counts.completed) + (followups.planned - followups.completed - followups.closed);
    unservedPlanned.set(plan.fields.patient_id, (unservedPlanned.get(plan.fields.patient_id) || 0) + Math.max(0, left));
  });
  const fourWeeksAgo = isoDay(Date.parse(today + 'T00:00:00Z') - 28 * 86400000);
  communities.forEach(c => {
    const items = assessment.households.filter(h => h.community === c.id).flatMap(h => h.items);
    const routine = items.filter(i => i.kind === 'open_request' || ROUTINE_MCH.includes(i.kind));
    const due = items.filter(i => ['scheduledFollowUp', 'appointmentDue'].includes(i.kind));
    const referrals = items.filter(i => i.kind === 'referralFollowUp');
    const r = row(c.id, thisWeek);
    r.followups_due = due.length; r.referrals_open = referrals.length;
    due.forEach(i => note(c.id, 'followups_due', i.record));
    referrals.forEach(i => note(c.id, 'referrals_open', i.record));
    routine.forEach(i => note(c.id, 'open_items', i.record));
    // Documented routine workload in encounters (lib/mch-outreach.js): requests plus maternal and child
    // follow-ups, one per person or household request, so nothing is counted twice.
    const load = workload.get(c.id) || {};
    current.push({ community_id: c.id, as_of: today, pending_followups: load.encounters || 0, urgent_items_excluded: load.urgent_items_excluded || 0,
      last_visit: c.last_visit, days_since_outreach: c.days_since_visit === null ? -1 : c.days_since_visit,
      unserved_planned: unservedPlanned.get(c.id) || 0,
      visits_completed_4w: [...history.values()].filter(r => r.community_id === c.id && r.period_start >= monday(fourWeeksAgo)).reduce((n, r) => n + r.visits_completed, 0),
      open_requests: load.open_requests || 0, open_maternal_followups: load.open_maternal_followups || 0,
      open_child_followups: load.open_child_followups || 0, unique_people: load.unique_people || 0, unique_households: load.unique_households || 0,
      encounters_request: load.encounters_request || 0, encounters_anc: load.encounters_anc || 0, encounters_pnc: load.encounters_pnc || 0, encounters_cwc: load.encounters_cwc || 0 });
  });
  const barrierLevel = id => {
    const rows = [...history.values()].filter(r => r.community_id === id);
    if (rows.some(r => r.transport_barriers > 0)) { return 'high'; }
    return rows.some(r => r.requests_created > 0) ? 'low' : 'unknown';
  };
  const dataset = {
    dataset_id: includeTestRecords ? 'live-cht+test-records' : 'live-cht', label: includeTestRecords ? 'Live CHT records including test records' : 'Live CHT records',
    synthetic: false, includes_test_records: includeTestRecords, exported_at: exportedAt,
    source: 'CHT 5.3 server records via lib/oi-export.js', period: 'week', as_of: today,
    communities: communities.map(c => ({ id: c.id, name: c.name, barrier_level: barrierLevel(c.id), responsible_worker: c.worker })),
    history: [...history.values()].sort((a, b) => a.community_id.localeCompare(b.community_id) || a.period_start.localeCompare(b.period_start)),
    current,
    confirmed_assignments: confirmedAssignments(live, communityOf, includeTestRecords),
    notes: ['Only records that reached the server are counted.',
      'Danger-sign reviews and referral follow-ups are excluded from routine workload (urgent_items_excluded) and follow referral procedures.'],
  };
  return { dataset, provenance: { dataset_id: dataset.dataset_id, exported_at: exportedAt, records: provenance } };
}

// Outreach already confirmed in CHT is a fixed input for the optimiser, never silently replaced:
// scheduled coordination events and assignments from server-approved plans (staff and place ids only).
function confirmedAssignments(live, communityOf, includeTestRecords = false) {
  const out = [];
  const bySlot = new Map();
  const add = (worker, day, community, source, count = 1) => {
    if (!worker || !day || !community) { return; }
    const key = `${worker}|${day}|${community}`;
    const existing = bySlot.get(key);
    if (existing) {
      // An approved community plan can cover already-scheduled household visits.
      // Preserve its full capacity without double-counting the same routine work.
      existing.min_followups = source === 'coordination' && existing.source === 'coordination' ? existing.min_followups + count : Math.max(existing.min_followups, count);
    } else {
      const item = { worker, day, community, min_followups: count, source };
      bySlot.set(key, item);out.push(item);
    }
  };
  const reports = live.filter(d => d.type === 'data_record' && d.fields);
  // A recorded outreach day is over: it is no longer a commitment, and the requests it scheduled are released.
  const recorded = new Set(reports.filter(r => r.form === 'carelink_oi_outreach_day').map(r => r.fields.assignment_id));
  const testPlans = new Set(reports.filter(r => r.form === 'carelink_oi_proposal' && r.fields.includes_test_records).map(r => r._id));
  w.requests({ reports }).forEach(request => {
    const own = reports.filter(r => r.fields.patient_id === request.fields.patient_id);
    const state = w.workflow(request, own);
    const released = state.last.form === w.FORMS.planLink && recorded.has(state.last.fields.assignment_id);
    if (!state.conflict && !released && ['scheduled', 'in_progress'].includes(state.state)) {
      add(state.last.fields.assigned_worker_id, state.last.fields.scheduled_date, communityOf(request.fields.patient_id), 'coordination');
    }
  });
  reports.filter(r => r.form === 'carelink_oi_assignment' && !recorded.has(r._id) && (includeTestRecords || !testPlans.has(r.fields.proposal_id))).forEach(r => add(r.fields.worker_id, r.fields.date, r.fields.patient_id, 'approved_plan', Math.max(1, Number(r.fields.items_planned) || 1)));
  return out;
}

module.exports = { scopeToFacility, exportAggregates, monday };
