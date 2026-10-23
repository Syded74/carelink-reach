'use strict';
// CareLink Reach — Outreach Intelligence UI. Values are always inserted as text, never as HTML.
const $ = sel => document.querySelector(sel);
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) { continue; }
    // style via CSSOM: the server's CSP forbids inline style attributes
    if (k.startsWith('on')) { el.addEventListener(k.slice(2), v); } else if (k === 'style') { el.style.cssText = v; } else if (k === 'class') { el.className = v; } else { el.setAttribute(k, v === true ? '' : v); }
  }
  for (const c of children.flat()) { if (c !== null && c !== undefined && c !== false) { el.append(c instanceof Node ? c : String(c)); } }
  return el;
}
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CareLink': '1' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status }); }
  return data;
}
const state = { user: null, dataset: 'hackathon-villages', demand: null, resources: null, scenarios: [], proposal: null };
const fmtMin = m => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

// ---- sign in -------------------------------------------------------------------------------
async function start() {
  const me = await api('/api/me').catch(() => ({ signed_in: false }));
  if (me.signed_in) { state.user = me; showApp(); } else { showLogin(); }
}
function showLogin() { $('#login').hidden = false; $('#app').hidden = true; $('#who').hidden = true; }
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-error').textContent = '';
  try { state.user = await api('/api/login', { username: f.get('username'), password: f.get('password') }); e.target.reset(); showApp(); }
  catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('/api/logout', {}).catch(() => {}); state.user = null; showLogin(); });

async function showApp() {
  $('#login').hidden = true; $('#app').hidden = false; $('#who').hidden = false;
  $('#who-name').textContent = `${state.user.name} · ${state.user.roles.filter(r => r.startsWith('carelink_')).map(r => r.replace('carelink_', '')).join(', ')}`;
  const sets = await api('/api/datasets');
  const sel = $('#dataset');
  sel.replaceChildren(...sets.map(s => h('option', { value: s.id }, s.label)));
  sel.value = state.dataset;
  sel.onchange = async () => { state.dataset = sel.value; state.resources = null; openTab('demand'); await loadDemand(); renderPlanner(); };
  await loadDemand();
  await renderPlanner();
  renderSchedule();
  renderReview();
}
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => openTab(b.dataset.tab)));
function openTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== `tab-${name}`; });
  if (name === 'review') { renderReview(); }
}

