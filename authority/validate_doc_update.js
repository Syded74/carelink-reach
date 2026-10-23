/*
  CareLink server-side authority check, deployed as _design/carelink-authority in the medic database.
  CouchDB runs every design doc's validate_doc_update on every write, and CHT forwards offline users'
  _bulk_docs to CouchDB with the user's own credentials, so userCtx.roles holds the CHT roles.
  ES5 only: this runs inside CouchDB's JavaScript engine.
*/
function(newDoc, oldDoc, userCtx, secObj) {
  var ALLOWED = {
    carelink_request: ['carelink_community', 'carelink_cho'],
    // A volunteer's non-clinical note on contacting a household; it never changes the request's state.
    carelink_household_contact: ['carelink_community'],
    carelink_coordination: ['carelink_coordinator'],
    carelink_visit: ['carelink_cho'],
    carelink_referral: ['carelink_cho', 'carelink_coordinator'],
    // Maternal and child tracking (lib/mch.js). Flutter CHO/NURSE actions map to carelink_cho.
    carelink_pregnancy: ['carelink_cho'],
    carelink_delivery: ['carelink_cho'],
    carelink_anc_visit: ['carelink_cho'],
    carelink_pnc_visit: ['carelink_cho'],
    carelink_cwc_visit: ['carelink_cho'],
    carelink_appointment: ['carelink_cho'],
    carelink_task_resolution: ['carelink_cho'],
    carelink_mch_referral: ['carelink_cho', 'carelink_coordinator', 'carelink_supervisor'],
    // Outreach Intelligence (docs/OUTREACH_INTELLIGENCE_ARCHITECTURE.md): people request and decide ...
    carelink_oi_request: ['carelink_coordinator', 'carelink_supervisor'],
    carelink_oi_review: ['carelink_coordinator', 'carelink_supervisor'],
    carelink_oi_outreach_day: ['carelink_cho'],
    // ... and only the planning service account records plans, server acknowledgements and assignments.
    carelink_oi_demand: ['carelink_oi_service'],
    carelink_oi_proposal: ['carelink_oi_service'],
    carelink_oi_ack: ['carelink_oi_service'],
    carelink_oi_assignment: ['carelink_oi_service'],
    // Approved days → household requests (lib/oi-links.js).
    carelink_oi_day_plan: ['carelink_oi_service'],
    carelink_oi_request_link: ['carelink_oi_service'],
    carelink_oi_followup_link: ['carelink_oi_service'],
    // Supplies, equipment and fuel confirmed by facility staff (readiness for planning).
    carelink_resource_status: ['carelink_coordinator', 'carelink_supervisor']
  };
  var SERVICE_ROLE = 'carelink_oi_service';
  // Forms whose author must stamp their own CHT username in fields.actor, so the server-side planner
  // can verify who acted (separation of duties) without trusting the client.
  var ACTOR_STAMPED = ['carelink_oi_request', 'carelink_oi_review', 'carelink_visit', 'carelink_task_resolution', 'carelink_appointment', 'carelink_resource_status', 'carelink_mch_referral'];
  // Referral roles per recorded state (referral_lifecycle.dart:80-92; RECEIVING_FACILITY = carelink_coordinator).
  // Keep in step with REFERRAL_ROLES in lib/mch.js.
  var REFERRAL_ROLES = {
    created: ['carelink_cho'],
    acknowledged: ['carelink_coordinator'],
    arrival_confirmed: ['carelink_cho', 'carelink_coordinator'],
    outcome_recorded: ['carelink_cho', 'carelink_coordinator'],
    closed: ['carelink_cho', 'carelink_supervisor'],
    cancelled: ['carelink_cho', 'carelink_supervisor'],
    unresolved: ['carelink_cho', 'carelink_supervisor']
  };
  // Coordination events form an append-only chain (see lib/workflow.js); so do all tracking records.
  var APPEND_ONLY = ['carelink_household_contact', 'carelink_coordination', 'carelink_visit', 'carelink_referral', 'carelink_pregnancy', 'carelink_delivery',
    'carelink_anc_visit', 'carelink_pnc_visit', 'carelink_cwc_visit', 'carelink_appointment', 'carelink_task_resolution',
    'carelink_mch_referral', 'carelink_oi_request', 'carelink_oi_review', 'carelink_oi_outreach_day', 'carelink_oi_demand',
    'carelink_oi_proposal', 'carelink_oi_ack', 'carelink_oi_assignment', 'carelink_oi_day_plan', 'carelink_oi_request_link', 'carelink_oi_followup_link', 'carelink_resource_status'];

  var has = function(list, value) {
    return !!list && list.indexOf(value) !== -1;
  };
  var hasAny = function(roles, wanted) {
    for (var i = 0; i < wanted.length; i++) {
      if (has(roles, wanted[i])) {
        return true;
      }
    }
    return false;
  };
  var isDbAdmin = function() {
    var roles = userCtx.roles || [];
    var admins = (secObj && secObj.admins) || {};
    return has(roles, '_admin') || has(admins.names, userCtx.name) || hasAny(roles, admins.roles || []);
  };
  var carelinkForm = function(doc) {
    return doc && doc.type === 'data_record' && ALLOWED.hasOwnProperty(doc.form) ? doc.form : null;
  };

  var form = carelinkForm(newDoc) || carelinkForm(oldDoc);
  if (isDbAdmin()) {
    return;
  }
  // The planning service account is confined to its own records: nothing else, ever.
  if (has(userCtx.roles || [], SERVICE_ROLE) && (!form || ALLOWED[form].length !== 1 || ALLOWED[form][0] !== SERVICE_ROLE)) {
    throw({ forbidden: 'The planning service may only write Outreach Intelligence plan records.' });
  }
  // Community volunteers register and edit households only: never facilities, communities or people
  // (enrolling individuals for maternal and child care stays with the CHO).
  var STAFF_ROLES = ['carelink_cho', 'carelink_coordinator', 'carelink_supervisor', 'carelink_admin'];
  var isContact = function(doc) {
    return doc && doc.type === 'contact';
  };
  if (has(userCtx.roles || [], 'carelink_community') && !hasAny(userCtx.roles || [], STAFF_ROLES) && (isContact(newDoc) || isContact(oldDoc))) {
    if (newDoc._deleted || newDoc.contact_type !== 'carelink_household' || (oldDoc && oldDoc.contact_type !== 'carelink_household')) {
      throw({ forbidden: 'Community volunteers can only add or edit households.' });
    }
  }
  if (!form) {
    return;
  }
  if (newDoc._deleted) {
    throw({ forbidden: 'CareLink records cannot be deleted by app users.' });
  }
  if (oldDoc && carelinkForm(oldDoc) !== carelinkForm(newDoc)) {
    throw({ forbidden: 'The form of a CareLink record cannot be changed.' });
  }
  if (oldDoc && has(APPEND_ONLY, form)) {
    throw({ forbidden: 'CareLink coordination records are append-only; submit a new event instead.' });
  }
  if (!hasAny(userCtx.roles || [], ALLOWED[form])) {
    throw({ forbidden: 'Your role is not authorised to submit ' + form + '.' });
  }
  if (has(ACTOR_STAMPED, form) && (!newDoc.fields || newDoc.fields.actor !== userCtx.name)) {
    throw({ forbidden: 'The record must name its author (fields.actor) as the signed-in user.' });
  }
  if (form === 'carelink_oi_review') {
    var action = newDoc.fields && newDoc.fields.action;
    if (!has(['submit', 'review', 'approve', 'reject'], action)) {
      throw({ forbidden: 'Unknown Outreach Intelligence decision.' });
    }
    if (action !== 'submit' && !has(userCtx.roles || [], 'carelink_supervisor')) {
      throw({ forbidden: 'Only a facility supervisor can review, approve or reject an outreach plan.' });
    }
  }
  if (form === 'carelink_mch_referral') {
    var state = newDoc.fields && newDoc.fields.state;
    if (!REFERRAL_ROLES.hasOwnProperty(state) || !hasAny(userCtx.roles || [], REFERRAL_ROLES[state])) {
      throw({ forbidden: 'Your role is not authorised to record this referral state.' });
    }
  }
}
