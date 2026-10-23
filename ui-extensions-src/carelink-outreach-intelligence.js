/*
  CareLink Reach — Outreach Intelligence tab (CHT 5.3 UI extension; built by scripts/build-oi-extension.js).
  Reads only records already on this device (cht.v1.report), so previously synchronised plans stay
  readable offline. It never writes: generating a plan opens the CHT request form, and decisions
  are recorded through CHT tasks, which stamp the signed-in user. Status shown here comes from the
  server's acknowledgements (lib/oi-workflow.js), never from the device's own guess.

  Layout (docs/OUTREACH_FIRST_PRODUCT_REFINEMENT.md): an "at a glance" card answering the five coordinator
  questions, then four sections — Needs, Resources, Outreach plan, Progress — one shown at a time. Reasoning,
  assumptions, decision history and technical details sit behind "details" disclosures. Every section stays in
  the page (hidden, not removed), so offline reading and the regression flows see the same records.
*/
/* global oiWorkflow, oiLinks, oiMch, oiRequests */
const F = oiWorkflow.FORMS;
const STYLE = `
:host { --primary:#007AC0; --accent:#007AC0; --mint:#F2F2F2; --bg:#F2F2F2; --text:#333333; --muted:#777777; --line:#E0E0E0; --warn-bg:#FCF6E7; --warn:#8a5300; --err:#E33030; --ok-bg:#E6F2EA; --ok:#1E6B3A;  /* CHT webapp palette (private-vars.less) */
  display:block; color:var(--text); background:var(--bg); font:15px/1.5 inherit; padding:12px 16px 40px; min-height:100%; box-sizing:border-box; max-width:880px; }
h2 { font-size:19px; margin:18px 0 8px; } h3 { font-size:16px; margin:0 0 6px; }
.card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin:10px 0; }
.note { background:var(--mint); border-radius:8px; padding:8px 12px; font-size:14px; }
.warn { background:var(--warn-bg); color:var(--warn); border-radius:8px; padding:8px 12px; margin:6px 0; font-size:14px; }
.good { background:var(--ok-bg); color:var(--ok); border-radius:8px; padding:8px 12px; margin:6px 0; font-size:14px; }
.muted { color:var(--muted); font-size:14px; }
table { width:100%; border-collapse:collapse; background:#fff; font-size:14px; }
th, td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { background:var(--mint); } td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
.wrap { overflow-x:auto; }
button { font:inherit; font-weight:600; min-height:44px; padding:8px 16px; border-radius:8px; border:0; background:var(--accent); color:#fff; cursor:pointer; }
button.ghost { background:#fff; color:var(--primary); border:1px solid var(--primary); }
button:focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
.row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.chip { display:inline-block; padding:2px 10px; border-radius:999px; font-size:13px; font-weight:600; background:var(--mint); color:var(--primary); }
.chip.pending { background:var(--warn-bg); color:var(--warn); } .chip.bad { background:#fde8e6; color:var(--err); }
.chip.ok { background:var(--primary); color:#fff; }
ul { padding-left:20px; margin:6px 0; }
.plans button { margin:0 6px 6px 0; }
details { background:#fff; border:1px solid var(--line); border-radius:10px; margin:10px 0; padding:0 14px; }
details[open] { padding-bottom:12px; }
summary { cursor:pointer; font-weight:600; padding:12px 0; min-height:24px; }
.facts { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:8px 16px; margin:8px 0; }
.facts div span { display:block; color:var(--muted); font-size:13px; } .facts div strong { font-size:17px; }
.tabs { display:grid; grid-template-columns:repeat(4, 1fr); gap:6px; margin:12px 0 4px; position:sticky; top:0; background:var(--bg); padding:6px 0; z-index:1; }
.tabs button { padding:8px 4px; font-size:14px; }
.glance { list-style:none; padding:0; margin:0; }
.glance li { border-top:1px solid var(--line); }
.glance li:first-child { border-top:0; }
.glance button { display:block; width:100%; text-align:left; background:none; color:var(--text); font-weight:400; padding:10px 0; border-radius:0; }
.glance b { display:block; font-size:13px; color:var(--muted); font-weight:600; }
.item { border-top:1px solid var(--line); padding:8px 0; } .item:first-of-type { border-top:0; }
.title { font-size:22px; margin:4px 0 8px; }
section { scroll-margin-top:72px; }
.line { display:flex; justify-content:space-between; gap:12px; } .line span:first-child { color:var(--muted); }
`;
// Plain-language readiness status (stored codes are unchanged; simulated values are never presented as confirmed stock).
const READINESS = { confirmed: 'Available', insufficient: 'Not enough', unavailable: 'Not available', unknown: 'Needs confirmation',
  stale: 'Resource needs an updated check', simulated: 'Planning estimate (not confirmed)' };
// Progress periods: counted by outreach day (approved plans) or by record date (volunteer requests and contacts).
const PERIODS = { '4w': 'Last 4 weeks', month: 'This month', all: 'All time' };
const SECTIONS = [['needs', 'Needs'], ['resources', 'Resources'], ['plan', 'Plan'], ['progress', 'Progress']];
const TYPE = { request: 'Household requests', anc: 'ANC', pnc: 'PNC', cwc: 'Child welfare' };
// Plain names for follow-up kinds (lib/mch.js task kinds); stored codes are unchanged.
const KIND = { firstVisit: 'first visit', missingAssessment: 'missing measurements', scheduledFollowUp: 'follow-up', appointmentDue: 'appointment due',
  missedAppointment: 'missed appointment', recordedConcern: 'recorded concern', referralFollowUp: 'referral follow-up' };
const followUpLabel = r => `${r.category} · ${KIND[r.kind] || r.kind}`;
const REFERRAL = { created: 'Awaiting acknowledgement', acknowledged: 'Acknowledged', arrival_confirmed: 'Arrival confirmed',
  outcome_recorded: 'Outcome recorded', unresolved: 'Unresolved' };

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v === null || v === undefined || v === false) { return; }
    if (k.startsWith('on')) { el.addEventListener(k.slice(2), v); } else if (k === 'class') { el.className = v; } else { el.setAttribute(k, v); }
  });
  children.flat().forEach(c => { if (c !== null && c !== undefined && c !== false) { el.append(c instanceof Node ? c : String(c)); } });
  return el;
}
const when = ms => ms ? new Date(ms).toLocaleString() : '—';
const ago = ms => {
  if (!ms) { return 'never'; }
  const min = Math.round((Date.now() - ms) / 60000);
  return min < 2 ? 'just now' : min < 90 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const days = list => {
  const set = DAYS.filter(d => (list || []).includes(d));
  const name = d => d.charAt(0).toUpperCase() + d.slice(1);
  return set.join() === 'mon,tue,wed,thu,fri' ? 'Mon–Fri' : set.map(name).join(', ') || 'No days set';
};
// Plan status as confirmed by the server (lib/oi-workflow.js). Decisions not yet confirmed are flagged separately.
const STATE = { draft: 'Draft', proposed: 'Awaiting review', reviewed: 'Awaiting approval', approved: 'Approved', rejected: 'Rejected' };
const unique = list => [...new Set(list)].join(', ') || '—';
// The facility's next configured outreach day (today included) and its weekly schedule, from the planning configuration.
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const nextOutreach = calendar => {
  const days = (calendar && calendar.days) || {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + i * 86400000);
    if (days[WEEKDAY_KEYS[d.getDay()]] === 'outreach') { return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); }
  }
  return null;
};
const schedule = calendar => Object.entries((calendar && calendar.days) || {}).map(([d, a]) => `${WEEKDAY_NAMES[d] || d}: ${a}`).join(' · ');
const line = (label, value) => h('div', { class: 'line' }, h('span', {}, label), h('strong', {}, value));

