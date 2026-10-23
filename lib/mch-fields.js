'use strict';
/*
  MCH data-entry contracts ported verbatim from the CareLink Flutter app.
  Source: clink/App-Code/lib/domain/mch_documentation.dart (fields, sections, notes),
  App-Code/assets/configuration/default.json (vitals, danger signs) and
  App-Code/lib/views/visit/visit_wizard_screen.dart:100-113 (data-entry ranges).
  Labels, options and ranges are unchanged. Nothing here is a clinical decision.
*/
const APPROVAL = { approval_status: 'pending_clinical_review', release_authorized: false };

// Answer states (mch_documentation.dart:10-23).
const ANSWER_STATES = { recorded: 'Confirmed', unverified: 'Reported, not verified', unknown: 'Unknown', notAssessed: 'Not assessed' };

const YES_NO = ['Yes', 'No'];
const f = (id, label, section, opts = {}) => ({ id, label, section, ...opts });

const INVESTIGATIONS = [ // mch_documentation.dart:103-127
  f('shared.investigation_status', 'Investigation status this visit', 'Investigations and referral', {
    options: ['Not ordered', 'Ordered', 'Sample collected', 'Result recorded', 'Result not available', 'Not applicable'] }),
  f('shared.investigation_source', 'Investigation source / laboratory (if known)', 'Investigations and referral'),
  f('shared.investigation_outstanding', 'Outstanding investigation or result to follow up', 'Investigations and referral'),
];
const SHARED = [ // mch_documentation.dart:129-156
  f('care.counselling', 'Counselling actually delivered', 'Counselling and plan'),
  f('care.caregiver_plan', 'Agreed caregiver plan', 'Counselling and plan'),
  f('care.barriers', 'Practical barriers / support needed', 'Counselling and plan'),
  f('care.follow_up_date', 'Follow-up date (YYYY-MM-DD)', 'Counselling and plan', { date: true }),
  f('care.follow_up_reason', 'Follow-up reason / outstanding work', 'Counselling and plan'),
];
const NEWBORN = [ // mch_documentation.dart:158-208
  f('pnc_newborn.weight_kg', 'Newborn measured weight (kg)', 'Newborn assessment', { numeric: true }),
  f('pnc_newborn.temperature_c', 'Newborn measured temperature (°C)', 'Newborn assessment', { numeric: true }),
  f('pnc_newborn.feeding', 'Newborn feeding / breastfeeding observations', 'Newborn assessment'),
  f('pnc_newborn.cord', 'Cord observations', 'Newborn assessment'),
  f('pnc_newborn.jaundice', 'Jaundice observations (no classification)', 'Newborn assessment'),
  f('pnc_newborn.concerns', 'Reported newborn concerns', 'Newborn assessment'),
  f('pnc_newborn.measurement_time', 'Time weight and temperature were measured (HH:MM)', 'Newborn assessment', { time: true }),
  f('pnc_newborn.breathing', 'Breathing observations (no classification)', 'Newborn assessment'),
  f('pnc_newborn.activity', 'Activity and responsiveness observations', 'Newborn assessment'),
  f('pnc_newborn.actions', 'Actions taken for the newborn', 'Newborn assessment'),
];
const ANC = [ // mch_documentation.dart:216-353
  f('anc.visit_kind', 'Visit type', 'Visit identification', { options: ['Booking', 'Return'] }),
  f('anc.pregnancy_reference', 'Pregnancy reference (if known)', 'Visit identification'),
  f('anc.obstetric_history', 'Obstetric and maternal history', 'Booking history', { bookingOnly: true }),
  f('anc.edd', 'Recorded EDD (YYYY-MM-DD)', 'Booking history', { date: true, bookingOnly: true }),
  f('anc.edd_method', 'How the EDD was determined', 'Booking history', { bookingOnly: true,
    options: ['From LMP', 'From ultrasound', 'From fundal height', 'Copied from paper record', 'Other'] }),
  f('anc.lmp_date', 'Last menstrual period (YYYY-MM-DD)', 'Booking history', { date: true, bookingOnly: true }),
  f('anc.lmp_source', 'Source of the LMP date', 'Booking history', { bookingOnly: true,
    options: ['Woman\'s recall', 'Paper MCH record', 'Facility record'] }),
  f('anc.gravida', 'Gravida (number of pregnancies, including this one)', 'Booking history', { numeric: true, bookingOnly: true }),
  f('anc.para', 'Para (number of previous births)', 'Booking history', { numeric: true, bookingOnly: true }),
  f('anc.previous_complications', 'Previous pregnancy complications (as recorded or reported)', 'Booking history', { bookingOnly: true }),
  f('anc.allergies', 'Allergies (unknown is not absent)', 'Medical history'),
  f('anc.current_medication', 'Current medication', 'Medical history'),
  f('anc.reported_symptoms', 'Symptoms reported by the woman today', 'Reported by the woman'),
  f('anc.gestational_age_source', 'Source of today\'s gestational age', 'Measurements', {
    options: ['LMP', 'Ultrasound', 'Fundal height', 'Copied from paper record'] }),
  f('anc.bp_time', 'Blood pressure measured at (HH:MM)', 'Measurements', { time: true }),
  f('anc.bp_method', 'Blood pressure method', 'Measurements', { options: ['Manual sphygmomanometer', 'Automated device'] }),
  f('anc.fetal_movement', 'Fetal movement reported', 'Fetal assessment', { options: YES_NO }),
  f('anc.investigations', 'Investigations: test, result, date and source', 'Investigations and referral'),
  ...INVESTIGATIONS,
  f('anc.interventions', 'Interventions actually provided', 'Interventions'),
  f('anc.professional_assessment', 'Health worker\'s recorded assessment', 'Assessment and action'),
  f('anc.professional_action', 'Action taken by the health worker', 'Assessment and action'),
];
const PNC_MATERNAL = [ // mch_documentation.dart:358-432
  f('pnc.delivery_reference', 'Delivery reference (if known)', 'Delivery summary'),
  f('pnc.delivery_date', 'Delivery date (YYYY-MM-DD)', 'Delivery summary', { date: true }),
  f('pnc.delivery_place_mode', 'Recorded delivery place and mode', 'Delivery summary'),
  f('pnc.maternal_recovery', 'Maternal recovery, bleeding and wound observations', 'Maternal assessment only'),
  f('pnc.maternal_breastfeeding_support', 'Maternal breastfeeding support documented', 'Maternal assessment only'),
  f('pnc.timing_since_delivery', 'Time since delivery at this visit', 'Maternal assessment only', {
    options: ['Within 24 hours', 'Day 2–3', 'Day 4–7', 'Week 2–6', 'After 6 weeks'] }),
  f('pnc.complications', 'Pregnancy, delivery or postnatal complications recorded', 'Maternal assessment only'),
  f('pnc.bleeding', 'Bleeding observations', 'Maternal assessment only'),
  f('pnc.uterine_recovery', 'Uterine recovery observations', 'Maternal assessment only'),
  f('pnc.wound_perineum', 'Wound or perineum observations', 'Maternal assessment only'),
  f('pnc.breastfeeding_concerns', 'Breastfeeding concerns reported', 'Maternal assessment only'),
  f('pnc.maternal_wellbeing', 'Maternal wellbeing (as observed or reported)', 'Maternal assessment only'),
  f('pnc.treatment_given', 'Treatment actually provided', 'Maternal assessment only'),
  ...INVESTIGATIONS,
];
const CWC = [ // mch_documentation.dart:434-564
  f('cwc.measurement_position', 'Length / height position', 'Growth observations', { options: ['Lying', 'Standing'] }),
  f('cwc.measurement_time', 'Measurements taken at (HH:MM)', 'Growth observations', { time: true }),
  f('cwc.caregiver_concerns', 'Caregiver concerns, in their words', 'Caregiver report'),
  f('cwc.illness_history', 'Recent illness reported by the caregiver', 'Caregiver report'),
  f('cwc.clinician_observations', 'Health worker observations today', 'Health worker observations'),
  f('cwc.feeding.breastfeeding', 'Currently breastfeeding', 'Feeding assessment', { options: YES_NO }),
  f('cwc.feeding.exclusive_breastfeeding', 'Exclusive breastfeeding reported', 'Feeding assessment', { options: YES_NO }),
  f('cwc.feeding.complementary_start_date', 'Complementary feeding start (YYYY-MM-DD)', 'Feeding assessment', { date: true }),
  f('cwc.feeding.meals_per_day', 'Meals per day reported', 'Feeding assessment', { numeric: true }),
  f('cwc.feeding.food_groups', 'Foods / food groups in previous 24 hours', 'Feeding assessment'),
  f('cwc.feeding.breastfeeds_per_day', 'Breastfeeds per day reported', 'Feeding assessment', { numeric: true }),
  f('cwc.feeding.difficulty', 'Reported feeding difficulties', 'Feeding assessment'),
  f('cwc.feeding.allergy_status', 'Allergy status', 'Feeding assessment', { options: ['Known allergy', 'Suspected allergy', 'No known allergy'] }),
  f('cwc.feeding.allergies', 'Allergies reported (unknown is not absent)', 'Feeding assessment'),
  f('cwc.household.foods', 'Available household foods', 'Household context'),
  f('cwc.household.constraints', 'Affordability, preferences, season and preparation constraints', 'Household context'),
  f('cwc.household.affordability', 'Foods the household can afford', 'Household context'),
  f('cwc.household.seasonal', 'Seasonal availability noted', 'Household context'),
  f('cwc.household.preparation_hygiene', 'Preparation, water and hygiene constraints', 'Household context'),
  f('cwc.feeding.counselling_given', 'Feeding counselling actually given', 'Feeding counselling'),
  f('cwc.feeding.caregiver_understanding', 'Caregiver understanding of the counselling', 'Feeding counselling', {
    options: ['Explained it back', 'Had questions', 'Not checked'] }),
  f('cwc.immunisation.records', 'Vaccines actually given: name, dose, date and source', 'Immunisation record'),
  f('cwc.development.notes', 'Development observations / caregiver concerns', 'Development record'),
  f('cwc.development.milestones_observed', 'Milestones observed today (no judgement)', 'Development record'),
  ...INVESTIGATIONS,
];

