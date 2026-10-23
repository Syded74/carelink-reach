'use strict';
// Role-oriented presentation (docs/product/CHPS_WEEKLY_FIELD_WORKFLOW.md): the CHO's outreach day shows its integrated
// services; "not completed" counts only visits recorded as could-not-complete; labels stay plain.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tasks = require('../tasks');
const targets = require('../targets');
const messages = fs.readFileSync(path.join(__dirname, '..', 'translations', 'messages-en.properties'), 'utf8');

test('the CHO outreach-day task names the services the day takes on', () => {
  const day = tasks.find(t => t.name === 'carelink-oi-outreach-day');
  const r = { fields: { community_name: 'Dimabi', items_planned: 9, served_by_type: { anc: 3, pnc: 2, cwc: 4 } } };
  assert.equal(day.contactLabel({}, r), 'Dimabi · 9 visit(s): ANC 3 · PNC 2 · CWC 4');
  assert.equal(day.contactLabel({}, { fields: { community_name: 'Tolon', items_planned: 1 } }), 'Tolon · 1 visit(s)');
});

test('household visits not completed are counted from the recorded outcome only', () => {
  const t = targets.find(x => x.id === 'carelink-visits-not-completed');
  const c = { contact: { _id: 'h' }, reports: [] };
  assert.ok(t.appliesIf(c, { fields: { status: 'unable_to_complete' } }));
  assert.ok(!t.appliesIf(c, { fields: { status: 'completed' } }));
  assert.ok(!t.appliesIf({ contact: { _id: 'h', record_origin: 'test' }, reports: [] }, { fields: { status: 'unable_to_complete' } }));
});

test('plain labels for each role', () => {
  for (const line of ['carelink.request_status = Request status', 'carelink.target.requests = Requests submitted',
    'carelink.target.reviewed = Requests reviewed by the facility', 'carelink.target.unresolved = Requests still open',
    'carelink.target.completed-encounters = Visits recorded completed', 'carelink.target.visits-not-completed = Household visits not completed']) {
    assert.ok(messages.includes(line), line);
  }
});

test('volunteer totals count requests and household contacts, leave out test households, and follow the chosen period', async () => {
  const vm = require('node:vm');
  class Element { constructor() { this.children = []; } append(v) { this.children.push(v); } setAttribute() {} addEventListener() {} attachShadow() { return this; } }
  const sandbox = { module: { exports: {} }, oiWorkflow: require('../lib/oi-workflow'), oiLinks: require('../lib/oi-links'), oiMch: require('../lib/mch'),
    oiRequests: require('../lib/workflow'), HTMLElement: Element, Node: Element, navigator: { onLine: true }, document: { createElement: () => new Element() },
    window: { addEventListener() {}, removeEventListener() {} }, setInterval: () => 1, clearInterval() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'ui-extensions-src', 'carelink-outreach-intelligence.js'), 'utf8'), sandbox);
  const e = new sandbox.module.exports();
  const now = Date.now(), old = now - 60 * 86400000;
  const rep = (id, form, patient, at, extra = {}) => ({ _id: id, form, reported_date: at, contact: { _id: 'carelink-person-aiddrisu' },
    fields: { patient_id: patient, created_by: 'carelink-person-aiddrisu', community_name: 'Tolon', ...extra } });
  const docs = [
    rep('r1', 'carelink_request', 'h1', now), rep('r2', 'carelink_request', 'h-test', now), rep('r3', 'carelink_request', 'h1', old),
    rep('c1', 'carelink_household_contact', 'h1', now, { request_id: 'r1' }), rep('c2', 'carelink_household_contact', 'h-test', now),
  ];
  const all = e.progressOf([], null, docs, new Set(['h-test']), 'all').volunteers.aiddrisu;
  assert.equal(all.submitted, 2, 'the test household request is left out');
  assert.equal(all.contacts, 1);
  const recent = e.progressOf([], null, docs, new Set(['h-test']), '4w').volunteers.aiddrisu;
  assert.equal(recent.submitted, 1, 'the 60-day-old request is outside the last 4 weeks');
  assert.equal(recent.contacts, 1);
});