class CareLinkOutreachIntelligence extends HTMLElement {
  connectedCallback() {
    this.root = this.attachShadow ? (this.shadowRoot || this.attachShadow({ mode: 'open' })) : this;
    this.selected = null;
    this.followLatest = true;
    this.section = null;
    this.period = 'all';
    this.refresh = () => this.load().catch(e => {
      if (!this.rendered) { this.show([h('div', { class: 'warn', role: 'alert' }, `Could not read plans on this device: ${e.message}`)]); }
    });
    this.refresh();
    // CHT replicates records independently of this custom element. Re-read the local
    // datasource so server acknowledgements arriving after mount become visible.
    this.timer = setInterval(this.refresh, 5000);
    window.addEventListener('online', this.refresh);
    window.addEventListener('offline', this.refresh);
  }

  disconnectedCallback() {
    clearInterval(this.timer);
    window.removeEventListener('online', this.refresh);
    window.removeEventListener('offline', this.refresh);
  }

  async reports(forms) {
    const ids = [];
    for await (const id of this.cht.v1.report.getUuidsByForms(forms)) { ids.push(id); }
    if (!ids.length) { return []; }
    const docs = [];
    for await (const doc of this.cht.v1.report.getByIds(ids)) { docs.push(doc); }
    return docs;
  }

  // Households created by automated tests (record_origin 'test'), so volunteer totals leave them out.
  async testHouseholds() {
    const ids = new Set();
    try {
      for await (const c of this.cht.v1.contact.getByType('carelink_household')) { if (c.record_origin === 'test') { ids.add(c._id); } }
    } catch (e) { /* contact lookup unavailable: totals still exclude reports marked as test */ }
    return ids;
  }

  // The Progress figures as a CSV file (opens a download in a browser).
  download(progress) {
    const q = v => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
    const rows = [['CareLink Reach outreach summary', PERIODS[this.period], new Date().toISOString().slice(0, 10)], [],
      ['By community', 'Visits assigned', 'Completed and documented', 'Partly done', 'Could not complete', 'Still outstanding', 'Last documented outreach'],
      ...Object.entries(progress.byCommunity).map(([n, t]) => [n, t.assigned, t.completed, t.partly, t.unable, t.outstanding, t.last || '']), [],
      ['By health worker', 'Outreach days', 'Visits assigned', 'Completed and documented', 'Partly done', 'Could not complete', 'Still outstanding'],
      ...Object.entries(progress.byWorker).map(([n, t]) => [n, t.days, t.assigned, t.completed, t.partly, t.unable, t.outstanding]), [],
      ['By community volunteer', 'Requests submitted', 'Requests reviewed', 'Requests still open', 'Household contacts recorded', 'Communities supported'],
      ...Object.entries(progress.volunteers).map(([n, v]) => [n, v.submitted, v.reviewed, v.open, v.contacts, [...v.communities].join('; ')])];
    const blob = new Blob([rows.map(r => r.map(q).join(',')).join('\n') + '\n'], { type: 'text/csv' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `carelink-outreach-${this.period}-${new Date().toISOString().slice(0, 10)}.csv` });
    this.root.append(a);
    a.click();
    a.remove();
  }

  show(children) {
    this.root.replaceChildren(h('style', {}, STYLE), ...children);
  }

  // Switch section and bring it into view (on a phone the at-a-glance card fills the first screen).
  go(section) {
    // Tapping the section already shown re-renders nothing, so scroll to it directly.
    if (section === this.section && this.rendered) {
      const target = this.root.querySelector(`[data-section="${section}"]`);
      if (target && target.scrollIntoView) { target.scrollIntoView({ block: 'start' }); }
      return;
    }
    this.section = section; this.scrollPending = true; this.load();
  }