// ---- page 1: community demand -----------------------------------------------------------------
async function loadDemand() {
  const box = $('#tab-demand');
  box.replaceChildren(h('p', { class: 'muted' }, 'Loading community demand…'));
  const d = state.demand = await api(`/api/demand?dataset=${encodeURIComponent(state.dataset)}`);
  const e = d.estimate;
  const rows = e.communities.map(c => h('tr', {},
    h('td', {}, h('strong', {}, c.community), h('div', { class: 'muted' }, `Transport barrier: ${c.barrier_level}`)),
    h('td', { class: 'num' }, c.current ? c.current.pending_followups : '—'),
    h('td', { class: 'num' }, c.current && c.current.urgent_items_excluded ? c.current.urgent_items_excluded : '0'),
    h('td', { class: 'num' }, c.estimate ?? '—'),
    h('td', {}, c.method.replace(/_/g, ' '), h('div', { class: 'muted' }, c.validation ? `back-test MAE ${c.validation.mae} (n=${c.validation.n})` : 'not validated')),
    h('td', { class: 'num' }, `${Math.round(c.data_coverage_12w * 100)}%`),
    h('td', {}, c.explanation)));
  box.replaceChildren(
    h('h1', {}, 'Community demand'),
    h('p', { class: 'muted' }, `${d.dataset.label}. As of ${d.dataset.as_of}. Source: ${d.dataset.source}. Forecast period: ${e.communities[0] ? e.communities[0].forecast_period : '—'}. Model ${e.model_version}.`),
    d.dataset.synthetic ? h('p', { class: 'warn' }, 'Synthetic history: these numbers demonstrate the method only. They are not evidence about real communities.') : null,
    ...d.dataset.notes.map(n => h('p', { class: 'muted' }, n)),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Community'), h('th', { class: 'num' }, 'Documented routine items now'), h('th', { class: 'num' }, 'Urgent (excluded)'),
        h('th', { class: 'num' }, 'Estimate next week'), h('th', {}, 'Method'), h('th', { class: 'num' }, 'Weeks reported (last 12)'), h('th', {}, 'Explanation'))),
      h('tbody', {}, rows))),
    h('p', { class: 'muted' }, 'Estimates count routine outreach work items (requests, follow-ups due, recorded missed appointments, open referrals). They are not clinical urgency or risk. Urgent danger-sign reviews are excluded and follow referral procedures.'),
    h('h2', {}, 'How the baseline was chosen'),
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Baseline'), h('th', { class: 'num' }, 'MAE'), h('th', { class: 'num' }, 'RMSE'), h('th', { class: 'num' }, 'Bias'), h('th', { class: 'num' }, 'Tests'))),
      h('tbody', {}, Object.entries(e.method_comparison).map(([m, v]) => h('tr', {}, h('td', {}, m.replace(/_/g, ' '), m === e.method ? h('span', { class: 'pill' }, ' selected') : null),
        ...(v ? [h('td', { class: 'num' }, v.mae), h('td', { class: 'num' }, v.rmse), h('td', { class: 'num' }, v.bias), h('td', { class: 'num' }, v.n)] : [h('td', { colspan: 4, class: 'muted' }, 'not enough history')])))))),
    mlCard(d.ml_experiment));
}
function mlCard(ml) {
  if (ml.status !== 'experimental') { return h('div', { class: 'card' }, h('h3', {}, 'Machine-learning experiment: not run'), h('p', {}, ml.reason)); }
  const row = (label, a, b) => h('tr', {}, h('td', {}, label), h('td', { class: 'num' }, a ? a.mae : '—'), h('td', { class: 'num' }, b ? b.mae : '—'));
  return h('div', { class: 'card' },
    h('h3', {}, 'Machine-learning experiment ', h('span', { class: 'pill warn' }, 'experimental · not used for planning')),
    h('p', {}, `${ml.model}, time-based split. Train ${ml.train_weeks}; test ${ml.test_weeks}. Excluded inputs: ${ml.excluded_inputs.join(', ')}.`),
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Held-out weeks'), h('th', { class: 'num' }, 'Poisson MAE'), h('th', { class: 'num' }, `${ml.baseline} MAE`))),
      h('tbody', {}, row('All', ml.ml, ml.baseline_metrics), row('Low-demand weeks', ml.low_demand_weeks.ml, ml.low_demand_weeks.baseline), row('High-demand weeks', ml.high_demand_weeks.ml, ml.high_demand_weeks.baseline),
        ...Object.entries(ml.by_community).map(([c, v]) => row(c, v.ml, v.baseline))))),
    h('p', {}, ml.conclusion));
}

