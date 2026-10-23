'use strict';
/*
  Generates the community volunteer forms (npm run build-volunteer-forms) from planning/tolon-district.json:
  - carelink_household create/edit: a volunteer registers a household in their own community. The
    responsible CHO is the CHO who covers that community unless one is chosen, so CHO tasks and
    outreach planning work for households the volunteer adds.
  - carelink_household_contact: the volunteer records a non-clinical outcome of contacting a household
    about its open request. It never changes the request's coordination state; only the facility does.
*/
const fs = require('node:fs');
const path = require('node:path');
const district = require('../planning/tolon-district.json');

const root = path.join(__dirname, '..', 'forms');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const items = list => list.map(([value, label]) => `<item><label>${esc(label)}</label><value>${esc(value)}</value></item>`).join('');
const NOTICE = 'CareLink Reach. Saving a record does not confirm delivery. Check the CHT sync indicator. This is outreach coordination, not emergency care: anyone with danger signs follows referral procedures now and never waits for a request.';

const chos = district.facilities.flatMap(f => f.people.filter(p => p.role === 'carelink_cho').map(p => ({ ...p, facility: f.name })));
const choFor = Object.fromEntries(chos.flatMap(c => c.communities.map(id => [id, c.id])));
// XPath if-chains over the configured communities and CHOs. The signed-in user's community comes from their
// own contact summary (carelink_facility_id: the parent place); CHT does not bind user place lists into inputs.
const chain = (pairs, fallback = "''") => pairs.reduceRight((rest, [test, value]) => `if(${test}, ${value}, ${rest})`, fallback);
const defaultCho = chain(Object.entries(choFor).map(([community, cho]) => [`instance('user-contact-summary')/context/carelink_facility_id = '${community}'`, `'${cho}'`]));
const choName = chain(chos.map(c => [`/data/carelink_household/responsible_worker_id = '${c.id}'`, `'${esc(c.name)}'`]));

function household(mode) {
  const h = '/data/carelink_household';
  const create = mode === 'create';
  // On create the CHO is calculated from the volunteer's community unless one is chosen; on edit it is chosen directly.
  const choice = create ? '/data/responsible_worker_choice' : `${h}/responsible_worker_id`;
  const choBinds = create ? `<bind nodeset="${choice}" type="string" required="(${defaultCho}) = ''" jr:requiredMsg="Choose the responsible CHO."/>
<bind nodeset="${h}/responsible_worker_id" type="string" calculate="if(${choice} != '', ${choice}, ${defaultCho})"/>
<bind nodeset="${h}/registered_by" type="string" calculate="once(/data/inputs/user/contact_id)"/>` : `<bind nodeset="${choice}" type="string" required="true()"/>`;
  return `<?xml version="1.0"?>
<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml" xmlns:jr="http://openrosa.org/javarosa" xmlns:odk="http://www.opendatakit.org/xforms"><h:head><h:title>${create ? 'Add household' : 'Edit household'}</h:title><model odk:xforms-version="1.0.0"><instance><data id="contact:carelink_household:${mode}" version="2026-10-22"><inputs><user><contact_id/></user></inputs>${create ? '<responsible_worker_choice/>' : ''}<carelink_household><name/><external_id/><responsible_worker_id/><responsible_worker_name/>${create ? '<registered_by/>' : ''}<parent/><type>contact</type><contact_type>carelink_household</contact_type></carelink_household><meta><instanceID/></meta></data></instance><instance id="user-contact-summary"/>
<bind nodeset="${h}/name" type="string" required="true()" constraint="string-length(normalize-space(.)) &gt;= 2" jr:constraintMsg="Enter the household name."/>
<bind nodeset="${h}/external_id" type="string"/>
${choBinds}
<bind nodeset="${h}/responsible_worker_name" type="string" calculate="${choName}"/>
<bind nodeset="${h}/parent" type="string"/>
<bind nodeset="/data/meta/instanceID" type="string" readonly="true()" jr:preload="uid"/>
</model></h:head><h:body><input ref="${h}/name"><label>Household name</label><hint>Use the name the household is known by in the community.</hint></input><input ref="${h}/external_id"><label>Household reference (optional)</label><hint>A house number or local reference helps avoid registering the same household twice.</hint></input><select1 ref="${choice}"><label>${create ? 'Responsible CHO (optional)' : 'Responsible CHO'}</label><hint>${create ? 'Leave blank to use the CHO who covers your community. Choose only if the facility has told you to.' : 'Change only if the facility has told you to.'}</hint>${items(chos.map(c => [c.id, `${c.name} (${c.facility})`]))}</select1></h:body></h:html>
`;
}