  async load() {
    // A tap during a background refresh is queued, not dropped.
    if (this.loading) { this.queued = true; return; }
    this.loading = true;
    try {
    if (!this.rendered) { this.show([h('p', { class: 'muted' }, 'Loading plans stored on this device…')]); }
    const config = (this.inputs && this.inputs.config) || {};
    const context = (this.inputs && this.inputs.userContactSummary) || {};
    // Plan records plus the household requests and visits behind each approved day's progress.
    // Maternal and child records are needed to tell which planned follow-ups were resolved (lib/oi-links.js).
    const docs = await this.reports([...Object.values(F), oiLinks.FORMS.dayPlan, oiLinks.FORMS.link, oiLinks.FORMS.followUpLink, 'carelink_request', 'carelink_coordination', 'carelink_visit',
      'carelink_task_resolution', 'carelink_appointment', 'carelink_anc_visit', 'carelink_pnc_visit', 'carelink_cwc_visit', 'carelink_resource_status', 'carelink_mch_referral', 'carelink_household_contact']);
    const signature = JSON.stringify([this.selected, this.section, this.period, navigator.onLine, docs.map(d => [d._id, d._rev]).sort()]);
    if (this.rendered && signature === this.signature) { return; }
    this.signature = signature;
    const byForm = form => docs.filter(d => d.form === form).sort((a, b) => b.reported_date - a.reported_date);
    const proposals = byForm(F.proposal);
    const serverDocs = docs.filter(d => [F.demand, F.proposal, F.ack, F.assignment].includes(d.form));
    const lastServer = Math.max(0, ...serverDocs.map(d => d.reported_date || 0));
    const demand = byForm(F.demand)[0] || proposals[0];
    const requests = byForm(F.request);
    const planned = new Set(proposals.map(p => p.fields.request_id));
    const waiting = requests.filter(r => !planned.has(r._id));
    const facility = context.carelink_facility_id;
    const role = context.carelink_role;
    const me = context.carelink_contact_id;
    const facilityConfig = (config.facilities || {})[facility] || {};
    const statusOf = p => oiWorkflow.proposalStatus(p, docs);
    // Plans waiting for this user, by the same rule as their CHT tasks (superseded drafts and old test plans drop out).
    const mine = proposals.filter(p => { const next = oiWorkflow.nextActionFor(statusOf(p), me, role); return next && oiWorkflow.actionable(p, docs, next); });
    // A supervisor opens on the plan waiting for their decision; everyone else on the newest plan.
    if ((!this.selected || this.followLatest) && proposals[0]) { this.selected = (role === 'carelink_supervisor' && mine[0] ? mine[0] : proposals[0])._id; }
    if (!this.section) { this.section = role === 'carelink_supervisor' ? 'plan' : 'needs'; }
    const proposal = proposals.find(p => p._id === this.selected);
    this.lastDocs = docs;
    const needs = this.needsOf(demand);
    const resources = this.resourcesOf(facilityConfig, config, docs.filter(d => d.form === 'carelink_resource_status' && d.fields.patient_id === facility && d.record_origin !== 'test'));
    const progress = this.progressOf(proposals, proposal, docs, await this.testHouseholds(), this.period);

    const planButton = p => {
      const st = statusOf(p);
      return h('button', { 'data-proposal-id': p._id, class: p._id === this.selected ? '' : 'ghost', onclick: () => { this.followLatest = false; this.selected = p._id; this.section = 'plan'; this.load(); } },
        `${p.fields.planning_date} · ${STATE[st.state]}${st.pending.length ? ' · pending' : ''}`);
    };
    const section = (name, ...children) => h('section', { 'data-section': name, hidden: this.section === name ? null : 'hidden' }, ...children);

    this.show([
      h('h2', { class: 'title' }, 'Community Outreach'),
      this.freshness(facilityConfig, lastServer),
      this.glance(needs, resources, proposals, statusOf, mine, progress, role),
      h('div', { class: 'tabs', role: 'tablist' }, SECTIONS.map(([name, label]) => h('button', {
        role: 'tab', 'aria-selected': String(this.section === name), class: this.section === name ? '' : 'ghost', onclick: () => this.go(name) }, label))),
      section('needs', this.needsSection(needs, demand, facilityConfig)),
      section('resources', this.resourcesSection(resources, facilityConfig, facility)),
      section('plan',
        h('h2', {}, 'Next scheduled outreach'),
        facilityConfig.calendar ? h('p', { class: 'muted' }, `Weekly schedule — ${schedule(facilityConfig.calendar)}. ` +
          (facilityConfig.calendar.enforced ? 'Routine outreach is planned only on the outreach day.' : 'Recommended, not enforced: a plan for another day carries a calendar warning.')) : null,
        this.decisionCard(mine, statusOf, me, role),
        proposal ? this.planSection(proposal, docs, context, facilityConfig) : h('p', { class: 'muted' }, 'No plans on this device yet.'),
        h('div', { class: 'card' },
          h('div', { class: 'row' },
            h('button', { class: role === 'carelink_coordinator' && !mine.length ? '' : 'ghost', onclick: () => { window.location.hash = `#/contacts/${facility}/report/${F.request}`; } }, 'Generate outreach plan'),
            h('span', { class: 'muted' }, 'Needs a connection: the server runs the optimiser.')),
          waiting.map(r => h('div', { class: 'warn' }, h('span', { class: 'chip pending' }, 'Awaiting server response'),
            ` Plan request for ${r.fields.planning_date} saved ${when(r.reported_date)}: synchronization or server processing may be pending. Delivery is confirmed only when a server proposal arrives.`))),
        proposals.length ? h('details', {}, h('summary', {}, `Other plans (${proposals.length})`), h('div', { class: 'plans' }, proposals.map(planButton))) : null),
      section('progress', this.progressSection(progress, docs)),
    ]);
    this.rendered = true;
    if (this.scrollPending) {
      this.scrollPending = false;
      const target = this.root.querySelector(`[data-section="${this.section}"]`);
      if (target && target.scrollIntoView) { target.scrollIntoView({ block: 'start' }); }
    }
    } finally {
      this.loading = false;
      if (this.queued) { this.queued = false; this.load(); }
    }
  }

  // Offline-first: where the data came from and how fresh it is, plus the standing safety notice, in two short lines.
  freshness(facilityConfig, lastServer) {
    const stale = lastServer && Date.now() - lastServer > 24 * 60 * 60 * 1000;
    return h('div', {},
      h('div', { class: 'note row' }, h('strong', {}, facilityConfig.name || 'No facility'), h('span', { class: 'chip' }, 'Available offline'),
        h('span', { title: when(lastServer) }, lastServer ? `Updated from server ${ago(lastServer)}` : 'Nothing received from the server yet'),
        navigator.onLine ? h('button', { class: 'ghost', onclick: () => this.refresh() }, 'Refresh local records') : null),
      !navigator.onLine ? h('div', { class: 'warn', role: 'status' }, 'Offline — showing previously synchronized records and locally saved decisions. Server decisions appear after the next sync.')
        : stale ? h('div', { class: 'warn', role: 'status' }, `Server information may be out of date: the last update arrived ${ago(lastServer)}. Sync before deciding.`) : null,
      h('p', { class: 'muted' }, 'Plans are recommendations; people decide. Danger signs follow referral procedures and never wait for a plan.'));
  }

  // The coordinator's questions, one tap from the section that answers each. A supervisor sees the decision first.
  glance(needs, resources, proposals, statusOf, mine, progress, role) {
    const attention = needs.filter(c => c.attention);
    const latest = proposals[0];
    const waitingOthers = proposals.filter(p => ['proposed', 'reviewed'].includes(statusOf(p).state) && oiWorkflow.actionable(p, this.lastDocs || [], 'review')).length;
    const tests = list => list.filter(p => p.fields.includes_test_records).length;
    const row = (section, label, value) => h('li', {}, h('button', { onclick: () => this.go(section) }, h('b', {}, label), value));
    const rows = {
      need: row('needs', 'Care needed', attention.length ? attention.map(c => c.name).join(', ') : needs.length ? 'No community needs attention' : 'No estimate yet'),
      resources: row('resources', 'Resources', `${resources.workers.length} CHO · ${resources.vehicles.length} motorbike(s)` +
        (resources.confirm.length ? ` · ${resources.confirm.length} to check` : ' · all checked or estimated')),
      plan: row('plan', 'Current plan', latest ? `${latest.fields.planning_date} · ${STATE[statusOf(latest).state]}` : 'No plan yet'),
      approval: row('plan', 'Approval', mine.length ? `${mine.length} waiting for you` + (tests(mine) ? ` (${tests(mine)} test)` : '')
        : waitingOthers ? `${waitingOthers} waiting for review or approval` : 'Nothing waiting'),
      open: row('progress', 'Still open', progress.days.length || progress.assigned
        ? `${progress.outstanding} visit(s) · ${progress.referralsOpen} referral(s)` : `No approved outreach yet · ${progress.referralsOpen} referral(s)`),
    };
    const order = role === 'carelink_supervisor' ? ['approval', 'plan', 'open', 'need', 'resources'] : ['need', 'resources', 'plan', 'approval', 'open'];
    return h('div', { class: 'card' }, h('h3', {}, 'At a glance'), h('ul', { class: 'glance' }, order.map(k => rows[k])));
  }

