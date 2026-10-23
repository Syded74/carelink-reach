'use strict';
// Report views: every saved field has a plain-language label, internal plumbing is hidden from new reports,
// and nothing a person needs to read (or that the rules rely on being visible) is hidden. See scripts/build-report-labels.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const messages = fs.readFileSync(path.join(root, 'translations', 'messages-en.properties'), 'utf8');
const forms = fs.readdirSync(path.join(root, 'forms', 'app')).filter(f => f.endsWith('.xml'));
const xml = name => fs.readFileSync(path.join(root, 'forms', 'app', name), 'utf8');
const instanceOf = text => text.slice(text.indexOf('<instance><data'), text.indexOf('</data></instance>'));
const topLevel = text => [...instanceOf(text).replace(/<inputs>[\s\S]*?<\/inputs>/, '').matchAll(/<([A-Za-z_][\w.-]*)([^>]*?)\/?>/g)].map(m => ({ name: m[1], hidden: /tag="hidden"/.test(m[2]) }));

test('every report field has a plain-language label, never the raw key', () => {
  for (const file of forms) {
    const form = file.replace('.xml', '');
    for (const { name } of topLevel(xml(file)).filter(f => !['data', 'instance'].includes(f.name))) {
      const line = messages.split('\n').find(l => l.startsWith(`report.${form}.${name} = `) || l.includes(`.${name} = `) && l.startsWith(`report.${form}.`));
      assert.ok(line, `missing label for ${form}.${name}`);
      assert.doesNotMatch(line.split(' = ')[1], /report\.|_id\b/, `${form}.${name} label is technical`);
    }
  }
  assert.match(messages, /report\.carelink_coordination\.patient_id = Patient reference/);
  assert.match(messages, /report\.carelink_coordination\.current_status = Request status/);
  assert.match(messages, /report\.carelink_cwc_visit\.approval_status = Clinical review status/);
});

test('internal identifiers and metadata are hidden from new reports; what people read is not', () => {
  for (const file of forms) {
    const fields = topLevel(xml(file));
    const hidden = new Set(fields.filter(f => f.hidden).map(f => f.name));
    if (fields.some(f => f.name === 'meta')) { assert.ok(hidden.has('meta'), `${file}: meta visible`); }
    for (const name of ['created_by', 'expected_event', 'request_id']) {
      if (fields.some(f => f.name === name)) { assert.ok(hidden.has(name), `${file}: ${name} visible`); }
    }
    for (const name of ['patient_id', 'approval_status', 'status', 'state', 'reason', 'outcome_note', 'danger_signs', 'visit_date', 'follow_up_date']) {
      assert.ok(!hidden.has(name), `${file}: ${name} must stay visible`);
    }
  }
  // Hidden only in the view: the saved instance still contains every field.
  assert.match(instanceOf(xml('carelink_mch_referral.xml')), /<referral_id tag="hidden"\/>/);
});

test('the coordination record shows who was assigned by name', () => {
  assert.match(xml('carelink_coordination.xml'), /jr:choice-name\(\/data\/assigned_worker_id/);
});

test('task titles are specific and plain; urgent concerns are distinct from routine work', () => {
  for (const [key, text] of [['carelink.task.mch.follow_up.anc', 'ANC follow-up due'], ['carelink.task.mch.follow_up.cwc', 'Child welfare visit due'],
    ['carelink.task.visit', 'Household visit planned'], ['carelink.task.mch.referral', 'Referral needs follow-up'],
    ['carelink.task.mch.recorded_concern', 'Clinical concern — professional review required']]) {
    assert.ok(messages.includes(`${key} = ${text}`), key);
  }
  const tasks = fs.readFileSync(path.join(root, 'tasks.js'), 'utf8');
  for (const stage of ['anc', 'pnc', 'cwc']) {
    for (const kind of ['first_visit', 'missing_assessment', 'follow_up']) { assert.ok(messages.includes(`carelink.task.mch.${kind}.${stage} = `), `${kind}.${stage}`); }
  }
  assert.match(tasks, /concernPriority = \{ level: 'high'/);
});
