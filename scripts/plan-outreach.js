'use strict';
/*
  Recommends an outreach plan from the records on the server (npm run plan [-- --season rainy] [-- --start YYYY-MM-DD]).
  Read-only: it writes nothing to CHT. The coordinator reviews evidence/outreach-plan.md and records each
  approved assignment with the existing coordination form, so every decision stays a recorded human event.
*/
const fs = require('node:fs');
const path = require('node:path');
const { connection } = require('./client');
const { assess } = require('../lib/need-score');
const { plan } = require('../lib/scheduler');
const { isoDay } = require('../lib/schedules');

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : fallback; };
const today = arg('today', isoDay());
const start = arg('start', new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10));
const season = arg('season', 'dry');
const resourcesPath = path.resolve(arg('resources', path.join(__dirname, '..', 'planning', 'tolon-district.json')));
const hm = m => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;

(async () => {
  const couch = connection('CHT_COUCH_URL');
  const docs = (await couch('/medic/_all_docs?include_docs=true')).rows.map(r => r.doc);
  // A district file lists several facilities: --facility picks one (default: the first).
  const source = JSON.parse(fs.readFileSync(resourcesPath));
  const chosen = source.facilities && (source.facilities.find(f => f.id === arg('facility')) || source.facilities[0]);
  const resources = chosen ? { ...source, ...chosen, facility: chosen.id } : source;
  const assessment = assess(docs, today);
  const result = plan(assessment, resources, { start, season });
  const out = { generated: new Date().toISOString(), today, resources: path.basename(resourcesPath), demo: !!resources.demo,
    status: 'RECOMMENDATION — requires coordinator approval', assessment: { weights: assessment.weights, communities: assessment.communities }, plan: result };
  const evidence = path.join(__dirname, '..', 'evidence');
  fs.writeFileSync(path.join(evidence, `outreach-plan-${season}.json`), JSON.stringify(out, null, 2) + '\n');

  const lines = [
    `# Recommended outreach plan — ${result.days[0]} to ${result.days[result.days.length - 1]} (${season} season)`, '',
    `> **Recommendation only.** Nothing is assigned until the facility coordinator approves it and records each assignment with *Review or update request*. ${resources.demo ? 'All people, places, staff, vehicles and travel times are fictional.' : ''}`, '',
    `Generated ${out.generated} from the server records on ${today}. Need points are programme weights for ranking outreach (pending review), not clinical risk.`, '',
    '## Community need', '', '| Community | Need points | Why |', '|---|---|---|',
    ...assessment.communities.map(c => `| ${c.name} | ${c.score} | ${c.explanation} |`), '',
    '## Recommended trips', '',
  ];
  if (!result.visits.length) { lines.push('No trips could be scheduled with the available staff, vehicles and hours.', ''); }
  result.visits.forEach(v => {
    lines.push(`### ${v.weekday[0].toUpperCase() + v.weekday.slice(1)} ${v.date} · ${v.worker_name} · ${v.vehicle}`, '',
      `Facility → ${v.stops.map(s => s.community_name).join(' → ')} → Facility · ${v.households} stops · travel ${hm(v.travel_minutes)} + visits ${hm(v.service_minutes)} = ${hm(v.total_minutes)} of ${hm(result.budget_minutes)}`, '');
    v.stops.forEach(s => s.targets.forEach(t => {
      lines.push(`- **${t.name}** (${s.community_name}, ${t.score} pts): ${t.why.join('; ')}`);
      if (t.waited_because.length) { lines.push(`  - Not earlier because: ${t.waited_because.join('; ')}`); }
    }));
    lines.push('');
  });
  lines.push('## Unmet needs', '');
  if (!result.unmet.length) { lines.push(`None: every recorded need fits within ${result.days.length} working days.`, ''); }
  result.unmet.forEach(u => lines.push(`- **${u.name}** (${u.community_name || '—'}, ${u.score} pts): ${u.needs.join('; ')}`, `  - Why not scheduled: ${u.why.join('; ')}`));
  lines.push('', '## Totals', '',
    `${result.totals.scheduled} of ${result.totals.targets} visit targets scheduled; ${result.totals.need_points_scheduled} of ${result.totals.need_points_total} need points covered.`, '',
    '## Method and limits', '',
    '- Hard constraints: responsible worker only; staff working days; one worker per vehicle per day; travel + visits within working hours; daily household limit.',
    '- Greedy by need, explainable, not guaranteed optimal. Travel times are estimates per season.',
    '- Records still on phones (not yet synced) are not included.');
  fs.writeFileSync(path.join(evidence, `outreach-plan-${season}.md`), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