  // The one decision waiting for this user, made obvious; the decision itself is recorded from CHT Tasks.
  decisionCard(mine, statusOf, me, role) {
    if (!mine.length) { return null; }
    const p = mine[0];
    const step = oiWorkflow.nextActionFor(statusOf(p), me, role);
    const trips = (p.fields.schedule || {}).trips || [];
    const visits = trips.reduce((n, t) => n + Object.values(t.served || {}).reduce((a, b) => a + b, 0), 0);
    const names = [...new Set(trips.flatMap(t => t.route.filter(r => r !== 'facility').map(id => ((p.fields.demand || []).find(c => c.community_id === id) || {}).name || id)))];
    const WHAT = { submit: 'Submit this plan for supervisor review', review: 'Review this plan', decide: 'Approve or reject this plan' };
    return h('div', { class: 'card' },
      h('h3', {}, 'Your decision is needed'),
      h('p', {}, h('strong', {}, `${WHAT[step] || 'Decide on this plan'}: `), `outreach on ${p.fields.planning_date}` + (names.length ? ` to ${names.join(', ')}` : '') + ` · ${visits} visit(s).`),
      p.fields.includes_test_records ? h('p', { class: 'muted' }, 'This is a labelled test plan.') : null,
      mine.length > 1 ? h('p', { class: 'muted' }, `${mine.length - 1} more waiting after this one.`) : null,
      h('div', { class: 'row' }, h('button', { onclick: () => { window.location.hash = '#/tasks'; } }, 'Open my tasks to decide')));
  }

