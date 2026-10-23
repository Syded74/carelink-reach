'use strict';
/*
  Documented maternal and child follow-ups as routine outreach work (docs/MCH_OUTREACH_INTELLIGENCE_INTEGRATION.md).
  A projection only: every obligation is a task that lib/mch.js projectTasks already raises for the CHO,
  identified by its existing task id (person:kind:source). Nothing here adds a due date, a schedule or a
  clinical judgement. Danger signs (recordedConcern) and referral follow-ups stay on their urgent pathways
  and never become routine outreach work.

  Counting rules (no double counting):
  - an obligation is one open task id; a person with several open obligations is one encounter;
  - an open household request is one encounter, except when it asks for the same service stage as a
    household member's open follow-ups (antenatal ↔ ANC, postnatal ↔ PNC, child welfare ↔ CWC): then the
    request and that person share one encounter;
  - attending one encounter resolves only the obligations that receive their own recorded resolution.
*/
const w = require('./workflow');
const mch = require('./mch');

const OUTREACH_KINDS = ['firstVisit', 'scheduledFollowUp', 'appointmentDue', 'missedAppointment', 'missingAssessment'];
const URGENT_KINDS = ['recordedConcern', 'referralFollowUp'];
const REQUEST_STAGE = { antenatal_care: 'anc', postnatal_care: 'pnc', child_welfare: 'cwc' };
const fields = mch.fields;

function index(docs) {
  // A re-synced copy of the same record must never count twice: one document per _id.
  const live = [...new Map(docs.filter(d => d && !d._deleted).map(d => [d._id, d])).values()];
  const contacts = new Map(live.filter(d => d.type === 'contact').map(d => [d._id, d]));
  const byPatient = new Map();
  live.filter(d => d.type === 'data_record' && d.fields).forEach(r => {
    const id = fields(r).patient_id;
    byPatient.set(id, [...(byPatient.get(id) || []), r]);
  });
  return { live, contacts, byPatient };
}
const householdOf = (ix, person) => {
  const parent = person.parent && ix.contacts.get(person.parent._id);
  return parent && parent.contact_type === 'carelink_household' ? parent : null;
};
const communityOf = (ix, household) => household && household.parent && household.parent._id;
const categoryOf = person => mch.isChild(person) ? 'child' : 'maternal';

/*
  Open obligations as of `day` (the planning date or today), for MCH people in households.
  Each item: stable task id, person, household, community, responsible CHO, kind, category, stage, source
  record, recorded due date (if any), and the person's latest record time (provenance).
*/
function followUps(docs, day) {
  const ix = docs.contacts ? docs : index(docs);
  const out = { routine: [], urgent: [] };
  for (const person of ix.contacts.values()) {
    if (!mch.isMch(person)) { continue; }
    const household = householdOf(ix, person);
    if (!household) { continue; }
    const reports = ix.byPatient.get(person._id) || [];
    const stage = mch.currentStage(person, reports);
    const updated = Math.max(person.reported_date || 0, ...reports.map(r => r.reported_date || 0));
    for (const task of mch.projectTasks(person, reports, day)) {
      const item = { task_id: task.id, kind: task.kind, source: task.source, due_date: task.due_date || null,
        person_id: person._id, household_id: household._id, community_id: communityOf(ix, household),
        worker_id: person.responsible_worker_id || null, category: categoryOf(person), stage, last_updated: updated };
      if (OUTREACH_KINDS.includes(task.kind)) { out.routine.push(item); } else if (URGENT_KINDS.includes(task.kind)) { out.urgent.push(item); }
    }
  }
  return out;
}

const openRequests = ix => {
  const out = [];
  for (const [patient, reports] of ix.byPatient) {
    const household = ix.contacts.get(patient);
    if (!household || household.contact_type !== 'carelink_household') { continue; }
    reports.filter(r => r.form === w.FORMS.request).forEach(request => {
      const state = w.workflow(request, reports);
      if (!w.TERMINAL.includes(state.state)) {
        out.push({ request, household_id: household._id, community_id: communityOf(ix, household), state, stage: REQUEST_STAGE[fields(request).care_need] || null });
      }
    });
  }
  return out;
};

/*
  Encounter units: what a CHO actually has to visit. A request and a household member's follow-ups for
  the same service stage merge into one unit. `date` orders units oldest first (request date; for a person,
  the earliest recorded due date, else their registration).
*/
function units(requests, items, ix) {
  const people = new Map();
  items.forEach(i => people.set(i.person_id, [...(people.get(i.person_id) || []), i]));
  const personUnits = [...people.entries()].map(([personId, list]) => {
    const person = ix.contacts.get(personId);
    const due = list.map(i => i.due_date).filter(Boolean).sort()[0];
    return { key: `person:${personId}`, community_id: list[0].community_id, household_id: list[0].household_id, person_id: personId,
      worker_id: list[0].worker_id, stage: list[0].stage, category: list[0].category, items: list, request: null,
      date: due ? Date.parse(due + 'T00:00:00Z') : person.reported_date || 0 };
  });
  const merged = new Set();
  const requestUnits = requests.map(r => {
    const match = r.stage && personUnits.find(u => !merged.has(u.key) && u.household_id === r.household_id && u.stage === r.stage);
    if (match) { merged.add(match.key); match.request = r; return null; }
    return { key: `request:${r.request._id}`, community_id: r.community_id, household_id: r.household_id, person_id: null,
      worker_id: null, items: [], request: r, date: r.request.reported_date || 0 };
  }).filter(Boolean);
  return [...personUnits, ...requestUnits].sort((a, b) => a.date - b.date || a.key.localeCompare(b.key));
}

// The visit type a unit needs: the person's care stage, or a household request on its own.
const visitType = unit => unit.person_id ? (['anc', 'pnc', 'cwc'].includes(unit.stage) ? unit.stage : 'anc') : 'request';

// Community-level counts for the forecasting engine: aggregates only, no names or record ids.
function communityWorkload(docs, day) {
  const ix = index(docs);
  const { routine, urgent } = followUps(ix, day);
  const requests = openRequests(ix);
  const all = units(requests, routine, ix);
  const summary = new Map();
  const row = id => {
    if (!summary.has(id)) {
      summary.set(id, { open_requests: 0, open_maternal_followups: 0, open_child_followups: 0, unique_people: 0, unique_households: 0,
        encounters: 0, urgent_items_excluded: 0, encounters_request: 0, encounters_anc: 0, encounters_pnc: 0, encounters_cwc: 0 });
    }
    return summary.get(id);
  };
  requests.forEach(r => { row(r.community_id).open_requests++; });
  routine.forEach(i => { row(i.community_id)[i.category === 'child' ? 'open_child_followups' : 'open_maternal_followups']++; });
  urgent.forEach(i => { row(i.community_id).urgent_items_excluded++; });
  const households = new Map();
  all.forEach(u => {
    const r = row(u.community_id);
    r.encounters++;
    r[`encounters_${visitType(u)}`]++;
    if (u.person_id) { r.unique_people++; }
    households.set(u.community_id, (households.get(u.community_id) || new Set()).add(u.household_id));
  });
  households.forEach((set, community) => { row(community).unique_households = set.size; });
  return summary;
}

module.exports = { OUTREACH_KINDS, URGENT_KINDS, REQUEST_STAGE, index, followUps, openRequests, units, visitType, communityWorkload, categoryOf };