// ---- page 2: planner --------------------------------------------------------------------------
async function renderPlanner(scenario = 'baseline', season = 'dry') {
  const box = $('#tab-planner');
  const r = await api(`/api/resources?dataset=${encodeURIComponent(state.dataset)}&scenario=${scenario}&season=${season}`);
  state.resources = r.resources; state.scenarios = r.scenarios;
  const res = state.resources;
  const comms = state.demand.estimate.communities;
  const day = res.planning_days[0];
  const preset = state.dataset === 'hackathon-villages'
    ? h('label', {}, 'Resource scenario', h('select', { id: 'scenario', onchange: ev => renderPlanner(ev.target.value) }, state.scenarios.map(s => h('option', { value: s.id, selected: s.id === scenario }, s.label))))
    : h('label', {}, 'Season (travel times)', h('select', { id: 'season', onchange: ev => renderPlanner('baseline', ev.target.value) }, ['dry', 'rainy'].map(s => h('option', { value: s, selected: s === season }, s))));
  const ids = ['facility', ...comms.map(c => c.community_id)];
  const name = id => id === 'facility' ? 'Facility' : comms.find(c => c.community_id === id).community;
  const travel = (a, b) => (res.travel_minutes[a] || {})[b] ?? (res.travel_minutes[b] || {})[a] ?? '';
  const pairs = [];
  ids.forEach((a, i) => ids.slice(i + 1).forEach(b => pairs.push([a, b])));
  box.replaceChildren(
    h('h1', {}, 'Outreach planner'),
    h('p', { class: 'muted' }, res.label),
    h('form', { id: 'plan-form' },
      h('div', { class: 'row' }, preset, h('label', {}, 'Planning date', h('input', { type: 'date', id: 'day', value: day, required: true }))),
      h('fieldset', {}, h('legend', {}, 'Health workers'), res.workers.map(w => h('div', { class: 'row' },
        h('label', {}, h('input', { type: 'checkbox', name: 'worker', value: w.id, checked: w.available_days.includes(day) }), `${w.name} (${w.role})`),
        h('label', {}, 'Start', h('input', { type: 'time', name: `start-${w.id}`, value: w.hours.start })),
        h('label', {}, 'End', h('input', { type: 'time', name: `end-${w.id}`, value: w.hours.end })),
        w.communities.length ? h('span', { class: 'muted' }, `Covers: ${w.communities.map(name).join(', ')}`) : null))),
      h('fieldset', {}, h('legend', {}, 'Vehicles'), res.vehicles.map(v => h('label', {}, h('input', { type: 'checkbox', name: 'vehicle', value: v.id, checked: v.available_days.includes(day) }), v.name)),
        h('p', { class: 'muted' }, 'Every trip needs a vehicle. No plan assumes transport that is not ticked here.')),
      h('fieldset', {}, h('legend', {}, 'Communities'), comms.map(c => h('label', {}, h('input', { type: 'checkbox', name: 'community', value: c.community_id, checked: true }), `${c.community} — ${c.current ? c.current.pending_followups : 0} documented items`))),
      h('fieldset', {}, h('legend', {}, 'Travel-time assumptions (minutes, one way)'),
        h('p', { class: 'muted' }, 'Documented estimates only. Fictional for this demo; replace with health-team estimates. Never derived from straight-line distance.'),
        h('div', { class: 'grid' }, pairs.map(([a, b]) => h('label', {}, `${name(a)} ↔ ${name(b)}`, h('input', { type: 'number', min: 1, required: true, name: `travel|${a}|${b}`, value: travel(a, b) }))))),
      h('fieldset', {}, h('legend', {}, 'Service assumptions (fictional)'),
        h('div', { class: 'row' },
          h('label', {}, 'Setup minutes per community', h('input', { type: 'number', min: 0, id: 'setup', value: res.service.setup_minutes_per_stop })),
          h('label', {}, 'Minutes per follow-up item', h('input', { type: 'number', min: 1, id: 'per', value: res.service.minutes_per_followup })))),
      h('fieldset', {}, h('legend', {}, 'Fairness policy'),
        h('div', { class: 'row' },
          h('label', {}, 'Fairness weight (0–1)', h('input', { type: 'number', min: 0, max: 1, step: 0.1, id: 'fair', value: 0.5 })),
          h('label', {}, 'Travel penalty per minute', h('input', { type: 'number', min: 0, max: 1, step: 0.01, id: 'tp', value: 0.01 }))),
        h('p', { class: 'muted' }, 'Fairness weight raises the priority of communities with high transport barriers or few reported weeks, because low reporting can mean poor access.'),
        h('label', {}, h('input', { type: 'checkbox', id: 'mincov' }), 'Guarantee at least one item in each community ticked below (hard constraint)'),
        h('div', { class: 'row' }, comms.map(c => h('label', {}, h('input', { type: 'checkbox', name: 'mincov-c', value: c.community_id, checked: c.barrier_level === 'high' || c.data_coverage_12w < 0.75 }), c.community)))),
      h('button', { type: 'submit' }, 'Generate outreach plan'),
      h('p', { id: 'plan-error', class: 'error', role: 'alert' })));
  $('#plan-form').addEventListener('submit', generate);
}
async function generate(e) {
  e.preventDefault();
  const f = e.target;
  const day = $('#day').value;
  const res = JSON.parse(JSON.stringify(state.resources));
  const picked = name => [...f.querySelectorAll(`input[name=${name}]:checked`)].map(i => i.value);
  res.planning_days = [day];
  res.workers = res.workers.filter(w => picked('worker').includes(w.id)).map(w => ({ ...w, available_days: [day], hours: { start: f.elements[`start-${w.id}`].value, end: f.elements[`end-${w.id}`].value } }));
  res.vehicles = res.vehicles.filter(v => picked('vehicle').includes(v.id)).map(v => ({ ...v, available_days: [day] }));
  res.communities = picked('community');
  res.confirmed_assignments = (res.confirmed_assignments || []).map(a => ({ ...a, day })).filter(a => res.workers.some(w => w.id === a.worker));
  res.travel_minutes = {};
  f.querySelectorAll('input[name^="travel|"]').forEach(i => { const [, a, b] = i.name.split('|'); (res.travel_minutes[a] = res.travel_minutes[a] || {})[b] = Number(i.value); });
  res.service = { setup_minutes_per_stop: Number($('#setup').value), minutes_per_followup: Number($('#per').value) };
  const policy = { fairness_weight: Number($('#fair').value), travel_penalty_per_minute: Number($('#tp').value),
    min_coverage: { enabled: $('#mincov').checked, communities: picked('mincov-c'), min_followups: 1 } };
  $('#plan-error').textContent = '';
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'Solving…';
  try { state.proposal = await api('/api/plan', { dataset: state.dataset, resources: res, policy }); renderSchedule(); openTab('schedule'); }
  catch (err) { $('#plan-error').textContent = err.message; }
  finally { btn.disabled = false; btn.textContent = 'Generate outreach plan'; }
}

