'use strict';
/*
  Makes CHT report views readable (npm run build-report-labels; also runs before npm run deploy):
   1. writes plain-language report.<form>.<path> labels into translations/messages-en.properties
      (between the GENERATED markers), from lib/report-labels.js, else the form's own question label;
   2. marks internal fields tag="hidden" in each XForm's primary instance, so new reports list them in
      hidden_fields and CHT leaves them out of the report view (the data is still saved);
   3. labels a few key fields of the service-written JSON forms in app_settings/base_settings.json.
  Idempotent: safe to run after any form builder.
*/
const fs = require('node:fs');
const path = require('node:path');
const { LABELS, HIDDEN, SERVER_FIELDS, humanise } = require('../lib/report-labels');

const root = path.join(__dirname, '..');
const FORMS = path.join(root, 'forms', 'app');
const MESSAGES = path.join(root, 'translations', 'messages-en.properties');
const SETTINGS = path.join(root, 'app_settings', 'base_settings.json');
const START = '# --- GENERATED report labels (scripts/build-report-labels.js) ---';
const END = '# --- END GENERATED report labels ---';
const unescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const shorten = s => { const t = unescape(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); return t.length > 70 ? t.slice(0, 67).replace(/\s+\S*$/, '') + '…' : t; };

// Paths (relative to /data) of every element in the primary instance, skipping inputs; and the instance text span.
function instance(xml) {
  const open = xml.indexOf('<instance><data');
  const close = xml.indexOf('</data></instance>', open);
  const span = [open + '<instance>'.length, close + '</data>'.length];
  const paths = [];
  const stack = [];
  const re = /<(\/?)([\w:.-]+)([^>]*?)(\/?)>/g;
  re.lastIndex = span[0];
  let m;
  while ((m = re.exec(xml)) && m.index < span[1]) {
    const [, closing, name, , selfClosing] = m;
    if (closing) { stack.pop(); continue; }
    if (name === 'data' && !stack.length) { stack.push(name); continue; }
    const p = [...stack.slice(1), name].join('.');
    if (!p.startsWith('inputs')) { paths.push(p); }
    if (!selfClosing) { stack.push(name); }
  }
  return { paths, span };
}

// Question labels by path, from the body (<input|select1|select ref="/data/a/b"><label>…</label>, groups too).
function questionLabels(xml) {
  const labels = {};
  const re = /<(?:input|select1|select|group|upload|trigger) ref="\/data\/([^"]+)"[^>]*><label>([\s\S]*?)<\/label>/g;
  let m;
  while ((m = re.exec(xml))) { labels[m[1].replace(/\//g, '.')] = shorten(m[2]); }
  return labels;
}

function labelFor(form, p, questions) {
  const name = p.split('.').pop();
  const dict = LABELS[`${form}.${p}`] || LABELS[p] || LABELS[name];
  if (dict) { return dict; }
  const suffix = name.match(/^(.*)_(state|unverified|unknown)$/);
  if (suffix) {
    const base = p.replace(/_(state|unverified|unknown)$/, '');
    const baseLabel = questions[base] || humanise(suffix[1]);
    return `${baseLabel} — ${{ state: 'documentation status', unverified: 'reported, not verified', unknown: 'marked unknown' }[suffix[2]]}`;
  }
  return questions[p] || humanise(name);
}

// Display-only notes: bound read-only with no calculation (section notes, range warnings, notices).
function notePaths(xml) {
  const paths = new Set();
  const re = /<bind ([^>]*?)\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const nodeset = (attrs.match(/nodeset="\/data\/([^"]+)"/) || [])[1];
    if (nodeset && /readonly="true\(\)"/.test(attrs) && !/calculate=/.test(attrs) && !/preload=/.test(attrs)) { paths.add(nodeset.replace(/\//g, '.')); }
  }
  return paths;
}

// A documentation answer's companions (lib/mch-fields answer states): its "documentation status", "Unknown" and
// "Reported, not verified" values. Saved with every visit and used by the rules; hidden from the report view only.
const COMPANION = /_(state|unknown|unverified)$/;

// Adds tag="hidden" to hidden elements of the primary instance (not inside inputs).
function hide(xml, span) {
  const notes = notePaths(xml);
  let depth = [];
  const re = /<(\/?)([\w:.-]+)([^>]*?)(\/?)>/g;
  re.lastIndex = span[0];
  let out = xml.slice(0, span[0]);
  let last = span[0];
  let m;
  while ((m = re.exec(xml)) && m.index < span[1]) {
    const [whole, closing, name, attrs, selfClosing] = m;
    if (closing) { depth.pop(); continue; }
    const inInputs = depth.includes('inputs') || name === 'inputs';
    const p = [...depth.slice(1), name].join('.');
    if (!inInputs && depth.length && (HIDDEN.includes(name) || notes.has(p) || COMPANION.test(name)) && !/\btag=/.test(attrs)) {
      out += xml.slice(last, m.index) + `<${name}${attrs} tag="hidden"${selfClosing}>`;
      last = m.index + whole.length;
    }
    if (!selfClosing) { depth.push(name); }
  }
  return out + xml.slice(last);
}

const lines = [];
const files = fs.readdirSync(FORMS).filter(f => f.endsWith('.xml')).sort();
let hiddenCount = 0;
for (const file of files) {
  const form = file.replace(/\.xml$/, '');
  let xml = fs.readFileSync(path.join(FORMS, file), 'utf8');
  const { paths, span } = instance(xml);
  const questions = questionLabels(xml);
  const updated = hide(xml, span);
  hiddenCount += (updated.match(/tag="hidden"/g) || []).length;
  if (updated !== xml) { fs.writeFileSync(path.join(FORMS, file), updated); xml = updated; }
  for (const p of paths) { lines.push(`report.${form}.${p} = ${labelFor(form, p, questions)}`); }
}
for (const [form, fields] of Object.entries(SERVER_FIELDS)) {
  for (const [p, label] of Object.entries(fields)) { lines.push(`report.${form}.${p} = ${label}`); }
}

const messages = fs.readFileSync(MESSAGES, 'utf8');
const kept = messages.includes(START) ? messages.slice(0, messages.indexOf(START)).trimEnd() + messages.slice(messages.indexOf(END) + END.length) : messages.trimEnd();
fs.writeFileSync(MESSAGES, `${kept.trimEnd()}\n${START}\n${[...new Set(lines)].join('\n')}\n${END}\n`);

// Service-written records use JSON forms: label the key fields only (CHT shows nothing else for them).
const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
for (const [form, fields] of Object.entries(SERVER_FIELDS)) {
  if (!settings.forms || !settings.forms[form]) { continue; }
  settings.forms[form].fields = Object.fromEntries(Object.entries(fields).map(([key, label], position) => [key, {
    labels: { short: { translation_key: `report.${form}.${key}` }, tiny: key }, position, type: 'string', required: false,
  }]));
}
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`${lines.length} report labels; ${hiddenCount} hidden fields across ${files.length} forms`);
