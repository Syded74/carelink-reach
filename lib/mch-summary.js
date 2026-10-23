'use strict';
/*
  Person profile for maternal and child tracking (docs/CHT_TRACKING_MAPPING.md §7). Every value is
  derived from recorded reports, as on the Flutter patient profile (patient_profile_screen.dart).
*/
const mch = require('./mch');
const { isoDay } = require('./schedules');

const STAGE = { anc: 'Antenatal (ANC)', pnc: 'Postnatal (PNC)', cwc: 'Child welfare (CWC)' };
const BAND = { urgent: 'Urgent', priority: 'Priority', routine: 'Routine' };

function workerName(contact, lineage) {
  const id = contact.responsible_worker_id;
  const place = (lineage || []).find(p => p && p.responsible_worker_id === id && p.responsible_worker_name);
  return id ? (place ? place.responsible_worker_name : id) : 'Not recorded';
}

function summarize(contact, reports, today = isoDay(), lineage = []) {
  if (!mch.isMch(contact)) { return { context: { mch: false }, fields: [], cards: [] }; }
  const f = mch.fields;
  const child = mch.isChild(contact);
  const stage = mch.currentStage(contact, reports);
  const urgency = mch.urgency(contact, reports, today);
  const nextDue = mch.nextDue(reports);
  const open = mch.appointments(reports).filter(a => !a.conflict && ['scheduled', 'rescheduled'].includes(a.state))
    .sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
  const openReferral = mch.referrals(reports).filter(mch.referralOpen).slice(-1)[0];
  const pregnancy = mch.openPregnancy(reports);
  const delivery = mch.deliveries(reports).slice(-1)[0];
  const doses = mch.recordedDoses(reports);

  const context = {
    mch: true, is_child: child, mch_stage: stage, mch_urgency: urgency.level, mch_reason: urgency.reason,
    open_pregnancy_id: pregnancy ? f(pregnancy).pregnancy_id : '',
    latest_delivery_id: delivery ? f(delivery).delivery_id : '',
    latest_delivery_date: delivery ? f(delivery).delivery_date : '',
    delivery_child_ids: delivery && mch.deliveryValid(delivery) ? f(delivery).child_ids : '',
    open_appointment_id: open ? open.id : '', open_appointment_event: open ? open.last._id : '',
    open_appointment_state: open ? open.state : '', open_appointment_due: open ? open.due_date : '',
    open_referral_id: openReferral ? openReferral.id : '', open_referral_event: openReferral ? openReferral.last._id : '',
    open_referral_state: openReferral ? openReferral.state : '', open_referral_due: '',
    recorded_dose_keys: doses.map(d => `;${mch.doseKey(d)};`).join(''),
  };

  // Day-based, as the task projector (mapping decision 2); the Flutter profile compares with now.
  const dueText = !nextDue ? 'No date recorded' : `${nextDue}${nextDue < today ? ' · overdue' : nextDue === today ? ' · due today' : ''}`;
  const fields = [
    { label: 'Care stage', value: STAGE[stage] || 'Not recorded', width: 6 },
    { label: 'Today', value: `${BAND[urgency.level]} · ${urgency.reason}`, width: 6 },
    { label: 'Next due', value: dueText, width: 6 },
    // The person stores only the CHO's id; households in the lineage carry the matching name
    { label: 'Responsible CHO', value: workerName(contact, lineage), width: 6 },
  ];
  if (child && contact.mother_id) {
    fields.push({ label: 'Mother', value: (contact.mother && contact.mother.name) || contact.caregiver_name || contact.mother_external_id || contact.mother_id, width: 6 });
  }

  const cards = [];
  mch.pregnancies(reports).forEach(p => {
    const delivered = mch.deliveries(reports).find(d => f(d).pregnancy_id === f(p).pregnancy_id);
    const edd = f(p).edd;
    cards.push({ label: 'Pregnancy', fields: [
      { label: 'Recorded', value: isoDay(p.reported_date), width: 6 },
      // patient_profile_screen.dart:78-85, presentation only.
      { label: 'EDD', value: mch.showEdd(edd, reports, today) ? edd : edd ? 'Hidden after PNC or 42 days past' : 'Not recorded', width: 6 },
      ...(delivered ? [
        { label: 'Delivery date', value: f(delivered).delivery_date, width: 6 },
        { label: 'Children linked', value: String(mch.words(f(delivered).child_ids).length), width: 6 },
        ...(mch.deliveryValid(delivered) ? [] : [{ label: 'Check', value: 'Delivery children are missing, repeated or include the mother. No newborn PNC until corrected.', width: 12 }]),
      ] : []),
    ] });
  });
  mch.appointments(reports).forEach(a => cards.push({ label: 'Appointment', fields: [
    { label: 'State', value: a.conflict ? 'Conflicting updates: review required. No task issued.' : a.state, width: 6 },
    { label: 'Date', value: a.due_date || '', width: 6 },
  ] }));
  mch.referrals(reports).forEach(r => cards.push({ label: 'Referral', fields: [
    { label: 'State', value: r.conflict ? 'Conflicting updates: review required.' : r.state.replace(/_/g, ' '), width: 6 },
    { label: 'Reason', value: f(r.root).reason || '', width: 6 },
    { label: 'Receiving facility', value: f(r.root).receiving_facility_name || 'Not recorded', width: 6 },
    { label: 'Acknowledgement', value: r.history.some(e => f(e).state === 'acknowledged') ? `Acknowledged by ${f(r.history.find(e => f(e).state === 'acknowledged')).actor || 'the facility'}` : 'Awaiting the receiving facility', width: 6 },
    { label: 'Synchronization', value: 'A referral saved on this phone reaches the facility only after sync; it is not proof that the person attended.', width: 12 },
  ] }));
  if (doses.length) {
    cards.push({ label: 'Vaccines recorded (no schedule)', fields: doses.map(d => ({
      label: `${d.vaccine} · ${d.dose}`, value: `${d.date || 'Undated'} · ${d.verification}${d.duplicate ? ' · recorded twice' : ''}`, width: 12,
    })) });
  }
  const latest = mch.latestVisit(reports);
  if (latest) {
    cards.push({ label: 'Latest visit', fields: [
      { label: 'Visit', value: `${STAGE[mch.visitStage(latest)]}${f(latest).pnc_subject === 'newborn' ? ' · newborn' : ''} · ${isoDay(latest.reported_date)}`, width: 12 },
      { label: 'Not measured', value: f(latest).missing_vitals || 'None', width: 6 },
      { label: 'Danger signs', value: (f(latest).danger_signs || 'None recorded').replace(/_/g, ' '), width: 6 },
    ] });
  }
  return { context, fields, cards };
}

module.exports = { summarize, STAGE };