// ---- page 3: schedule -------------------------------------------------------------------------
function renderSchedule() {
  const box = $('#tab-schedule');
  const p = state.proposal;
  if (!p) { box.replaceChildren(h('h1', {}, 'Recommended schedule'), h('p', { class: 'muted' }, 'Generate a plan on the Outreach planner page.')); return; }
  box.replaceChildren(h('h1', {}, 'Recommended schedule'), planView(p), p.status === 'draft' && p.created_by === state.user.name
    ? h('div', { class: 'row' }, h('button', { onclick: async () => { state.proposal = await api(`/api/proposals/${p.id}/submit`, {}); renderSchedule(); openTab('review'); } }, 'Submit for review'),
      h('span', { class: 'muted' }, 'A different coordinator or supervisor must review and decide.'))
    : null);
}
function planView(p) {
  const plan = p.plan; const r = plan.result; const x = plan.explanation;
  const name = id => r.names[id] || id;
  const header = h('div', { class: 'card' },
    h('div', { class: 'row' }, h('span', { class: `pill ${r.status === 'INFEASIBLE' ? 'bad' : ''}` }, r.status), h('span', { class: 'status' }, p.status),
      h('span', { class: 'muted' }, `Proposal ${p.id.slice(0, 8)} · ${p.planner_version} · ${r.solver} · input ${p.input_sha256.slice(0, 12)}`)),
    h('p', {}, h('strong', {}, x.summary)),
    plan.synthetic ? h('p', { class: 'warn' }, 'Synthetic scenario data.') : null,
    plan.urgent_note ? h('p', { class: 'warn' }, plan.urgent_note) : null);
  if (r.status === 'INFEASIBLE') {
    return h('div', {}, header, h('div', { class: 'card' }, h('h3', {}, 'Why no plan is possible'), h('ul', { class: 'plain' }, x.reasons.map(t => h('li', {}, t))),
      h('p', { class: 'muted' }, 'Nothing was scheduled. Change the resources or the confirmed assignments and generate again.')));
  }
  const trips = r.trips.map(t => {
    const route = [];
    t.route.forEach((stop, i) => { route.push(h('span', {}, name(stop === 'facility' ? 'Facility' : stop))); if (i < t.legs_minutes.length) { route.push(h('span', { class: 'leg' }, `→ ${t.legs_minutes[i]} min →`)); } });
    const pct = v => `${Math.max(0, (v / t.available_minutes) * 100)}%`;
    return h('div', { class: 'card' },
      h('h3', {}, `${t.worker_name} · ${t.day} · ${t.vehicle}`),
      h('div', { class: 'route' }, route),
      h('div', { class: 'bar', role: 'img', 'aria-label': `travel ${t.travel_minutes} minutes, visits ${t.service_minutes} minutes, of ${t.available_minutes}` },
        h('i', { class: 'travel', style: `width:${pct(t.travel_minutes)}` }), h('i', { class: 'service', style: `width:${pct(t.service_minutes)}` })),
      h('p', { class: 'legend' }, `Travel ${fmtMin(t.travel_minutes)} + visits ${fmtMin(t.service_minutes)} = ${fmtMin(t.total_minutes)} of ${fmtMin(t.available_minutes)} available`),
      h('ul', { class: 'plain' }, Object.entries(t.served).map(([c, n]) => h('li', {}, `${name(c)}: ${n} of ${r.pending[c]} documented items`))));
  });
  const totals = h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Community'), h('th', { class: 'num' }, 'Documented'), h('th', { class: 'num' }, 'Covered'), h('th', { class: 'num' }, 'Unmet'), h('th', { class: 'num' }, 'Priority weight'))),
    h('tbody', {}, Object.keys(r.pending).map(c => h('tr', {}, h('td', {}, name(c)), h('td', { class: 'num' }, r.pending[c]), h('td', { class: 'num' }, r.served[c]),
      h('td', { class: 'num' }, r.unserved[c] ? h('span', { class: 'pill warn' }, r.unserved[c]) : '0'), h('td', { class: 'num' }, r.priorities[c].weight))))));
  return h('div', {}, header,
    h('div', { class: 'grid' }, trips.length ? trips : [h('p', { class: 'card' }, 'No trips: see the reasons below.')]),
    h('h2', {}, 'Coverage'), totals,
    h('h2', {}, 'Why'), h('ul', { class: 'plain' }, Object.values(x.communities).map(t => h('li', {}, t))),
    h('h2', {}, 'Binding constraints'), h('ul', { class: 'plain' }, x.binding.map(t => h('li', {}, t))),
    x.what_if && x.what_if.length ? h('div', {}, h('h2', {}, 'Would more resources help?'), h('ul', { class: 'plain' }, x.what_if.map(w => h('li', {}, `With ${w.change}: ${w.extra_items_served > 0 ? `${w.extra_items_served} more documented item(s) covered` : 'no more items covered'}.`)))) : null,
    plan.alternatives.length ? h('div', {}, h('h2', {}, 'Feasible alternatives'), h('ul', { class: 'plain' }, plan.alternatives.map(a => h('li', {},
      a.trips.map(t => `${t.worker_name}: ${t.route.map(s => s === 'facility' ? 'Facility' : name(s)).join(' → ')}`).join('; '), ` — ${a.difference}.`)))) : null);
}

