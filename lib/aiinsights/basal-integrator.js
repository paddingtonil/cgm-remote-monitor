'use strict';

// Insulin reconstruction for the AI Insights plugin (design doc 5.3, spec 6.3
// and 6.6.2). Nightscout has no dose store, so delivered basal is rebuilt on a
// 5-minute grid from profilefunctions.getTempBasal(), which already combines
// the scheduled basal with Temp Basal and Combo Bolus treatments.
//
// Produces the InsulinStats shape documented in lib/aiinsights/types.js.

const moment = require('moment-timezone');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CELL_MS = 5 * MINUTE;
const CELL_HOURS = 5 / 60;
const SUSPEND_EVENT_TYPES = ['Suspend Pump', 'Pump Suspend'];
const DEFAULT_SUSPEND_MINUTES = 30;
const OVERCORRECTION_WINDOW_MS = 2 * HOUR;
const OVERCORRECTION_THRESHOLD = 180;
const STATUS_MATCH_MS = 5 * MINUTE;

const FIXED_OFFSET_RE = /^[+-]\d{2}:\d{2}$/;

/**
 * A moment at `mills` expressed in `timezone`. Accepts IANA names and the
 * fixed-offset strings (+05:30) profilefunctions.normalizeTimezone produces.
 * Unknown zones fall back to UTC so bucketing never throws.
 */
function localMoment (mills, timezone) {
  if (timezone && FIXED_OFFSET_RE.test(timezone)) {
    return moment(mills).utcOffset(timezone);
  }
  if (timezone && moment.tz.zone(timezone)) {
    return moment.tz(mills, timezone);
  }
  return moment.utc(mills);
}

function localDayKey (mills, timezone) {
  return localMoment(mills, timezone).format('YYYY-MM-DD');
}

function round (value, decimals) {
  const factor = Math.pow(10, decimals || 0);
  return Math.round(value * factor) / factor;
}

function mean (values) {
  if (!values.length) { return null; }
  let sum = 0;
  for (let i = 0; i < values.length; i++) { sum += values[i]; }
  return sum / values.length;
}

function populationCv (values) {
  const avg = mean(values);
  if (avg === null || avg === 0) { return null; }
  let sq = 0;
  for (let i = 0; i < values.length; i++) {
    sq += (values[i] - avg) * (values[i] - avg);
  }
  return Math.sqrt(sq / values.length) / avg * 100;
}

function treatmentMills (t) {
  if (Number.isFinite(Number(t.mills))) { return Number(t.mills); }
  const parsed = Date.parse(t.created_at);
  return Number.isFinite(parsed) ? parsed : NaN;
}

// Explicit suspension treatments as [start, end] intervals (design 5.3 step 3).
function suspendIntervals (treatments) {
  return (treatments || [])
    .filter(function isSuspend (t) {
      return t && SUSPEND_EVENT_TYPES.indexOf(t.eventType) > -1;
    })
    .map(function toInterval (t) {
      const start = treatmentMills(t);
      const minutes = Number(t.duration) > 0 ? Number(t.duration) : DEFAULT_SUSPEND_MINUTES;
      return { start: start, end: start + minutes * MINUTE };
    })
    .filter(function valid (i) { return Number.isFinite(i.start); })
    .sort(function byStart (a, b) { return a.start - b.start; });
}

// devicestatus docs that carry pump.status.suspended, as a sorted list.
function suspendStatuses (devicestatus) {
  return (devicestatus || [])
    .filter(function hasFlag (d) {
      return d && d.pump && d.pump.status && typeof d.pump.status.suspended === 'boolean';
    })
    .map(function toPoint (d) {
      return { mills: treatmentMills(d), suspended: d.pump.status.suspended };
    })
    .filter(function valid (p) { return Number.isFinite(p.mills); })
    .sort(function byMills (a, b) { return a.mills - b.mills; });
}

// Nearest status to `mills` (binary search over the sorted list).
function nearestStatus (statuses, mills) {
  if (!statuses.length) { return null; }
  let lo = 0;
  let hi = statuses.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (statuses[mid].mills < mills) { lo = mid + 1; } else { hi = mid; }
  }
  let best = statuses[lo];
  if (lo > 0 && Math.abs(statuses[lo - 1].mills - mills) < Math.abs(best.mills - mills)) {
    best = statuses[lo - 1];
  }
  return Math.abs(best.mills - mills) <= STATUS_MATCH_MS ? best : null;
}

function intervalActive (intervals, mills) {
  for (let i = 0; i < intervals.length; i++) {
    if (intervals[i].start > mills) { break; }
    if (mills >= intervals[i].start && mills < intervals[i].end) { return true; }
  }
  return false;
}

