'use strict';
// The demonstration facility's observed CHPS week (docs/product/CHPS_WEEKLY_FIELD_WORKFLOW.md): configured, not hardcoded;
// the plan request defaults to the facility's next outreach day; the volunteer request keeps urgent cases out of routine requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const district = require('../planning/tolon-district.json');
const form = name => fs.readFileSync(path.join(root, 'forms', 'app', `${name}.xml`), 'utf8');

test('the observed weekly schedule is configuration for one facility, recommended rather than enforced', () => {
  const tolon = district.facilities.find(f => f.id === 'carelink-facility-tolon-hospital');
  assert.deepEqual(tolon.outreach_calendar.days, {
    mon: 'static services', tue: 'outreach', wed: 'defaulter tracing and home visits', thu: 'static services', fri: 'school health services',
  });
  assert.equal(tolon.outreach_calendar.enforced, false);
  assert.match(tolon.outreach_calendar.source, /observed at Kalpohini CHPS/);
  assert.match(tolon.outreach_calendar.source, /not a national Ghana Health Service rule/);
});

test('the plan request shows the facility\'s next outreach day and notes other weekdays, without forcing either', () => {
  const xml = form('carelink_oi_request');
  const suggested = xml.match(/<bind nodeset="\/data\/suggested_date" type="string" calculate="([^"]+)"\/>/);
  assert.ok(suggested, 'no suggested outreach day');
  assert.match(suggested[1], /carelink-facility-tolon-hospital/);
  assert.match(suggested[1], /\(\(2 - /, 'Tuesday (weekday 2) for the demonstration facility');
  assert.match(xml, /next scheduled outreach day is <output value="\/data\/suggested_date"\/>/);
  assert.match(xml, /nodeset="\/data\/off_schedule_note" readonly="true\(\)" relevant="/);
  assert.match(xml, /nodeset="\/data\/planning_date" type="date" required="true\(\)" constraint="\. &gt;= today\(\)"/);
  assert.doesNotMatch(xml, /<setvalue/);
});

test('the volunteer request is for routine needs; urgent concerns go directly to the CHO or facility', () => {
  const xml = form('carelink_request');
  assert.match(xml, /You do not need to assess anyone&#39;s health|You do not need to assess anyone's health/);
  assert.match(xml, /Urgent or serious concern\? Contact the CHO or the facility directly now/);
});
