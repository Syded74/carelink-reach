'use strict';
/*
  Constraint-aware outreach scheduler (docs/CARELINK_OUTREACH_PLANNING.md). It RECOMMENDS a plan; the
  facility coordinator approves it and records assignments with the existing coordination form.

  Method: deterministic, greedy by need. Each working day, each available worker (most urgent pending
  work first) takes a free vehicle and builds one round trip from the facility, adding their own
  highest-need households community by community while the trip still fits the working day and the
  daily household limit. Constraints are never relaxed; whatever does not fit is reported as unmet,
  with the reason. Greedy is not guaranteed optimal; it is explainable and exact for every rule below.

  Hard constraints:
  - a household is visited only by its responsible worker (as the coordination form enforces)
  - staff work only on their available days; one vehicle carries one worker per day
  - travel + service time fits within working hours, for the season's travel times
  - at most N households per worker per day
*/
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const minutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const weekday = day => DAYS[new Date(day + 'T00:00:00Z').getUTCDay()];
const addDay = day => new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);

function workingDays(start, resources) {
  const out = [];
  for (let day = start; out.length < resources.horizon_working_days; day = addDay(day)) {
    if (resources.working_days.includes(weekday(day))) { out.push(day); }
  }
  return out;
}
function travelTime(resources, season) {
  const table = resources.travel_minutes[season];
  if (!table) { throw Error(`No travel times for season "${season}"`); }
  return (a, b) => {
    if (a === b) { return 0; }
    const t = (table[a] && table[a][b]) ?? (table[b] && table[b][a]);
    if (t === undefined) { throw Error(`No ${season} travel time between ${a} and ${b}`); }
    return t;
  };
}

// Visit targets: households with recorded needs, plus a community check-in where the equity floor applies.
function targets(assessment) {
  const list = assessment.households.filter(h => h.score > 0).map(h => ({ ...h, type: 'household' }));
  assessment.communities.filter(c => c.coverage_points > 0 && c.worker).forEach(c => list.push({
    id: `community:${c.id}`, name: `Community check-in · ${c.name}`, community: c.id, worker: c.worker, type: 'community',
    score: c.coverage_points, items: [{ kind: 'coverage', points: c.coverage_points,
      label: c.days_since_visit === null ? 'No visit recorded in this community' : `No visit in this community for ${c.days_since_visit} days` }],
  }));
  return list.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function plan(assessment, resources, { start, season = 'dry' } = {}) {
  const travel = travelTime(resources, season);
  const budget = minutes(resources.working_hours.end) - minutes(resources.working_hours.start);
  const service = resources.service_minutes_per_household;
  const facility = resources.facility;
  const days = workingDays(start, resources);
  const communityName = new Map(assessment.communities.map(c => [c.id, c.name]));
  const pending = targets(assessment);
  const scheduled = new Set();
  const blocked = new Map(); // target id → reasons seen
  const block = (target, reason) => blocked.set(target.id, [...new Set([...(blocked.get(target.id) || []), reason])]);
  const visits = [];

  for (const day of days) {
    const freeVehicles = resources.vehicles.filter(v => v.available.includes(weekday(day)));
    const mine = staff => pending.filter(t => t.worker === staff.id && !scheduled.has(t.id));
    const queue = resources.staff.filter(s => mine(s).length)
      .sort((a, b) => Math.max(...mine(b).map(t => t.score)) - Math.max(...mine(a).map(t => t.score)) || a.id.localeCompare(b.id));
    for (const staff of queue) {
      const work = mine(staff);
      if (!staff.available.includes(weekday(day))) { work.forEach(t => block(t, `${day}: ${staff.name} does not work on ${weekday(day)}`)); continue; }
      if (!freeVehicles.length) { work.forEach(t => block(t, `${day}: no vehicle free (used by a higher-need trip)`)); continue; }
      const trip = buildTrip(work, { travel, budget, service, facility, max: resources.max_households_per_worker_per_day, communityName });
      trip.skipped.forEach(({ target, reason }) => block(target, `${day}: ${reason}`));
      if (!trip.stops.length) { continue; }
      const vehicle = freeVehicles.shift();
      trip.stops.forEach(stop => stop.targets.forEach(t => scheduled.add(t.id)));
      visits.push({ date: day, weekday: weekday(day), worker: staff.id, worker_name: staff.name, vehicle: vehicle.id, ...trip.summary, stops: trip.stops.map(stop => ({
        community: stop.community, community_name: communityName.get(stop.community), arrive_after_minutes: stop.arrive,
        targets: stop.targets.map(t => ({ id: t.id, name: t.name, score: t.score, why: t.items.map(i => `${i.label} (+${i.points})`),
          records: [...new Set(t.items.map(i => i.record).filter(Boolean))], waited_because: blocked.get(t.id) || [] })),
      })) });
    }
  }

  const unmet = pending.filter(t => !scheduled.has(t.id)).map(t => ({ id: t.id, name: t.name, community_name: communityName.get(t.community),
    worker: t.worker, score: t.score, needs: t.items.map(i => i.label),
    why: blocked.get(t.id) || [t.worker ? `Not reached within ${days.length} working days` : 'No responsible worker recorded for this household'] }));
  return { start, season, days, budget_minutes: budget, visits, unmet,
    totals: { targets: pending.length, scheduled: scheduled.size, unmet: unmet.length,
      need_points_scheduled: pending.filter(t => scheduled.has(t.id)).reduce((s, t) => s + t.score, 0),
      need_points_total: pending.reduce((s, t) => s + t.score, 0) } };
}

function buildTrip(work, { travel, budget, service, facility, max, communityName }) {
  const byCommunity = new Map();
  work.forEach(t => byCommunity.set(t.community, [...(byCommunity.get(t.community) || []), t]));
  const order = [...byCommunity.entries()].sort((a, b) => sum(b[1]) - sum(a[1]) || a[0].localeCompare(b[0]));
  const stops = [];
  const skipped = [];
  let at = facility; let used = 0; let travelled = 0; let count = 0;
  for (const [community, list] of order) {
    const there = travel(at, community);
    const back = travel(community, facility);
    const fits = list.filter((t, i) => count + i + 1 <= max && used + there + (i + 1) * service + back <= budget).length;
    if (!fits) {
      const reason = travel(facility, community) * 2 + service > budget
        ? `Round trip to ${communityName.get(community)} (${travel(facility, community) * 2} min) leaves no time for a visit`
        : count >= max ? 'Daily household limit reached on the trip' : `Not enough working time left after nearer stops`;
      list.forEach(target => skipped.push({ target, reason }));
      continue;
    }
    stops.push({ community, arrive: used + there, targets: list.slice(0, fits) });
    list.slice(fits).forEach(target => skipped.push({ target, reason: count + fits >= max ? 'Daily household limit reached on the trip' : 'Working day full' }));
    used += there + fits * service; travelled += there; count += fits; at = community;
  }
  const back = stops.length ? travel(at, facility) : 0;
  return { stops, skipped, summary: { travel_minutes: travelled + back, service_minutes: count * service, total_minutes: used + back, households: count } };
}
const sum = list => list.reduce((s, t) => s + t.score, 0);

module.exports = { plan, workingDays, weekday };