  // Communities from the latest demand estimate, those needing attention first. Documented needs are counts of CHT
  // records; the expected workload is Engine 1's forecast; reporting gaps are shown separately.
  needsOf(doc) {
    const rows = ((doc && doc.fields && doc.fields.demand) || []).map(c => {
      const reasons = [
        c.pending ? `${c.pending} routine visit(s) documented and waiting` : '',
        c.unserved_planned ? `${c.unserved_planned} planned visit(s) from past outreach days not completed` : '',
        c.days_since_outreach === null || c.days_since_outreach === undefined ? 'No documented outreach yet'
          : c.days_since_outreach > 30 ? `No documented outreach for ${c.days_since_outreach} days` : '',
        c.barrier_level === 'high' ? 'High reported transport barrier' : '',
      ].filter(Boolean);
      const limited = typeof c.data_coverage === 'number' && c.data_coverage < 0.5;
      return { ...c, reasons, limited, attention: reasons.length > 0 || limited, score: (c.pending || 0) + (c.unserved_planned || 0) + reasons.length };
    });
    return rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  needsSection(needs, doc, facilityConfig = {}) {
    const next = nextOutreach(facilityConfig.calendar);
    if (!doc) {
      return h('div', {}, h('h2', {}, "Prepare for this week's outreach"),
        next ? h('div', { class: 'note' }, `Next scheduled outreach: ${next} (facility weekly schedule).`) : null,
        h('div', { class: 'card' }, h('h3', {}, 'Community demand'), h('p', { class: 'muted' }, 'No demand estimate has reached this device yet. It arrives from the server when you are online.')));
    }
    const d = doc.fields;
    const known = needs.filter(c => c.sources);
    const sum = f => known.reduce((n, c) => n + f(c), 0);
    const expected = needs.filter(c => typeof c.estimate === 'number');
    const typeTotal = t => needs.reduce((n, c) => n + ((c.by_type || {})[t] || 0), 0);
    return h('div', {},
      h('h2', {}, "Prepare for this week's outreach"),
      next ? h('div', { class: 'note' }, `Next scheduled outreach: ${next} (facility weekly schedule).`) : null,
      h('div', { class: 'card' }, h('div', { class: 'facts' },
        h('div', {}, h('span', {}, 'Documented visits waiting'), h('strong', {}, known.length ? String(sum(c => c.pending || 0)) : 'Not yet reported')),
        h('div', {}, h('span', {}, 'Expected next week'), h('strong', {}, expected.length ? `about ${Math.round(expected.reduce((n, c) => n + c.estimate, 0))}` : 'No estimate')),
        h('div', {}, h('span', {}, 'Open maternal and child follow-ups'), h('strong', {}, known.length ? String(sum(c => c.sources.open_maternal_followups + c.sources.open_child_followups)) : 'Not yet reported'))),
        known.length ? h('p', {}, `Documented by service: ANC ${typeTotal('anc')} · PNC ${typeTotal('pnc')} · Child welfare ${typeTotal('cwc')} · Household requests ${typeTotal('request')}`) : null,
        h('p', { class: 'muted' }, 'Expected workload is estimated from recent recorded demand. Documented visits are actual CHT records.'),
        d.synthetic_history ? h('div', { class: 'warn' }, 'Includes simulated past weeks: not real reporting from these communities.') : null),
      needs.map(c => h('div', { class: 'card', 'data-coverage': c.community_id },
        h('div', { class: 'row' }, h('h3', {}, c.name), c.attention ? h('span', { class: 'chip pending' }, 'Needs attention') : h('span', { class: 'chip' }, 'Up to date')),
        line('Documented visits waiting', c.sources ? String(c.pending || 0) : 'Not yet reported'),
        line('Expected routine outreach needs', typeof c.estimate === 'number' ? `about ${c.estimate} next week` : 'No estimate'),
        c.sources ? line('Open now', `${c.sources.open_requests} request(s) · ${c.sources.open_maternal_followups} maternal · ${c.sources.open_child_followups} child`) : null,
        c.by_type && Object.keys(c.by_type).length ? line('By service', `ANC ${c.by_type.anc || 0} · PNC ${c.by_type.pnc || 0} · CWC ${c.by_type.cwc || 0} · Requests ${c.by_type.request || 0}`) : null,
        line('Last documented outreach', c.last_visit ? `${c.last_visit} (${c.days_since_outreach} days ago)` : 'None recorded'),
        c.limited ? h('div', { class: 'warn' }, 'Limited reporting history — estimate may be less reliable.') : null,
        c.reasons.length ? h('ul', {}, c.reasons.map(r => h('li', {}, r))) : null)),
      h('p', { class: 'muted' }, 'Urgent items are not counted here: danger signs and referral follow-ups follow professional referral procedures.'),
      h('details', {}, h('summary', {}, 'Community demand forecast: how it was estimated'),
        h('p', { class: 'muted' }, `${d.dataset_label}. Estimated ${when(doc.reported_date)}.`),
        needs.map(c => h('div', { class: 'item' }, h('strong', {}, c.name), h('p', {}, c.explanation),
          h('p', { class: 'muted' }, `Weeks reported: ${Math.round((c.data_coverage || 0) * 100)}% of 12 · urgent items excluded: ${c.urgent_items_excluded} · transport barrier: ${c.barrier_level}`))),
        h('p', { class: 'muted' }, 'Documented visits: one per open household request or per person with open recorded maternal/child follow-ups (a request for the same service as that person counts once). The estimate is a forecast; the documented visits are not.')),
      h('details', {}, h('summary', {}, 'Technical details'),
        h('p', { class: 'muted' }, `Forecast model: ${d.model_version}.`),
        d.model_decision ? h('p', { class: 'muted' }, `Model check: ${d.model_decision.reason} ${d.model_decision.intermittency_note || ''}`) : null));
  }

  // Workers, vehicles and the latest readiness of each supply, equipment item and fuel (readiness records override configuration).
  resourcesOf(facilityConfig, config, records) {
    const staleDays = config.stale_after_days || 7;
    const latest = {};
    records.slice().sort((a, b) => a.reported_date - b.reported_date).forEach(r => { latest[r.fields.resource_id] = r; });
    const items = (facilityConfig.resources || []).map(r => {
      const rec = latest[r.id];
      let status = rec ? rec.fields.status : r.status;
      const checked = rec ? rec.fields.verified_date : r.verified_at;
      if (rec && ['confirmed', 'insufficient'].includes(status) && checked && Date.now() - Date.parse(checked) > staleDays * 86400000) { status = 'stale'; }
      const quantity = rec ? rec.fields.quantity : r.quantity;
      const reserved = rec ? rec.fields.reserved : r.reserved;
      return { ...r, status, checked, by: rec ? rec.fields.actor : null, quantity, reserved, source: rec ? 'confirmed in CHT' : 'facility planning configuration' };
    });
    return {
      workers: facilityConfig.staff || [], vehicles: facilityConfig.vehicles || [], items,
      // Only resources the planner uses; vaccine stock is recorded but not tied to any visit type.
      confirm: items.filter(r => ['unknown', 'stale'].includes(r.status) && r.category !== 'vaccine'),
    };
  }

  resourcesSection(res, facilityConfig, facility) {
    if (!facilityConfig.staff) { return h('div', { class: 'warn' }, 'Your CHT profile is not attached to a facility, so no staff or vehicles can be shown.'); }
    const usable = res.items.filter(r => r.category !== 'vaccine');
    const detail = r => h('div', { class: 'item' },
      line(r.name, READINESS[r.status] || r.status),
      h('div', { class: 'muted' }, ['confirmed', 'insufficient', 'stale', 'simulated'].includes(r.status) && r.quantity !== undefined && r.quantity !== null && r.quantity !== ''
        ? `${r.quantity} ${r.unit || ''}${r.reserved ? ` (${r.reserved} reserved)` : ''} · ` : '',
      r.checked ? `checked ${r.checked}${r.by ? ` by ${r.by}` : ''} · ` : '', `source: ${r.source}`));
    return h('div', {},
      h('h2', {}, 'Resources for the next outreach'),
      h('div', { class: 'card' }, h('h3', {}, 'Check outreach resources'),
        line('Health workers', `${res.workers.length} listed (${unique(res.workers.map(s => days(s.available)))})`),
        line('Motorbikes', `${res.vehicles.length} listed (${unique(res.vehicles.map(v => days(v.available)))})`),
        usable.map(r => line(r.name, READINESS[r.status] || r.status)),
        res.confirm.length ? h('div', { class: 'warn' }, `${res.confirm.map(r => r.name).join(', ')}: needs confirmation before the services that use it can be scheduled.`) : null,
        h('div', { class: 'row' }, h('button', { onclick: () => { window.location.hash = `#/contacts/${facility}/report/carelink_resource_status`; } }, 'Update resource readiness'))),
      h('details', {}, h('summary', {}, 'Resource details: quantities, checks and sources'),
        h('h3', {}, 'Health workers'), res.workers.map(s => h('div', { class: 'item' }, line(s.name, s.role), h('div', { class: 'muted' }, `Usually works ${days(s.available)}`))),
        h('h3', {}, 'Motorbikes and vehicles'), res.vehicles.map(v => h('div', { class: 'item' }, line(v.name, days(v.available)))),
        ['fuel', 'supply', 'equipment'].map(cat => res.items.filter(r => r.category === cat).map(detail)),
        res.items.some(r => r.category === 'vaccine') ? [h('h3', {}, 'Vaccines (recorded, not linked to planning)'), res.items.filter(r => r.category === 'vaccine').map(detail)] : null,
        h('p', { class: 'muted' }, 'Planning estimates are configured values, not confirmed stock. A check older than 7 days needs repeating. Unknown or unchecked resources count as not available. Choose who and what is available on the day in the plan request.')));
  }

  /*
    Outreach progress from existing records (docs/OUTREACH_PROGRESS_COUNTING_RULES.md): only approved, server-confirmed
    plans; generated test plans excluded; each obligation once (lib/oi-links.js deduplicates by record id); a recorded
    outreach day closes nothing by itself; outcomes come from visit and resolution records, attributed to their author.
  */
  progressOf(proposals, selected, docs, testHouses = new Set(), period = 'all') {
    const now = new Date();
    const from = period === '4w' ? new Date(now.getTime() - 27 * 86400000) : period === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1) : null;
    const fromDay = from ? `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}` : '';
    const inPeriod = dayOrMs => !from || (typeof dayOrMs === 'number' ? dayOrMs >= from.getTime() : String(dayOrMs) >= fromDay);
    const approved = new Set(proposals.filter(p => oiWorkflow.proposalStatus(p, docs).approvedOnServer).map(p => p._id));
    const plans = docs.filter(d => d.form === oiLinks.FORMS.dayPlan && approved.has(d.fields.proposal_id));
    // A day is test work if its plan was a test plan (older day plans do not carry the flag themselves).
    const testPlans = new Set(proposals.filter(p => p.fields.includes_test_records).map(p => p._id));
    const counted = plans.filter(p => !p.fields.includes_test_records && !testPlans.has(p.fields.proposal_id) && inPeriod(p.fields.date));
    const blank = () => ({ days: 0, assigned: 0, completed: 0, partly: 0, unable: 0, other: 0, outstanding: 0, followupsOpen: 0, reasons: new Set(), last: null });
    const total = blank();
    const byCommunity = {};
    const byWorker = {};
    // Unfinished work from approved days, for home visits / defaulter tracing. Listed only: nothing is moved or closed.
    const attention = [];
    counted.forEach(plan => {
      const { counts, followups, rows, followupRows } = oiLinks.dayProgress(plan, docs);
      rows.filter(r => ['open', 'unable', 'partly'].includes(r.outcome)).forEach(r => attention.push({ who: r.household, what: r.outcome, community: plan.fields.community_name, date: plan.fields.date }));
      followupRows.filter(r => ['open', 'partly'].includes(r.outcome)).forEach(r => attention.push({ who: r.person, what: r.outcome, kind: followUpLabel(r), community: plan.fields.community_name, date: plan.fields.date }));
      const recordedDay = docs.find(d => d.form === F.outreachDay && d.fields.assignment_id === plan.fields.assignment_id);
      const visits = docs.filter(d => d.form === 'carelink_visit' && d.fields.assignment_id === plan.fields.assignment_id && ['unable_to_complete', 'in_progress'].includes(d.fields.status) && d.fields.outcome_note);
      [total, byCommunity[plan.fields.community_name] = byCommunity[plan.fields.community_name] || blank(),
        byWorker[plan.fields.worker_name] = byWorker[plan.fields.worker_name] || blank()].forEach(t => {
        t.days += 1;
        t.assigned += counts.planned + (followups.planned || 0);
        t.completed += counts.completed + (followups.completed || 0) + (followups.closed || 0);
        t.partly += counts.partly + (followups.partly || 0);
        t.unable += counts.unable;
        // Changed outside the day, or recorded by someone other than the assigned CHO: shown, never counted as completed.
        t.other += (counts.changed || 0) + (counts.unverified || 0) + (followups.changed || 0) + (followups.unverified || 0);
        t.outstanding += counts.open + (followups.open || 0) + (followups.partly || 0) + counts.partly;
        t.followupsOpen += (followups.open || 0) + (followups.partly || 0);
        if (recordedDay && recordedDay.fields.outcome !== 'done' && recordedDay.fields.reason) { t.reasons.add(recordedDay.fields.reason); }
        visits.forEach(v => t.reasons.add(v.fields.outcome_note));
        if (recordedDay && (!t.last || plan.fields.date > t.last)) { t.last = plan.fields.date; }
      });
    });
    // Volunteer contributions: household requests they submitted, where those requests stand, and household contacts
    // they recorded. Test households and test records are left out. Not proof of outreach.
    const volunteers = {};
    const real = d => !d.record_origin && !testHouses.has(d.fields.patient_id) && inPeriod(d.reported_date || 0);
    const volunteer = d => {
      const who = String(d.fields.created_by || (d.contact && d.contact._id) || 'unknown').replace(/^carelink-person-/, '');
      return volunteers[who] = volunteers[who] || { submitted: 0, reviewed: 0, open: 0, contacts: 0, communities: new Set() };
    };
    docs.filter(d => d.form === 'carelink_household_contact' && real(d)).forEach(c => {
      const v = volunteer(c);
      v.contacts += 1;
      if (c.fields.community_name) { v.communities.add(c.fields.community_name); }
    });
    docs.filter(d => d.form === 'carelink_request' && real(d)).forEach(r => {
      const v = volunteer(r);
      const state = oiRequests.workflow(r, docs).state;
      v.submitted += 1;
      if (state !== 'submitted') { v.reviewed += 1; }
      if (!oiRequests.TERMINAL.includes(state)) { v.open += 1; }
      if (r.fields.community_name) { v.communities.add(r.fields.community_name); }
    });
    const referrals = oiMch.referrals(docs.filter(d => d.form === 'carelink_mch_referral')).filter(ch => !ch.conflict && oiMch.referralOpen(ch));
    const byState = {};
    referrals.forEach(ch => { byState[ch.state] = (byState[ch.state] || 0) + 1; });
    const hasWork = p => { const { counts, followups } = oiLinks.dayProgress(p, docs); return counts.planned + (followups.planned || 0) > 0; };
    // The selected plan's days first (it may be a labelled test plan), then the latest real days that had work planned.
    const shown = [...plans.filter(p => selected && p.fields.proposal_id === selected._id),
      ...counted.filter(hasWork).sort((a, b) => b.fields.date.localeCompare(a.fields.date)).slice(0, 5)]
      .filter((p, i, all) => all.findIndex(x => x._id === p._id) === i);
    return { ...total, attention, counted: new Set(counted.map(p => p._id)), byCommunity, byWorker, volunteers, days: shown, testDays: plans.filter(p => p.fields.includes_test_records || testPlans.has(p.fields.proposal_id)).length, referralsOpen: referrals.length, referrals: byState };
  }

