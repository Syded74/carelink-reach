'use strict';
/*
  Outreach need score: version 1 of demand estimation (docs/CARELINK_OUTREACH_PLANNING.md).
  Every point comes from a recorded item with its record id, so each ranking can be explained and
  checked. Maternal and child items reuse the exact task logic of lib/mch.js; outreach requests reuse
  lib/workflow.js. The weights rank outreach work for planning. They are programme settings pending
  review, not clinical risk scores.
*/
const w = require('./workflow');
const mch = require('./mch');
const { isoDay } = require('./schedules');

const WEIGHTS = {
  approval_status: 'pending_programme_review',
  open_request: 20,
  barrier: { distance: 10, transport_unavailable: 10, transport_cost: 10, household_decision: 5, language: 5, other: 5 },
  mch: { recordedConcern: 50, referralFollowUp: 30, missedAppointment: 25, appointmentDue: 20, scheduledFollowUp: 15,
    missingAssessment: 10, firstVisit: 10 },
  // Requests measure access, not need: a community that has gone quiet still earns points, so silence
  // is never read as "no need" (equity floor).
  coverage_grace_days: 14,
  coverage_points_per_day: 1,
  coverage_cap: 30,
};
const BARRIER_LABEL = { distance: 'distance', transport_unavailable: 'no transport', transport_cost: 'transport cost',
  household_decision: 'household decision-making', language: 'language', other: 'other barrier' };
const VISIT_FORMS = [w.FORMS.visit, ...mch.VISIT_FORMS];

const days = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
const dayOf = report => {
  const f = report.fields || {};
  return f.visit_date || isoDay(report.reported_date);
};

function assess(docs, today = isoDay(), weights = WEIGHTS) {
  const live = docs.filter(d => d && !d._deleted);
  const contacts = new Map(live.filter(d => d.type === 'contact').map(d => [d._id, d]));
  const reports = live.filter(d => d.type === 'data_record' && d.fields);
  const byPatient = new Map();
  reports.forEach(r => byPatient.set(r.fields.patient_id, [...(byPatient.get(r.fields.patient_id) || []), r]));
  const householdOf = id => {
    const c = contacts.get(id);
    if (!c) { return null; }
    if (c.contact_type === 'carelink_household') { return c; }
    return c.parent && contacts.get(c.parent._id) && contacts.get(c.parent._id).contact_type === 'carelink_household' ? contacts.get(c.parent._id) : null;
  };

  // Last recorded visit per community: a completed outreach visit or any maternal/child visit.
  const lastVisit = new Map();
  reports.filter(r => VISIT_FORMS.includes(r.form) && (r.form !== w.FORMS.visit || r.fields.status === 'completed')).forEach(r => {
    const household = householdOf(r.fields.patient_id);
    const community = household && household.parent && household.parent._id;
    if (community && (!lastVisit.has(community) || dayOf(r) > lastVisit.get(community))) { lastVisit.set(community, dayOf(r)); }
  });

  const households = [...contacts.values()].filter(c => c.contact_type === 'carelink_household').map(household => {
    const items = [];
    const own = byPatient.get(household._id) || [];
    w.requests({ reports: own }).forEach(request => {
      const state = w.workflow(request, own);
      if (w.TERMINAL.includes(state.state)) { return; }
      items.push({ kind: 'open_request', points: weights.open_request, record: request._id,
        label: `Open outreach request (${state.conflict ? 'conflict: facility review' : state.state.replace(/_/g, ' ')})` });
      const barrier = request.fields.access_barrier;
      if (weights.barrier[barrier]) {
        items.push({ kind: 'barrier', points: weights.barrier[barrier], record: request._id, label: `Reported barrier: ${BARRIER_LABEL[barrier]}` });
      }
    });
    [...contacts.values()].filter(p => p.parent && p.parent._id === household._id && mch.isMch(p)).forEach(person => {
      mch.projectTasks(person, byPatient.get(person._id) || [], today).forEach(task => {
        items.push({ kind: task.kind, points: weights.mch[task.kind] || 0, record: task.source, person: person._id,
          label: `${mch.TASK_REASONS[task.kind]} · ${person.name}` });
      });
    });
    return { id: household._id, name: household.name, community: household.parent && household.parent._id,
      worker: household.responsible_worker_id, items, score: items.reduce((sum, i) => sum + i.points, 0) };
  });

  const communities = [...contacts.values()].filter(c => c.contact_type === 'carelink_community').map(community => {
    const members = households.filter(h => h.community === community._id);
    const last = lastVisit.get(community._id) || null;
    const since = last ? days(last, today) : null;
    const coverage = since === null ? weights.coverage_cap
      : Math.min(weights.coverage_cap, Math.max(0, since - weights.coverage_grace_days) * weights.coverage_points_per_day);
    const workers = members.map(h => h.worker).filter(Boolean);
    const worker = workers.sort((a, b) => workers.filter(x => x === b).length - workers.filter(x => x === a).length)[0] || null;
    return { id: community._id, name: community.name, last_visit: last, days_since_visit: since, coverage_points: coverage,
      worker, households: members.map(h => h.id), score: members.reduce((sum, h) => sum + h.score, 0) + coverage,
      explanation: explain(members, coverage, since) };
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return { today, weights, households: households.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)), communities };
}

function explain(households, coverage, since) {
  const counts = new Map();
  households.flatMap(h => h.items).forEach(i => {
    const key = i.kind === 'barrier' ? i.label : i.kind === 'open_request' ? 'Open outreach requests' : mch.TASK_REASONS[i.kind];
    const entry = counts.get(key) || { n: 0, points: 0 };
    counts.set(key, { n: entry.n + 1, points: entry.points + i.points });
  });
  const parts = [...counts.entries()].sort((a, b) => b[1].points - a[1].points).map(([label, c]) => `${c.n}× ${label} (+${c.points})`);
  if (coverage) { parts.push(since === null ? `No visit recorded (+${coverage})` : `No visit for ${since} days (+${coverage})`); }
  return parts.join('; ') || 'No recorded needs';
}

module.exports = { WEIGHTS, assess };