// Effective and scheduled basal (U/hr) for one grid cell.
function cellRates (profile, mills) {
  const tb = profile.getTempBasal(mills) || {};
  const scheduled = Number(tb.basal);
  let total = Number(tb.totalbasal);
  const treatment = tb.treatment;
  // Loop uploads `rate` without `absolute` on some Temp Basal records;
  // profilefunctions only reads absolute/percent, so honour `rate` here.
  if (treatment && isNaN(Number(treatment.absolute)) && !treatment.percent
    && Number.isFinite(Number(treatment.rate)) && Number(treatment.duration) > 0) {
    total = Number(treatment.rate) + (Number(tb.combobolusbasal) || 0);
  }
  return {
    scheduled: Number.isFinite(scheduled) ? scheduled : 0
    , total: Number.isFinite(total) ? total : 0
  };
}

/**
 * Detect suspension runs and sub-basal minutes over the grid.
 * @returns {{ stats: SuspensionStats, events: {startMills:number,endMills:number,minutes:number}[] }}
 */
function detectSuspensions (cells, readings, periodMinutes) {
  const byHour = [];
  for (let h = 0; h < 24; h++) { byHour.push({ hour: h, minutes: 0 }); }

  const events = [];
  let run = null;
  let subBasalMinutes = 0;

  cells.forEach(function eachCell (cell) {
    if (cell.suspended) {
      byHour[cell.hour].minutes += 5;
      if (run && run.endMills === cell.mills) {
        run.endMills = cell.mills + CELL_MS;
        run.minutes += 5;
      } else {
        run = { startMills: cell.mills, endMills: cell.mills + CELL_MS, minutes: 5 };
        events.push(run);
      }
    } else if (cell.subBasal) {
      subBasalMinutes += 5;
    }
  });

  const sorted = (readings || []).slice().sort(function asc (a, b) { return a.mills - b.mills; });
  let overcorrectionEvents = 0;
  events.forEach(function checkRebound (ev) {
    const limit = ev.endMills + OVERCORRECTION_WINDOW_MS;
    const rebound = sorted.some(function high (r) {
      return r.mills > ev.endMills && r.mills <= limit && r.mgdl > OVERCORRECTION_THRESHOLD;
    });
    if (rebound) { overcorrectionEvents++; }
  });

  const totalMinutes = events.reduce(function sum (acc, ev) { return acc + ev.minutes; }, 0);

  return {
    events: events
    , stats: {
      events: events.length
      , totalMinutes: totalMinutes
      , pctOfPeriod: periodMinutes > 0 ? totalMinutes / periodMinutes * 100 : 0
      , subBasalMinutes: subBasalMinutes
      , overcorrectionEvents: overcorrectionEvents
      , byHour: byHour
    }
  };
}

/**
 * Daily totals from per-cell basal and the bolus list.
 * @returns {DailyInsulin[]} ascending by date
 */
function computeDailyTdd (cells, boluses, timezone) {
  const days = {};
  function day (key) {
    if (!days[key]) { days[key] = { date: key, basal: 0, bolus: 0, total: 0 }; }
    return days[key];
  }
  cells.forEach(function eachCell (cell) {
    day(cell.day).basal += cell.basalUnits;
  });
  (boluses || []).forEach(function eachBolus (b) {
    day(localDayKey(b.mills, timezone)).bolus += b.units;
  });
  return Object.keys(days).sort().map(function finish (key) {
    const d = days[key];
    d.basal = round(d.basal, 3);
    d.bolus = round(d.bolus, 3);
    d.total = round(d.basal + d.bolus, 3);
    return d;
  });
}

/**
 * Week-over-week change of daily TDD, percent, rounded. Null unless there are
 * at least 14 daily entries or the previous week averaged zero.
 */
function weekOverWeek (daily) {
  if (!daily || daily.length < 14) { return null; }
  const last = daily.slice(-7).map(function total (d) { return d.total; });
  const prev = daily.slice(-14, -7).map(function total (d) { return d.total; });
  const prevMean = mean(prev);
  const lastMean = mean(last);
  if (!prevMean) { return null; }
  return Math.round((lastMean - prevMean) / prevMean * 100);
}

// Pump-reported TDD per local day when AAPS / Trio upload it (design 5.3 fallback).
// A reported value is a running daily total, so the day's largest value is kept.
function reportedDailyTdd (devicestatus, timezone) {
  const perDay = {};
  (devicestatus || []).forEach(function eachDoc (d) {
    if (!d) { return; }
    let tdd = d.pump && d.pump.extended ? Number(d.pump.extended.TDD) : NaN;
    if (!Number.isFinite(tdd) && d.openaps && d.openaps.iob) {
      tdd = Number(d.openaps.iob.TDD);
    }
    if (!Number.isFinite(tdd) || tdd <= 0) { return; }
    const mills = treatmentMills(d);
    if (!Number.isFinite(mills)) { return; }
    const key = localDayKey(mills, timezone);
    perDay[key] = Math.max(perDay[key] || 0, tdd);
  });
  return Object.keys(perDay).sort().map(function value (key) { return perDay[key]; });
}