  progressSection(progress, docs) {
    const counted = progress.counted;
    const OUTCOME = { completed: 'Completed', unable: 'Visited, unable to complete', partly: 'Partly done', open: 'Still open',
      changed: 'Changed outside this day', unverified: 'Visit not by the assigned CHO' };
    const FOLLOWUP = { completed: 'Resolved by the assigned CHO', closed: 'Closed by a later record', partly: 'Seen, follow-up still open', open: 'Still open',
      changed: 'Not linked (changed before linking)', unverified: 'Resolved, not by the assigned CHO' };
    const summary = (t, extra) => h('div', {},
      line('Visits assigned', String(t.assigned)),
      line('Completed and documented', String(t.completed)),
      t.partly ? line('Partly done', String(t.partly)) : null,
      t.unable ? line('Visited, could not complete', String(t.unable)) : null,
      t.other ? line('Changed outside the day or not by the assigned CHO', String(t.other)) : null,
      line('Still outstanding', String(t.outstanding)),
      extra,
      t.reasons && t.reasons.size ? h('div', {}, h('span', { class: 'muted' }, 'Reasons recorded for unfinished work:'), h('ul', {}, [...t.reasons].slice(0, 3).map(r => h('li', {}, r)))) : null);
    const communities = Object.entries(progress.byCommunity).sort((a, b) => b[1].outstanding - a[1].outstanding || a[0].localeCompare(b[0]));
    const workers = Object.entries(progress.byWorker).sort((a, b) => a[0].localeCompare(b[0]));
    const volunteers = Object.entries(progress.volunteers).sort((a, b) => a[0].localeCompare(b[0]));
    return h('div', {},
      h('h2', {}, 'Outreach completed and follow-ups still needed'),
      h('div', { class: 'row' }, Object.entries(PERIODS).map(([key, label]) => h('button', {
        class: this.period === key ? '' : 'ghost', 'aria-pressed': String(this.period === key), onclick: () => { this.period = key; this.load(); } }, label)),
        h('button', { class: 'ghost', onclick: () => this.download(progress) }, 'Download (CSV)')),
      h('div', { class: 'card' }, h('div', { class: 'facts' },
        h('div', {}, h('span', {}, 'Visits assigned'), h('strong', {}, String(progress.assigned))),
        h('div', {}, h('span', {}, 'Completed and documented'), h('strong', {}, String(progress.completed))),
        h('div', {}, h('span', {}, 'Still outstanding'), h('strong', {}, String(progress.outstanding))),
        h('div', {}, h('span', {}, 'Communities with unfinished work'), h('strong', {}, String(communities.filter(([, t]) => t.outstanding > 0).length)))),
        h('p', { class: 'muted' }, 'A planned visit is not a completed visit, and recording an outreach day does not mean every household was visited. Completed counts come from visit and follow-up records; they are documentation, not independent verification.'),
        progress.testDays ? h('p', { class: 'muted' }, `Approved test plans are not counted (${progress.testDays} day(s)).`) : null),
      h('div', { class: 'card' }, h('h3', {}, 'Follow-ups needing attention'),
        progress.attention.length ? h('ul', {}, progress.attention.slice(0, 12).map(a => h('li', {},
          `${a.who}${a.kind ? ` (${a.kind})` : ''} — ${{ open: 'still open', unable: 'visited, could not complete', partly: 'partly done' }[a.what]} · ${a.community}, planned ${a.date}`))) : h('p', { class: 'muted' }, 'No unfinished planned visits on this device.'),
        progress.attention.length > 12 ? h('p', { class: 'muted' }, `…and ${progress.attention.length - 12} more.`) : null,
        h('p', { class: 'muted' }, 'These stay on the CHO\'s task list and in the next plan\'s demand. At this facility they can be followed up during home visits (Wednesday: defaulter tracing and home visits). CareLink does not move or close them automatically.')),
      communities.length ? h('div', { class: 'card' }, h('h3', {}, 'By community'), communities.map(([name, t]) => h('div', { class: 'item' }, h('strong', {}, name),
        summary(t, line('Last documented outreach', t.last || 'None recorded'))))) : null,
      workers.length ? h('div', { class: 'card' }, h('h3', {}, 'By health worker'), workers.map(([name, t]) => h('div', { class: 'item' }, h('strong', {}, name),
        line('Outreach days assigned', String(t.days)), summary(t))),
        h('p', { class: 'muted' }, 'Documented work to support planning, not a performance rating.')) : null,
      h('div', { class: 'card' }, h('h3', {}, 'Referral coordination'),
        Object.keys(progress.referrals).length ? Object.entries(progress.referrals).map(([state, n]) => line(REFERRAL[state] || state, String(n))) : h('p', { class: 'muted' }, 'No referrals in progress on this device.'),
        h('p', { class: 'muted' }, 'Urgent referrals follow professional procedures and direct communication; this is coordination status only.')),
      volunteers.length ? h('details', {}, h('summary', {}, 'Community volunteer contributions'),
        volunteers.map(([who, v]) => h('div', { class: 'item' }, h('strong', {}, who),
          line('Requests submitted', String(v.submitted)), line('Requests reviewed', String(v.reviewed)), line('Requests still open', String(v.open)),
          line('Household contacts recorded', String(v.contacts)),
          line('Communities supported', [...v.communities].join(', ') || '—'))),
        h('p', { class: 'muted' }, `${PERIODS[this.period]}. Requests and contacts are documentation, not proof that outreach took place. Test households are not counted.`)) : null,
      progress.days.length ? h('h3', {}, 'Outreach days') : h('p', { class: 'muted' }, 'No approved outreach days on this device yet.'),
      progress.days.map(plan => {
        const { counts, rows, followups, followupRows } = oiLinks.dayProgress(plan, docs);
        const recorded = docs.some(d => d.form === F.outreachDay && d.fields.assignment_id === plan.fields.assignment_id);
        return h('div', { class: 'card', 'data-day-plan-id': plan._id },
          h('h4', {}, `${plan.fields.community_name} · ${plan.fields.date} · ${plan.fields.worker_name}`),
          !counted.has(plan._id) ? h('div', { class: 'warn' }, 'Test plan: not for real outreach.') : null,
          h('p', {}, `Planned ${counts.planned} · completed ${counts.completed} · unable ${counts.unable} · partly ${counts.partly} · still open ${counts.open}` +
            (counts.changed ? ` · changed ${counts.changed}` : '') + (counts.unverified ? ` · unverified ${counts.unverified}` : '')),
          followups.planned ? h('p', { 'data-followups': '' }, `Maternal and child follow-ups: planned ${followups.planned} · completed ${followups.completed} · closed by a later record ${followups.closed} · partly ${followups.partly} · still open ${followups.open}` +
            (followups.changed ? ` · changed ${followups.changed}` : '') + (followups.unverified ? ` · unverified ${followups.unverified}` : '')) : null,
          h('p', { class: 'muted' }, recorded ? 'Outreach day recorded by the CHO. Requests not visited stay open and can be planned again.' : 'Outreach day not recorded yet (or its record has not synchronized to this device).'),
          rows.length || followupRows.length ? h('details', {}, h('summary', {}, 'Households and people'),
            rows.length ? h('ul', {}, rows.map(r => h('li', {}, `${r.household}: ${OUTCOME[r.outcome]}`))) : h('p', { class: 'muted' }, 'No open household requests were waiting in this community.'),
            followupRows.length ? h('ul', {}, followupRows.map(r => h('li', {}, `${r.person} · ${followUpLabel(r)}: ${FOLLOWUP[r.outcome]}`))) : null) : null);
      }),
      h('p', { class: 'muted' }, 'Counts come from records that have synchronized to this device; work recorded on a phone appears here only after it syncs.'));
  }