// mch_documentation.dart:210-215 + :560-569 (shared fields close every pathway).
function documentationFields(stage, pncSubject = 'maternal') {
  const body = stage === 'anc' ? ANC : stage === 'cwc' ? CWC : pncSubject === 'newborn' ? [...NEWBORN, ...INVESTIGATIONS] : PNC_MATERNAL;
  return [...body, ...SHARED];
}

// mch_documentation.dart:640-674.
const SECTION_NOTES = {
  'Visit identification': 'Choose booking or return. This selects which sections apply to this visit.',
  'Booking history': 'Recorded once at booking. These details are never copied into a return visit.',
  'Fetal assessment': 'Record what was assessed today, not a previous visit.',
  'Investigations and referral': 'Status only. Results and their clinical meaning are not interpreted here.',
  'Interventions': 'Record only what was actually provided this visit.',
  'Delivery summary': 'Recorded once from the delivery record. Later PNC visits do not repeat it automatically.',
  'Maternal assessment only': 'Maternal findings only. Open the child record for newborn PNC.',
  'Newborn assessment': 'Newborn findings only, recorded against the child. Unknown is not normal.',
  'Growth observations': 'Weight, length/height and MUAC are entered in the measurements step.',
  'Feeding assessment': 'Caregiver-reported feeding. No feeding prescription is generated here.',
  'Household context': 'Household context reported by the caregiver.',
  'Immunisation record': 'Record doses actually given. No schedule or due date is shown.',
  'Development record': 'Observations and caregiver concerns only, no milestone judgement.',
  'Medical history': 'Ask today. Unknown is not "none", and nothing is copied from an earlier visit.',
  'Reported by the woman': 'What the woman says, kept separate from what you observe or measure.',
  'Measurements': 'How and when today\'s measurements were taken. The values are in the vitals step.',
  'Assessment and action': 'Your recorded assessment and what you did. CareLink adds no classification.',
  'Caregiver report': 'What the caregiver reports, kept separate from your own observations.',
  'Health worker observations': 'What you observed today.',
  'Feeding counselling': 'Record counselling actually given. CareLink does not generate a feeding plan.',
  'Counselling and plan': 'Record what was actually delivered and agreed. Not assessed is not a normal finding.',
};