// ---- page 4: review ---------------------------------------------------------------------------
async function renderReview(selected) {
  const box = $('#tab-review');
  const list = await api('/api/proposals');
  const id = selected || (state.proposal && state.proposal.id) || (list[0] && list[0].id);
  const detail = id ? await api(`/api/proposals/${id}`) : null;
  box.replaceChildren(
    h('h1', {}, 'Review and approval'),
    h('p', { class: 'warn' }, 'Fictional demonstration approval. It is not a real institutional authorisation and creates no CHT assignment. After a real approval, the coordinator records each assignment in CHT with “Review or update request”.'),
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Created'), h('th', {}, 'By'), h('th', {}, 'Scenario'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Covered'), h('th', {}))),
      h('tbody', {}, list.map(p => h('tr', {}, h('td', {}, p.created_at.replace('T', ' ').slice(0, 16)), h('td', {}, p.created_by), h('td', {}, p.label || p.dataset_id),
        h('td', {}, h('span', { class: 'status' }, p.status), p.solver_status === 'INFEASIBLE' ? h('span', { class: 'pill bad' }, ' infeasible') : null),
        h('td', { class: 'num' }, `${p.served} / ${p.pending}`), h('td', {}, h('button', { class: 'ghost', onclick: () => renderReview(p.id) }, 'Open'))))))),
    detail ? reviewDetail(detail) : h('p', { class: 'muted' }, 'No plans yet.'));
}
function reviewDetail(p) {
  const act = async (action, body) => {
    try { state.proposal = await api(`/api/proposals/${p.id}/${action}`, body); renderReview(p.id); renderSchedule(); }
    catch (err) { $('#review-error').textContent = err.message; }
  };
  const mine = p.created_by === state.user.name;
  const notes = h('textarea', { id: 'review-notes', rows: 3 });
  const comms = p.plan.demand.map(d => h('label', {}, h('input', { type: 'checkbox', name: 'exclude', value: d.community_id }), `Exclude ${d.name} and re-solve`));
  const actions = [];
  if (p.status === 'draft' && mine) { actions.push(h('button', { onclick: () => act('submit', {}) }, 'Submit for review')); }
  if (p.status === 'proposed' && !mine) {
    actions.push(h('fieldset', {}, h('legend', {}, 'Reviewer changes (optional)'), comms),
      h('button', { onclick: () => act('review', { notes: notes.value, exclude_communities: [...document.querySelectorAll('input[name=exclude]:checked')].map(i => i.value) }) }, 'Mark as reviewed'));
  }
  if (p.status === 'reviewed' && !mine) {
    actions.push(h('div', { class: 'row' }, h('button', { onclick: () => act('approve', { notes: notes.value }) }, 'Approve (demo)'), h('button', { class: 'danger', onclick: () => act('reject', { notes: notes.value }) }, 'Reject')));
  }
  if (mine && ['proposed', 'reviewed'].includes(p.status)) { actions.push(h('p', { class: 'muted' }, 'You generated this plan, so a different coordinator or supervisor must review and decide.')); }
  return h('div', {},
    h('h2', {}, `Plan ${p.id.slice(0, 8)} — ${p.status}`),
    planView(p),
    p.revisions.length ? h('div', { class: 'card' }, h('h3', {}, 'Changes made by the reviewer'), h('ul', { class: 'plain' }, p.revisions.map(v => h('li', {}, `${v.at} ${v.by}: ${JSON.stringify(v.changes)} — covered before ${JSON.stringify(v.previous_served)}, after ${JSON.stringify(v.new_served)}`)))) : null,
    p.decision ? h('div', { class: 'card' }, h('h3', {}, `Decision: ${p.decision.decision}`), h('p', {}, `${p.decision.by} at ${p.decision.at}. ${p.decision.notes}`), h('p', { class: 'muted' }, p.decision.notice)) : null,
    actions.length ? h('div', { class: 'card' }, h('h3', {}, 'Your action'), h('label', {}, 'Notes (required to reject)', notes), ...actions, h('p', { id: 'review-error', class: 'error', role: 'alert' })) : null,
    h('h2', {}, 'Audit trail'),
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'Action'), h('th', {}, 'Status'), h('th', {}, 'Notes'))),
      h('tbody', {}, p.audit.map(a => h('tr', {}, h('td', {}, a.at), h('td', {}, `${a.by} (${a.roles.join(', ')})`), h('td', {}, a.action), h('td', {}, `${a.from || '—'} → ${a.to}`), h('td', {}, a.notes)))))),
    h('p', { class: 'muted' }, `Planner ${p.planner_version} · model ${p.model_version} · input snapshot sha256 ${p.input_sha256} · CHT assignment integration: ${p.cht_assignment_integration}`));
}
start();
