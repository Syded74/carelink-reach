/*
  CHT server-side purging (compiled by cht-conf into app_settings.purge). Purged reports stay on the
  server, with their full audit history; they are only removed from users' phones and replication.
  - Community volunteers do not receive service-only planning records (assignments, day plans,
    outreach-day records, follow-up links). Request links stay: they are part of the request's status.
  - Every role stops receiving reports about contacts that an automated test created
    (record_origin 'test', lib/test-records.js) once that run is a day old, so leftovers from earlier
    test runs leave normal task and report views while a running test still works.
*/
module.exports = {
  text_expression: 'every 30 minutes',
  run_every_days: 1,
  fn: function (userCtx, contact, reports) {
    var STAFF = ['carelink_cho', 'carelink_coordinator', 'carelink_supervisor', 'carelink_admin'];
    var SERVICE_ONLY = ['carelink_oi_assignment', 'carelink_oi_day_plan', 'carelink_oi_outreach_day', 'carelink_oi_followup_link'];
    var roles = (userCtx && userCtx.roles) || [];
    var volunteer = roles.indexOf('carelink_community') !== -1 && !STAFF.some(function (r) { return roles.indexOf(r) !== -1; });
    var staleTest = !!contact && contact.record_origin === 'test' && (contact.reported_date || 0) < Date.now() - 24 * 60 * 60 * 1000;
    return reports.filter(function (r) {
      return staleTest || (volunteer && SERVICE_ONLY.indexOf(r.form) !== -1);
    }).map(function (r) { return r._id; });
  },
};