const contactOutcome = `<?xml version="1.0"?>
<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml" xmlns:jr="http://openrosa.org/javarosa" xmlns:odk="http://www.opendatakit.org/xforms"><h:head><h:title>Record household contact</h:title><model odk:xforms-version="1.0.0"><instance><data id="carelink_household_contact" version="2026-10-22"><inputs><source>user</source><source_id/><contact><_id/><name/><parent><_id/><name/></parent></contact><user><contact_id/><name/></user></inputs><patient_id/><household_name/><community_name/><created_by/><request_id/><contact_date/><outcome/><note/><notice/><meta><instanceID/></meta></data></instance><instance id="contact-summary"/>
<bind nodeset="/data/patient_id" type="string" required="true()" calculate="/data/inputs/contact/_id"/>
<bind nodeset="/data/household_name" type="string" calculate="/data/inputs/contact/name"/>
<bind nodeset="/data/community_name" type="string" calculate="/data/inputs/contact/parent/name"/>
<bind nodeset="/data/created_by" type="string" calculate="/data/inputs/user/contact_id"/>
<bind nodeset="/data/request_id" type="string" required="true()" calculate="instance('contact-summary')/context/latest_open_request_id"/>
<bind nodeset="/data/contact_date" type="date" required="true()" jr:preload="date" jr:preloadParams="today" constraint=". &lt;= today()" jr:constraintMsg="The contact date cannot be in the future."/>
<bind nodeset="/data/outcome" type="string" required="true()"/>
<bind nodeset="/data/note" type="string" required="/data/outcome = 'other'" constraint="string-length(.) &lt;= 240" jr:constraintMsg="Keep the note under 240 characters."/>
<bind nodeset="/data/notice" readonly="true()"/>
<bind nodeset="/data/meta/instanceID" type="string" readonly="true()" jr:preload="uid"/>
</model></h:head><h:body><input ref="/data/notice"><label>${esc(NOTICE)}</label></input><input ref="/data/contact_date"><label>When did you contact the household?</label></input><select1 ref="/data/outcome"><label>What happened?</label>${items([
  ['informed_of_visit', 'Told the household about a planned or confirmed visit'],
  ['reached_no_update', 'Reached the household; nothing new to report'],
  ['not_reached', 'Could not reach the household'],
  ['no_longer_needed', 'The household says help is no longer needed'],
  ['moved', 'The household has moved away'],
  ['other', 'Other'],
])}</select1><input ref="/data/note"><label>Note for the facility</label><hint>Non-clinical only: no symptoms, diagnoses or treatment details. The facility decides any change to the request.</hint></input></h:body></h:html>
`;

fs.writeFileSync(path.join(root, 'contact', 'carelink_household-create.xml'), household('create'));
fs.writeFileSync(path.join(root, 'contact', 'carelink_household-edit.xml'), household('edit'));
fs.writeFileSync(path.join(root, 'app', 'carelink_household_contact.xml'), contactOutcome);
fs.writeFileSync(path.join(root, 'app', 'carelink_household_contact.properties.json'), JSON.stringify({
  title: 'Record household contact', icon: 'carelink-followup',
  context: { person: false, place: true, permission: 'can_carelink_request',
    expression: "contact.contact_type === 'carelink_household' && user.carelink_role === 'carelink_community' && summary.open_requests > 0" },
}, null, 2) + '\n');
console.log('Wrote the household contact forms and carelink_household_contact');