// assets/configuration/default.json (carelink-config-2). Newborn PNC has no vitals or signs.
const VITALS = {
  anc: [['gestational_age_weeks', 'Gestational age', 'weeks'], ['fundal_height_cm', 'Fundal height', 'cm'],
    ['fetal_heart_rate_bpm', 'Fetal heart rate', 'bpm'], ['haemoglobin_g_dL', 'Haemoglobin', 'g/dL'],
    ['systolic_bp', 'Systolic BP', 'mmHg'], ['diastolic_bp', 'Diastolic BP', 'mmHg'], ['weight_kg', 'Weight', 'kg']],
  pnc: [['temperature_c', 'Temperature', '°C'], ['systolic_bp', 'Systolic BP', 'mmHg'], ['diastolic_bp', 'Diastolic BP', 'mmHg'], ['weight_kg', 'Weight', 'kg']],
  cwc: [['weight_kg', 'Weight', 'kg'], ['length_height_cm', 'Length / height', 'cm'], ['muac_mm', 'MUAC', 'mm']],
};
const DANGER_SIGNS = {
  anc: ['Convulsions reported', 'Bleeding reported', 'Other concern reported'],
  pnc: ['Convulsions reported', 'Bleeding reported', 'Other concern reported'],
  cwc: ['Caregiver reports feeding difficulty', 'Other concern reported'],
};
// visit_wizard_screen.dart:100-113: data-entry plausibility only. Outside the range the CHO must
// recheck or confirm the value as questionable (stored as OUT_OF_RANGE_CONFIRMED).
const DATA_ENTRY_RANGES = {
  weight_kg: [0.4, 180, true], length_height_cm: [25, 210], muac_mm: [60, 400], systolic_bp: [50, 260],
  diastolic_bp: [30, 170], temperature_c: [32, 43], gestational_age_weeks: [0, 45], fundal_height_cm: [5, 55],
  fetal_heart_rate_bpm: [60, 240], haemoglobin_g_dL: [2, 24],
};

// administered_vaccine.dart:5-14.
const DOSE_VERIFICATION = {
  verified: 'Verified against a card or facility record',
  unverified: 'Documented but not checked against a record',
  reported: 'Reported by the caregiver',
  unknown: 'Caregiver unsure / not known',
};
const UNDATED_DOSE_STATES = ['reported', 'unknown'];

const slug = text => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const fieldName = id => id.replace(/\./g, '_');

module.exports = { APPROVAL, ANSWER_STATES, documentationFields, SECTION_NOTES, VITALS, DANGER_SIGNS, DATA_ENTRY_RANGES,
  DOSE_VERIFICATION, UNDATED_DOSE_STATES, slug, fieldName };
