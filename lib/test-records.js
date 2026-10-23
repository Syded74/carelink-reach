'use strict';
/*
  Records created by the browser regression flows look like real ones (no visible tags), so each
  household or person a test creates carries record_origin: 'test'. Nothing displays it; demand
  exports, forecasts and supervisor indicators leave those contacts, their descendants and every
  report about them out of service counts.
*/
const TEST_ORIGIN = 'test';

function testContactIds(docs) {
  const contacts = new Map(docs.filter(d => d && d.type === 'contact').map(d => [d._id, d]));
  const ids = new Set();
  for (const contact of contacts.values()) {
    const seen = new Set();
    for (let c = contact; c && !seen.has(c._id); c = c.parent && contacts.get(c.parent._id)) {
      seen.add(c._id);
      if (c.record_origin === TEST_ORIGIN) { ids.add(contact._id); break; }
    }
  }
  return ids;
}

function withoutTestRecords(docs) {
  const tests = testContactIds(docs);
  const subject = d => d.fields && (d.fields.patient_id || d.fields.place_id);
  return docs.filter(d => d && !(d.type === 'contact' ? tests.has(d._id) : d.type === 'data_record' && tests.has(subject(d))));
}

module.exports = { TEST_ORIGIN, testContactIds, withoutTestRecords };
