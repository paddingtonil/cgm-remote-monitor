'use strict';

// Data aggregation for the AI Insights plugin (spec 6.3, design doc 5).
// Loads one analysis window through the existing storage modules and
// produces the AggregatedData shape documented in lib/aiinsights/types.js.

const cloneDeep = require('lodash/cloneDeep');
const momentTz = require('moment-timezone');
const integrator = require('./basal-integrator');

const localMoment = integrator.localMoment;
const localDayKey = integrator.localDayKey;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const READINGS_PER_DAY = 288;
const MIN_VALID_SGV = 39;
const TREATMENT_LOOKBACK_MS = DAY;
const TREATMENT_COUNT = 20000;
const PROFILE_COUNT = 10;
const CARB_DEDUPE_MS = 5 * MINUTE;
const CARB_DEDUPE_RATIO = 0.2;
const CORRECTION_CARB_WINDOW_MS = 15 * MINUTE;
const INSULIN_TYPE_LOOKBACK_MS = 7 * DAY;
const MMOL_TO_MGDL = 18.018;
const DEFAULT_TIGHT_UPPER = 140;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toMills (doc) {
  if (!doc) { return NaN; }
  if (Number.isFinite(Number(doc.mills))) { return Number(doc.mills); }
  if (Number.isFinite(Number(doc.date))) { return Number(doc.date); }
  const parsed = Date.parse(doc.created_at);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function numberOrNull (value) {
  const n = Number(value);
  return value === undefined || value === null || value === '' || !Number.isFinite(n) ? null : n;
}

function pct (part, whole) {
  return whole > 0 ? part / whole * 100 : 0;
}

function emptyHourly () {
  const hourly = [];
  for (let h = 0; h < 24; h++) { hourly.push({ hour: h, mean: null, count: 0 }); }
  return hourly;
}

// ---------------------------------------------------------------------------
// Glucose (spec 6.3, design 5.2)
// ---------------------------------------------------------------------------

/**
 * @param {{mills:number, mgdl:number}[]} readings
 * @param {string} timezone  IANA zone for local-hour bucketing
 * @param {number} [tightUpper=140]
 * @returns {GlucoseStats}
 */
function computeGlucoseStats (readings, timezone, tightUpper) {
  const upper = Number(tightUpper) || DEFAULT_TIGHT_UPPER;
  const sorted = (readings || []).slice().sort(function asc (a, b) { return a.mills - b.mills; });
  const n = sorted.length;

  let sum = 0;
  let veryHigh = 0, high = 0, inRange = 0, low = 0, veryLow = 0, tight = 0;
  const hourSums = new Array(24).fill(0);
  const hourCounts = new Array(24).fill(0);
  const daySums = {};
  const dayCounts = {};

  sorted.forEach(function eachReading (r) {
    const v = r.mgdl;
    sum += v;
    if (v > 250) { veryHigh++; }
    else if (v > 180) { high++; }
    else if (v >= 70) { inRange++; }
    else if (v >= 54) { low++; }
    else { veryLow++; }
    if (v >= 70 && v <= upper) { tight++; }

    const local = localMoment(r.mills, timezone);
    const hour = local.hour();
    const day = local.format('YYYY-MM-DD');
    hourSums[hour] += v;
    hourCounts[hour]++;
    if (!daySums[day]) {
      daySums[day] = new Array(24).fill(0);
      dayCounts[day] = new Array(24).fill(0);
    }
    daySums[day][hour] += v;
    dayCounts[day][hour]++;
  });

  const mean = n ? sum / n : null;
  let sd = null;
  if (n) {
    let sq = 0;
    sorted.forEach(function eachSq (r) { sq += (r.mgdl - mean) * (r.mgdl - mean); });
    sd = Math.sqrt(sq / n);
  }

  const hourly = emptyHourly().map(function fill (h) {
    return {
      hour: h.hour
      , mean: hourCounts[h.hour] ? hourSums[h.hour] / hourCounts[h.hour] : null
      , count: hourCounts[h.hour]
    };
  });

  const hourlyByDay = {};
  Object.keys(daySums).sort().forEach(function eachDay (day) {
    hourlyByDay[day] = daySums[day].map(function hourMean (s, h) {
      return dayCounts[day][h] ? s / dayCounts[day][h] : null;
    });
  });

  return {
    count: n
    , mean: mean
    , sd: sd
    , cv: mean ? sd / mean * 100 : null
    , veryHighPct: pct(veryHigh, n)
    , highPct: pct(high, n)
    , inRangePct: pct(inRange, n)
    , lowPct: pct(low, n)
    , veryLowPct: pct(veryLow, n)
    , tirPct: pct(inRange, n)
    , titrPct: pct(tight, n)
    , tbrPct: pct(low + veryLow, n)
    , tarPct: pct(high + veryHigh, n)
    , gmi: mean !== null ? 3.31 + 0.02392 * mean : null
    , hourly: hourly
    , hourlyByDay: hourlyByDay
    , readings: sorted
  };
}

// ---------------------------------------------------------------------------
// Carbs (spec 7.1 step 1, design 5.4)
// ---------------------------------------------------------------------------

function toCarbEntry (t) {
  return {
    mills: toMills(t)
    , grams: Number(t.carbs)
    , foodType: typeof t.foodType === 'string' && t.foodType.trim() ? t.foodType.trim() : null
    , protein: numberOrNull(t.protein)
    , fat: numberOrNull(t.fat)
    , fiber: numberOrNull(t.fiber)
    , absorptionTime: numberOrNull(t.absorptionTime)
    , id: t._id ? String(t._id) : null
  };
}

/**
 * Drop a carb entry logged within 5 minutes of the previously kept one when
 * the gram amounts differ by less than 20% of the larger (spec 7.1 step 1).
 * Keeps the first entry. Input need not be sorted; output is ascending.
 * @param {CarbEntry[]} entries
 * @returns {CarbEntry[]}
 */
function dedupeCarbs (entries) {
  const sorted = (entries || []).slice().sort(function asc (a, b) { return a.mills - b.mills; });
  const kept = [];
  sorted.forEach(function eachEntry (entry) {
    const prev = kept[kept.length - 1];
    if (prev) {
      const larger = Math.max(prev.grams, entry.grams);
      const closeInTime = entry.mills - prev.mills <= CARB_DEDUPE_MS;
      const closeInGrams = Math.abs(entry.grams - prev.grams) < CARB_DEDUPE_RATIO * larger;
      if (closeInTime && closeInGrams) { return; }
    }
    kept.push(entry);
  });
  return kept;
}

/**
 * @param {CarbEntry[]} entries  deduplicated
 * @param {number} days
 * @param {string} timezone
 * @returns {CarbStats}
 */
function computeCarbStats (entries, days, timezone) {
  const byHour = new Array(24).fill(0);
  let total = 0;
  (entries || []).forEach(function eachEntry (e) {
    total += e.grams;
    byHour[localMoment(e.mills, timezone).hour()]++;
  });
  const count = (entries || []).length;
  return {
    dailyAvg: days > 0 ? total / days : 0
    , entryCount: count
    , perMealAvg: count ? total / count : null
    , byHour: byHour
    , entries: entries || []
  };
}

// ---------------------------------------------------------------------------
// Boluses (design 5.3 steps 5-6)
// ---------------------------------------------------------------------------

/**
 * @param {Object[]} treatments  raw treatments with mills
 * @param {CarbEntry[]} carbEntries
 * @returns {BolusEvent[]} ascending
 */
function classifyBoluses (treatments, carbEntries) {
  const carbMills = (carbEntries || []).map(function m (c) { return c.mills; })
    .sort(function asc (a, b) { return a - b; });

  function carbsNearby (mills) {
    return carbMills.some(function near (c) {
      return Math.abs(c - mills) <= CORRECTION_CARB_WINDOW_MS;
    });
  }

  return (treatments || [])
    .filter(function isBolus (t) { return t && Number(t.insulin) > 0; })
    .map(function toBolus (t) {
      const mills = toMills(t);
      const carbs = Number(t.carbs) > 0 ? Number(t.carbs) : null;
      const eventType = t.eventType || '';
      const isCorrection = eventType === 'Correction Bolus'
        || (carbs === null && !carbsNearby(mills));
      return {
        mills: mills
        , units: Number(t.insulin)
        , carbs: carbs
        , isCorrection: isCorrection
        , automatic: t.automatic === true
        , eventType: eventType
        , id: t._id ? String(t._id) : null
      };
    })
    .filter(function valid (b) { return Number.isFinite(b.mills); })
    .sort(function asc (a, b) { return a.mills - b.mills; });
}

// ---------------------------------------------------------------------------
// Therapy snapshot (spec 6.2 step 3, design 5.5)
// ---------------------------------------------------------------------------

function timeStringToSeconds (time) {
  if (typeof time !== 'string') { return NaN; }
  const parts = time.split(':');
  return parseInt(parts[0], 10) * 3600 + (parseInt(parts[1], 10) || 0) * 60;
}

function scheduleOf (items, convert) {
  if (!Array.isArray(items)) { return []; }
  return items.map(function toItem (item) {
    let seconds = Number(item.timeAsSeconds);
    if (!Number.isFinite(seconds)) { seconds = timeStringToSeconds(item.time); }
    let value = parseFloat(item.value);
    if (convert) { value = convert(value); }
    return { startSeconds: Number.isFinite(seconds) ? seconds : 0, value: value };
  }).filter(function valid (item) {
    return Number.isFinite(item.value);
  }).sort(function asc (a, b) { return a.startSeconds - b.startSeconds; });
}

/**
 * 'Loop' | 'AAPS' | 'Trio' | 'oref0' | 'Unknown' from devicestatus docs.
 */
function detectSystem (devicestatus) {
  const docs = (devicestatus || []).filter(Boolean);
  if (!docs.length) { return 'Unknown'; }

  function mentions (doc, needle) {
    const device = String(doc.device || '');
    const loopName = doc.loop && doc.loop.name ? String(doc.loop.name) : '';
    return device.indexOf(needle) > -1 || loopName.indexOf(needle) > -1;
  }

  if (docs.some(function trio (d) { return mentions(d, 'Trio'); })) { return 'Trio'; }
  if (docs.some(function loop (d) { return !!d.loop; })) { return 'Loop'; }

  const openaps = docs.filter(function has (d) { return !!d.openaps; });
  if (!openaps.length) { return 'Unknown'; }

  const aaps = openaps.some(function isAaps (d) {
    const device = String(d.device || '');
    const reason = d.openaps.suggested && d.openaps.suggested.reason ? String(d.openaps.suggested.reason) : '';
    return device.indexOf('openaps://') === 0
      && (reason.indexOf('AAPS') > -1 || device.indexOf('AAPS') > -1 || device.indexOf('AndroidAPS') > -1);
  });
  return aaps ? 'AAPS' : 'oref0';
}

function mostCommonInsulinType (treatments, toMs) {
  const counts = {};
  (treatments || []).forEach(function eachTreatment (t) {
    if (!t || !(Number(t.insulin) > 0) || typeof t.insulinType !== 'string' || !t.insulinType.trim()) { return; }
    const mills = toMills(t);
    if (!(mills > toMs - INSULIN_TYPE_LOOKBACK_MS && mills <= toMs)) { return; }
    const key = t.insulinType.trim();
    counts[key] = (counts[key] || 0) + 1;
  });
  let best = null;
  Object.keys(counts).forEach(function pick (key) {
    if (best === null || counts[key] > counts[best]) { best = key; }
  });
  return best;
}

/**
 * @param {Object} profile  profilefunctions instance with data loaded
 * @param {number} toMs
 * @param {{treatments?:Object[], devicestatus?:Object[], timezone?:string}} [extra]
 * @returns {TherapySnapshot}
 */
function buildTherapySnapshot (profile, toMs, extra) {
  extra = extra || {};
  const record = profile && profile.hasData() ? profile.profileFromTime(toMs) : null;
  const storeName = record ? profile.activeProfileToTime(toMs) : null;
  const store = record && record.store && storeName && record.store[storeName] ? record.store[storeName] : {};

  const storeUnits = typeof store.units === 'string' ? store.units : '';
  let isMmol = /mmol/i.test(storeUnits);
  if (!storeUnits && profile && profile.hasData() && profile.getUnits() === 'mmol') { isMmol = true; }

  const sensConvert = isMmol ? function toMgdl (v) { return Math.round(v * MMOL_TO_MGDL); } : null;

  const insulinType = mostCommonInsulinType(extra.treatments, toMs)
    || (typeof store.insulinType === 'string' && store.insulinType.trim() ? store.insulinType.trim() : null)
    || 'Unknown';

  const name = storeName && profile.profileSwitchName ? profile.profileSwitchName(storeName) : storeName;

  return {
    basal: scheduleOf(store.basal)
    , carbratio: scheduleOf(store.carbratio)
    , sens: scheduleOf(store.sens, sensConvert)
    , dia: numberOrNull(store.dia)
    , insulinType: insulinType
    , profileName: name || 'Default'
    , profileId: record && record._id ? String(record._id) : null
    , profileUnits: storeUnits || (isMmol ? 'mmol' : 'mg/dl')
    , system: detectSystem(extra.devicestatus)
    , timezone: extra.timezone || 'UTC'
  };
}

// ---------------------------------------------------------------------------
// Loading (design 5.1)
// ---------------------------------------------------------------------------

function callbackToPromise (invoke) {
  return new Promise(function run (resolve, reject) {
    function done (err, docs) {
      if (err) { reject(err); } else { resolve(docs || []); }
    }
    try {
      invoke(done);
    } catch (err) {
      reject(err);
    }
  });
}

function hasLoopOrOpenaps (doc) {
  return !!doc && (!!doc.loop || !!doc.openaps);
}

function createAggregator (env, ctx) {
  const moment = (ctx && ctx.moment) || momentTz;

  /**
   * Load the raw window from storage (entries, treatments, devicestatus, profiles)
   * in parallel. Treatments are loaded from 24h before the window so a Temp
   * Basal that started earlier is still seen.
   */
  async function loadWindow (fromMs, toMs) {
    const days = Math.max(1, Math.ceil((toMs - fromMs) / DAY));
    const count = READINGS_PER_DAY * days + 100;
    const fromISO = new Date(fromMs).toISOString();
    const toISO = new Date(toMs).toISOString();
    const treatmentFromISO = new Date(fromMs - TREATMENT_LOOKBACK_MS).toISOString();

    const results = await Promise.all([
      callbackToPromise(function listEntries (done) {
        ctx.entries.list({
          find: { date: { $gte: fromMs, $lte: toMs }, type: 'sgv' }
          , sort: { date: 1 }
          , count: count
        }, done);
      })
      , callbackToPromise(function listTreatments (done) {
        ctx.treatments.list({
          find: { created_at: { $gte: treatmentFromISO, $lte: toISO } }
          , sort: { created_at: 1 }
          , count: TREATMENT_COUNT
        }, done);
      })
      , callbackToPromise(function listDevicestatus (done) {
        ctx.devicestatus.list({
          find: { created_at: { $gte: fromISO, $lte: toISO } }
          , sort: { created_at: 1 }
          , count: count
        }, done);
      })
      , callbackToPromise(function listProfiles (done) {
        ctx.profile.list(done, PROFILE_COUNT);
      })
    ]);

    const readings = results[0]
      .filter(function valid (e) {
        return e && Number(e.sgv) >= MIN_VALID_SGV && Number.isFinite(toMills(e));
      })
      .map(function toReading (e) { return { mills: toMills(e), mgdl: Number(e.sgv) }; })
      .sort(function asc (a, b) { return a.mills - b.mills; });

    const treatments = cloneDeep(results[1])
      .filter(function valid (t) { return !!t && t.isValid !== false; })
      .map(function withMills (t) {
        if (t._id) { t._id = String(t._id); }
        t.mills = toMills(t);
        return t;
      })
      .filter(function hasMills (t) { return Number.isFinite(t.mills); })
      .sort(function asc (a, b) { return a.mills - b.mills; });

    const devicestatus = results[2]
      .filter(hasLoopOrOpenaps)
      .map(function withMills (d) {
        if (!Number.isFinite(Number(d.mills))) { d.mills = toMills(d); }
        return d;
      })
      .sort(function asc (a, b) { return toMills(a) - toMills(b); });

    return {
      readings: readings
      , treatments: treatments
      , devicestatus: devicestatus
      , profiles: results[3]
    };
  }

  // profilefunctions instance with Profile Switch / Temp Basal / Combo Bolus
  // treatments attached, derived the same way ddata.processTreatments does.
  function buildProfile (profiles, treatments) {
    const profile = require('../profilefunctions')(null, { moment: moment });
    if (profiles && profiles.length) {
      profile.loadData(cloneDeep(profiles));
    }
    const ddata = require('../data/ddata')();
    ddata.treatments = treatments;
    ddata.processTreatments(true);
    profile.updateTreatments(ddata.profileTreatments, ddata.tempbasalTreatments, ddata.combobolusTreatments);
    return profile;
  }

  /**
   * @param {{fromMs:number, toMs:number, tightRangeUpperBound?:number}} opts
   * @returns {Promise<AggregatedData>}
   */
  async function aggregate (opts) {
    const fromMs = Number(opts.fromMs);
    const toMs = Number(opts.toMs);
    const tightUpper = Number(opts.tightRangeUpperBound) || DEFAULT_TIGHT_UPPER;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      throw new Error('aggregate: fromMs/toMs must be a non-empty window');
    }

    const raw = await loadWindow(fromMs, toMs);
    const profile = buildProfile(raw.profiles, raw.treatments);
    const timezone = (profile.hasData() && profile.getTimezoneAt(toMs)) || 'UTC';
    const days = (toMs - fromMs) / DAY;

    const windowTreatments = raw.treatments.filter(function inWindow (t) {
      return t.mills >= fromMs && t.mills <= toMs;
    });

    const glucose = computeGlucoseStats(raw.readings, timezone, tightUpper);

    const carbEntries = dedupeCarbs(windowTreatments
      .filter(function hasCarbs (t) { return Number(t.carbs) > 0; })
      .map(toCarbEntry));
    const carbs = computeCarbStats(carbEntries, days, timezone);

    const boluses = classifyBoluses(windowTreatments, carbEntries);

    const insulin = integrator.reconstructInsulin({
      profile: profile
      , treatments: windowTreatments
      , boluses: boluses
      , readings: glucose.readings
      , fromMs: fromMs
      , toMs: toMs
      , timezone: timezone
      , devicestatus: raw.devicestatus
    });

    const settings = buildTherapySnapshot(profile, toMs, {
      treatments: windowTreatments
      , devicestatus: raw.devicestatus
      , timezone: timezone
    });

    return {
      period: { days: days, fromMs: fromMs, toMs: toMs, timezone: timezone }
      , glucose: glucose
      , insulin: insulin
      , carbs: carbs
      , settings: settings
      , tightRangeUpperBound: tightUpper
      , devicestatus: raw.devicestatus
      // raw treatments inside the window (Caffeine/Alcohol blocks, debrief
      // lookups); optional in types.js so pure consumers can omit it.
      , treatments: windowTreatments
    };
  }

  return {
    aggregate: aggregate
    , loadWindow: loadWindow
    , buildProfile: buildProfile
  };
}

module.exports = createAggregator;
module.exports.computeGlucoseStats = computeGlucoseStats;
module.exports.computeCarbStats = computeCarbStats;
module.exports.buildTherapySnapshot = buildTherapySnapshot;
module.exports.dedupeCarbs = dedupeCarbs;
module.exports.classifyBoluses = classifyBoluses;
module.exports.detectSystem = detectSystem;
module.exports.toCarbEntry = toCarbEntry;
module.exports.localDayKey = localDayKey;
module.exports.localMoment = localMoment;