/**
 * Reconstruct insulin delivery over [fromMs, toMs).
 *
 * All days touched by the window are included in `daily`; when the window does
 * not start at local midnight the first and last entries are partial days, and
 * tddAvg/tddMin/tddMax/tddCv are computed over every entry.
 *
 * @param {Object} opts
 * @param {Object} opts.profile       profilefunctions instance with treatments loaded
 * @param {Object[]} opts.treatments  raw treatments (used for explicit suspend events)
 * @param {BolusEvent[]} opts.boluses classified boluses (aggregator.classifyBoluses)
 * @param {{mills:number,mgdl:number}[]} [opts.readings]  for overcorrection detection
 * @param {number} opts.fromMs
 * @param {number} opts.toMs
 * @param {string} opts.timezone
 * @param {Object[]} [opts.devicestatus]  raw docs with loop/openaps
 * @returns {InsulinStats}
 */
function reconstructInsulin (opts) {
  const profile = opts.profile;
  const fromMs = Number(opts.fromMs);
  const toMs = Number(opts.toMs);
  const timezone = opts.timezone || 'UTC';
  const boluses = (opts.boluses || []).filter(function inWindow (b) {
    return b.mills >= fromMs && b.mills <= toMs;
  });

  const suspends = suspendIntervals(opts.treatments);
  const statuses = suspendStatuses(opts.devicestatus);

  const cells = [];
  let basalTotal = 0;
  for (let mills = fromMs; mills < toMs; mills += CELL_MS) {
    // Sample at the cell midpoint: profilefunctions matches a Temp Basal on
    // `time <= endmills`, so sampling the cell start would count one extra
    // cell at every treatment boundary.
    const sample = mills + CELL_MS / 2;
    const rates = cellRates(profile, sample);
    const local = localMoment(mills, timezone);
    let suspended = rates.total === 0 && rates.scheduled > 0;
    if (!suspended && intervalActive(suspends, sample)) { suspended = true; }
    if (!suspended && statuses.length) {
      const status = nearestStatus(statuses, sample);
      if (status && status.suspended) { suspended = true; }
    }
    // a pump that is suspended delivers nothing, whatever the schedule says
    const delivered = suspended ? 0 : rates.total * CELL_HOURS;
    basalTotal += delivered;
    cells.push({
      mills: mills
      , hour: local.hour()
      , day: local.format('YYYY-MM-DD')
      , basalUnits: delivered
      , suspended: suspended
      , subBasal: !suspended && rates.total > 0 && rates.total < rates.scheduled
    });
  }

  const periodMinutes = Math.max(0, (toMs - fromMs) / MINUTE);
  const suspension = detectSuspensions(cells, opts.readings, periodMinutes);
  const daily = computeDailyTdd(cells, boluses, timezone);

  const bolusTotal = boluses.reduce(function sum (acc, b) { return acc + b.units; }, 0);
  const correctionCount = boluses.filter(function corr (b) { return b.isCorrection; }).length;
  const automaticCorrectionCount = boluses.filter(function autoCorr (b) {
    return b.isCorrection && b.automatic;
  }).length;
  const days = Math.max((toMs - fromMs) / DAY, 1 / 288);

  let totals = daily.map(function total (d) { return d.total; });
  let source = 'reconstructed';
  const reported = reportedDailyTdd(opts.devicestatus, timezone);
  if (reported.length) {
    totals = reported;
    source = 'reported';
  }

  const insulinTotal = basalTotal + bolusTotal;

  return {
    tddAvg: totals.length ? round(mean(totals), 2) : null
    , tddMin: totals.length ? round(Math.min.apply(null, totals), 2) : null
    , tddMax: totals.length ? round(Math.max.apply(null, totals), 2) : null
    , tddCv: totals.length ? round(populationCv(totals), 1) : null
    , tddWeekOverWeekPct: weekOverWeek(daily)
    , basalTotal: round(basalTotal, 3)
    , bolusTotal: round(bolusTotal, 3)
    , basalPct: insulinTotal > 0 ? basalTotal / insulinTotal * 100 : null
    , bolusPct: insulinTotal > 0 ? bolusTotal / insulinTotal * 100 : null
    , correctionCount: correctionCount
    , automaticCorrectionCount: automaticCorrectionCount
    , correctionsPerDay: correctionCount / days
    , daily: daily
    , boluses: boluses
    , suspensions: suspension.stats
    , source: source
  };
}

module.exports = {
  reconstructInsulin: reconstructInsulin
  , computeDailyTdd: computeDailyTdd
  , detectSuspensions: detectSuspensions
  , weekOverWeek: weekOverWeek
  , localMoment: localMoment
  , localDayKey: localDayKey
  , SUSPEND_EVENT_TYPES: SUSPEND_EVENT_TYPES
};