  // Primary view: what, who, where, how many, readiness, limits and the one next action. The reasoning, assumptions,
  // decision history and how the plan was created stay one tap away.
  planSection(p, docs, context, config) {
    const d = p.fields;
    const s = oiWorkflow.proposalStatus(p, docs);
    const next = oiWorkflow.nextActionFor(s, context.carelink_contact_id, context.carelink_role);
    const plan = d.schedule || {};
    const ex = d.explanation || {};
    const trips = plan.trips || [];
    const name = id => (d.demand || []).find(c => c.community_id === id)?.name || id;
    const vehicle = id => ((config && config.vehicles) || []).find(v => v.id === id)?.name || id;
    const resourceName = id => ((config && config.resources) || []).find(r => r.id === id)?.name || id;
    const planned = trips.reduce((n, t) => n + Object.values(t.served || {}).reduce((a, b) => a + b, 0), 0);
    const pending = Object.values(plan.pending || {}).reduce((a, b) => a + b, 0);
    const feasible = ['OPTIMAL', 'FEASIBLE'].includes(plan.status);
    const confirmNames = (ex.needs_confirmation || []).map(t => t.split(' (')[0]);
    const usage = Object.entries(d.resource_plan || {});
    const estimates = usage.filter(([, r]) => r.status === 'simulated').length;
    const limiting = usage.filter(([, r]) => r.binding && r.available > 0).map(([id, r]) => `${resourceName(id)}: all ${r.available} usable are planned`);
    const byType = {};
    trips.forEach(t => Object.values(t.served_by_type || {}).forEach(types => Object.entries(types || {}).forEach(([k, n]) => { byType[k] = (byType[k] || 0) + n; })));
    const unmet = Object.entries(d.unserved_by_type || {}).flatMap(([c, types]) => Object.entries(types || {}).filter(([, n]) => n > 0).map(([t, n]) => `${name(c)}: ${n} ${TYPE[t] || t}`));
    const calendar = (ex.binding || []).filter(t => t.startsWith('Calendar'));
    const fact = (label, value) => h('div', {}, h('span', {}, label), h('strong', {}, value));
    const ACTION = { submit: 'Submit for review (open task)', review: 'Review this plan (open task)', decide: 'Approve or reject (open task)' };
    return h('div', { 'data-plan-id': p._id },
      h('div', { class: 'card' },
        h('h3', {}, `Outreach plan · ${d.planning_date}`),
        h('div', { class: 'row' }, h('span', { class: `chip ${s.approvedOnServer ? 'ok' : s.state === 'rejected' ? 'bad' : ''}` }, STATE[s.state]),
          s.pending.length ? h('span', { class: 'chip pending' }, `${s.pending.length} decision(s) waiting to sync — not yet confirmed by the server`) : null),
        d.includes_test_records ? h('div', { class: 'warn' }, 'Test plan: planned from records that include regression-test households. Not for real outreach.') : null,
        !feasible ? h('div', { class: 'warn' }, h('strong', {}, 'We could not create a plan with the available resources. '), 'See "How this plan was created" for details.') : null,
        h('div', { class: 'facts' },
          fact('Outreach date', d.planning_date),
          fact('Assigned CHO', unique(trips.map(t => t.worker_name))),
          fact('Communities', unique(trips.flatMap(t => t.route.filter(r => r !== 'facility').map(name)))),
          fact('Motorbike', unique(trips.map(t => vehicle(t.vehicle)))),
          fact('Planned visits', String(planned)),
          fact('Visits we could not plan', String(Math.max(0, pending - planned)))),
        trips.length ? h('p', {}, ['anc', 'pnc', 'cwc', 'request'].map(t => `${TYPE[t]}: ${byType[t] || 0}`).join(' · ')) : null,
        trips.length > 1 ? h('ul', {}, trips.map(t => h('li', {}, `${t.worker_name} · ${t.day} · ${t.route.map(r => r === 'facility' ? 'Facility' : name(r)).join(' → ')}`))) : null,
        h('p', { class: 'muted' }, `Resources: ${usage.length - confirmNames.length} of ${usage.length} ready for this plan` +
          (estimates ? ` (${estimates} are planning estimates, not confirmed stock)` : '') + '.'),
        confirmNames.map(n => h('div', { class: 'warn' }, `${n} need confirmation before these visits can be scheduled.`)),
        limiting.length || unmet.length || calendar.length ? h('div', {}, h('strong', {}, "What's limiting this plan?"),
          h('ul', {}, [...limiting, ...(unmet.length ? [`Visits we could not plan — ${unmet.join('; ')}`] : []), ...calendar].map(t => h('li', {}, t)))) : null,
        d.urgent_note ? h('div', { class: 'warn' }, d.urgent_note) : null,
        next ? h('div', { class: 'row' }, h('button', { onclick: () => { window.location.hash = '#/tasks'; } }, ACTION[next]))
          : s.approvedOnServer ? h('div', { class: 'good' }, 'Approved. The assigned CHO has the outreach day as a task.') : null),
      h('details', {}, h('summary', {}, 'Why this plan?'),
        h('p', {}, h('strong', {}, ex.summary)),
        h('ul', {}, Object.values(ex.communities || {}).map(t => h('li', {}, t))),
        h('h3', {}, 'All planning limits'), h('ul', {}, (ex.binding || []).map(t => h('li', {}, t))),
        trips.map(t => h('p', { class: 'muted' }, `${t.worker_name}: travel ${t.travel_minutes} min + visits ${t.service_minutes} min = ${t.total_minutes} of ${t.available_minutes} min`)),
        (ex.resources || []).length ? h('div', {}, h('h3', {}, 'Supplies, equipment and fuel (planned allocation, not issued stock)'), h('ul', {}, ex.resources.map(t => h('li', {}, t)))) : null,
        (ex.what_if || []).length ? h('div', {}, h('h3', {}, 'Would more resources help?'),
          h('ul', {}, ex.what_if.map(w => h('li', {}, `With ${w.change}: ${w.extra_items_served > 0 ? `${w.extra_items_served} more routine visit(s) planned` : 'no more visits planned'}.`)))) : null,
        (d.alternatives || []).length ? h('div', {}, h('h3', {}, 'Feasible alternatives'), h('ul', {}, d.alternatives.map(a => h('li', {}, a)))) : null),
      h('details', {}, h('summary', {}, 'Planning assumptions'),
        h('ul', {},
          h('li', {}, 'Travel times are configured estimates, not measured routes.'),
          h('li', {}, 'Resource values marked "simulated value" are planning estimates, not confirmed stock. Unknown or stale stock counts as not available.'),
          h('li', {}, 'The weekly outreach calendar is illustrative and unverified unless the facility confirms it.'),
          h('li', {}, 'Only documented visits are assigned; the forecast never creates household assignments.'),
          h('li', {}, `Data: ${d.dataset_label || '—'}${d.synthetic_history ? ' (includes simulated past weeks)' : ''}.`),
          h('li', {}, 'Danger signs and referral follow-ups are never part of a routine plan.'))),
      h('details', {}, h('summary', {}, 'Decision history'),
        h('ul', {}, s.history.map(e => h('li', {}, `${when(e.at)} · ${e.actor} · ${e.action} · `,
          h('span', { class: `chip ${e.server === 'accepted' ? 'ok' : e.server === 'pending' ? 'pending' : 'bad'}` },
            e.server === 'pending' ? 'Waiting to sync' : e.server === 'accepted' ? 'Confirmed by the server' : `Server: ${e.server}`),
          e.reason ? ` ${e.reason}` : '', e.notes ? ` — ${e.notes}` : ''))),
        h('p', { class: 'muted' }, 'Approval records a planning decision, not a clinical authorisation. After the server confirms an approval, the assigned CHO receives a planned outreach-day task.')),
      h('details', {}, h('summary', {}, 'How this plan was created'),
        !feasible ? h('ul', {}, (ex.reasons || []).map(r => h('li', {}, r))) : null,
        h('h3', {}, 'Fairness and underserved communities'),
        h('div', { class: 'wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Community'), h('th', { class: 'num' }, 'Covered'), h('th', { class: 'num' }, 'Unmet'),
          h('th', { class: 'num' }, 'Weeks reported'), h('th', { class: 'num' }, 'Weight'), h('th', {}, 'Guaranteed'))),
          h('tbody', {}, (d.fairness || []).map(c => h('tr', {}, h('td', {}, c.name), h('td', { class: 'num' }, c.covered), h('td', { class: 'num' }, c.unmet),
            h('td', { class: 'num' }, `${Math.round(c.data_coverage * 100)}%`), h('td', { class: 'num' }, c.weight), h('td', {}, c.guaranteed ? 'yes' : '—')))))),
        h('p', { class: 'muted' }, `Requested by ${d.requested_by} · ${d.planner_version} · ${plan.solver} (${plan.status}) · forecast ${d.model_version || '—'} · input ${String(d.input_sha256).slice(0, 12)}`)));
  }
}
module.exports = CareLinkOutreachIntelligence;
