'use strict';
/*
  Plain-language labels for CHT report views (translation keys report.<form>.<path>) and the internal
  fields hidden from routine report views (XForm tag="hidden", CHT 5.3 hidden_fields).
  Hidden fields stay in every record: tasks, the planning worker, purging, audits and exports still read them.
  Used by scripts/build-report-labels.js and the planning worker (cht_integration.py mirrors SERVER_HIDDEN).
*/

// Field name → label, for any form. A form-specific entry ('form.path') wins over a name entry.
const LABELS = {
  patient_id: 'Patient reference',
  // Hidden from new reports; older reports still list them, so they get readable labels too.
  created_by: 'Recorded by (reference)',
  request_id: 'Request reference',
  expected_event: 'Previous record (reference)',
  assigned_worker_id: 'Assigned health worker (reference)',
  assignment_id: 'Outreach day reference',
  proposal_id: 'Outreach plan reference',
  meta: 'Record details',
  instanceID: 'Record ID',
  notice: 'Notice shown on the form',
  routing_notice: 'Routing notice shown on the form',
  task_id: 'Task reference',
  existing_id: 'Existing record (reference)',
  existing_event: 'Existing record step (reference)',
  existing_state: 'Status before this update',
  existing_due: 'Previous due date',
  current: 'Current record (reference)',
  next_state: 'Next status',
  new_id: 'New record reference',
  referral_id: 'Referral reference',
  appointment_id: 'Appointment reference',
  pregnancy_id: 'Pregnancy reference',
  delivery_id: 'Delivery reference',
  child_ids: 'Children (references)',
  receiving_facility_id: 'Receiving facility (reference)',
  actor_contact: 'Recorded by (reference)',
  patient_name: 'Person',
  household_name: 'Household',
  community_name: 'Community',
  approval_status: 'Clinical review status',
  current_status: 'Request status before this update',
  status: 'Status',
  state: 'Status',
  stage: 'Care stage',
  visit_date: 'Visit date',
  visit_type: 'Type of visit',
  scheduled_date: 'Confirmed outreach date',
  outcome_note: 'Outcome note',
  note: 'Note',
  reason: 'Reason',
  follow_up_date: 'Next follow-up date',
  vitals: 'Measurements',
  signs: 'Signs recorded',
  danger_signs: 'Danger signs reported or observed',
  missing_vitals: 'Measurements not taken',
  quality_issues: 'Data-entry checks',
  documentation: 'Documentation',
  vaccines: 'Vaccines given',
  dose: 'Dose',
  care_need: 'Help needed',
  followup_type: 'Type of follow-up',
  contact_method: 'How to reach the household',
  access_barrier: 'Access barrier',
  travel_time: 'Travel time to the facility',
  consent: 'Household consent',
  contact_date: 'Contact date',
  outcome: 'Outcome',
  information: 'Information shared',
  assigned_worker_name: 'Assigned health worker',
  receiving_facility_name: 'Receiving facility',
  mode: 'Recording',
  resource_id: 'Resource',
  quantity: 'Quantity',
  reserved: 'Reserved',
  verified_date: 'Date checked',
  actor: 'Recorded by (username)',
  task_kind: 'Task type',
  planning_date: 'Outreach date',
  season: 'Season',
  staff_available: 'Staff available',
  hours_start: 'Working hours start',
  hours_end: 'Working hours end',
  vehicles: 'Vehicles available',
  fairness_weight: 'Fairness weight',
  guarantee_communities: 'Communities guaranteed a visit',
  use_synthetic_history: 'Use simulated history',
  include_test_records: 'Include test records',
  action: 'Decision',
  notes: 'Notes',
  followup_required: 'Further contact needed',
  referral_recorded: 'Referral recorded separately',
  delivery_date: 'Delivery date',
  children_note: 'Children',
  children: 'Children',
  due_date: 'Due date',
  pnc_subject: 'PNC visit for',
  newborn: 'Newborn',
  mother_id: 'Mother reference',
  'vitals.weight_kg': 'Weight (kg)',
  'vitals.length_height_cm': 'Length / height (cm)',
  'vitals.muac_mm': 'MUAC (mm)',
  'vitals.systolic_bp': 'Systolic BP (mmHg)',
  'vitals.diastolic_bp': 'Diastolic BP (mmHg)',
  'vitals.gestational_age_weeks': 'Gestational age (weeks)',
  'vitals.fundal_height_cm': 'Fundal height (cm)',
  'vitals.fetal_heart_rate_bpm': 'Fetal heart rate (bpm)',
  'vitals.haemoglobin_g_dl': 'Haemoglobin (g/dL)',
  'vitals.temperature_c': 'Temperature (°C)',
  'carelink_coordination.status': 'Request status after this update',
  'carelink_visit.status': 'What happened',
  'carelink_resource_status.status': 'Readiness',
  'carelink_oi_outreach_day.outcome': 'Outreach day outcome',
};

// Internal identifiers and plumbing hidden from routine report views (any depth, except inside inputs).
const HIDDEN = [
  'meta', 'notice', 'routing_notice', 'created_by', 'actor_contact', 'request_id', 'expected_event', 'assigned_worker_id',
  'existing_id', 'existing_event', 'existing_state', 'existing_due', 'current', 'next_state', 'new_id', 'referral_id',
  'appointment_id', 'pregnancy_id', 'delivery_id', 'child_ids', 'assignment_id', 'proposal_id', 'receiving_facility_id',
  'carelink_task_id', 'carelink_source_id', 'task_id', 'source_id', 'requested_by', 'summary', 'step', 'current_state',
  'patient_uuid', 'responsible_worker_id', 'planned_date', 'items_planned', 'route', 'requests_planned',
  // Shown in the report header already.
  'patient_name', 'household_name', 'community_name',
  // Form helpers for the plan request (the suggested outreach day).
  'suggested_date', 'outreach_weekday',
];

// Records written by the planning service: only these fields are labelled (CHT JSON forms); everything else stays in the record.
const SERVER_FIELDS = {
  carelink_oi_demand: { as_of: 'Estimated on', dataset_label: 'Data used', model_version: 'Forecast version' },
  carelink_oi_proposal: { planning_date: 'Outreach date', requested_by: 'Requested by', planner_version: 'Planner version' },
  carelink_oi_ack: { action: 'Decision', actor: 'Decided by (username)', result: 'Server result', reason: 'Reason', state_after: 'Plan status after this decision' },
  carelink_oi_assignment: { date: 'Outreach date', worker_name: 'Assigned health worker', community_name: 'Community', items_planned: 'Routine items planned', route_text: 'Route' },
  carelink_oi_day_plan: { date: 'Outreach date', worker_name: 'Assigned health worker', community_name: 'Community', items_planned: 'Routine items planned' },
  carelink_oi_request_link: { scheduled_date: 'Planned date', status: 'Status', assigned_username: 'Assigned health worker (username)' },
  carelink_oi_followup_link: { scheduled_date: 'Planned date', kind: 'Follow-up type', category: 'Care category', assigned_username: 'Assigned health worker (username)' },
};

const humanise = name => {
  const text = name.replace(/_/g, ' ').replace(/\b(anc|pnc|cwc|bp|muac|edd|lmp|itn|ipt|td)\b/gi, m => m.toUpperCase()).trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

module.exports = { LABELS, HIDDEN, SERVER_FIELDS, humanise };
