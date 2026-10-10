'use strict';

// Pure analyzers over AggregatedData for the AI Insights plugin.
// Spec 6.6.1 (circadian), 6.6.2 (negative basal), 6.6.5 (caffeine),
// 6.6.6 (alcohol), 6.6.7 (CGM signal quality), 6.9 (patterns),
// 6.10 (settings score), 7.1 (food response), 7.2 (meal events).
// Nothing here touches storage; every function takes data in and returns data out.

const integrator = require('./basal-integrator');

const localMoment = integrator.localMoment;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const READINGS_PER_DAY = 288;

const GAP_THRESHOLD_MS = 10 * MINUTE;
const PRE_MEAL_WINDOW_MS = 30 * MINUTE;
const POST_MEAL_WINDOW_MS = 4 * HOUR;
const MIN_POST_MEAL_READINGS = 4;
const MIN_MEALS_PER_FOOD = 2;
const MAX_FOOD_TYPES = 8;
const HIGH_IMPACT_RISE = 60;
const BOLUS_MATCH_BEFORE_MS = 5 * MINUTE;
const BOLUS_MATCH_AFTER_MS = 15 * MINUTE;

const CAFFEINE_HALF_LIFE_HOURS = 5.7;
const CAFFEINE_HIGH_MG = 200;
const CAFFEINE_MODERATE_MG = 100;
const ALCOHOL_DRINKS_PER_HOUR = 1;
const ALCOHOL_RISK_WINDOW_MS = 24 * HOUR;
const ALCOHOL_PEAK_START_MS = 8 * HOUR;
const ALCOHOL_PEAK_END_MS = 12 * HOUR;
const MODEL_SAMPLE_MS = 15 * MINUTE;

const CAFFEINE_PRESETS = [
  { name: 'Coffee (sm)', mg: 95 }
  , { name: 'Coffee (med)', mg: 142 }
  , { name: 'Coffee (lg)', mg: 190 }
  , { name: 'Espresso', mg: 63 }
  , { name: 'Tea (Green)', mg: 28 }
  , { name: 'Tea (Black)', mg: 47 }
  , { name: 'Cola', mg: 34 }
  , { name: 'Energy Drink', mg: 80 }
];

const ALCOHOL_PRESETS = [
  { name: 'Beer (Light)', drinks: 1.0 }
  , { name: 'Beer (Regular)', drinks: 1.0 }
  , { name: 'Beer (Craft/IPA)', drinks: 1.5 }
  , { name: 'Wine (Red/White)', drinks: 1.0 }
  , { name: 'Spirits (neat)', drinks: 1.5 }
  , { name: 'Mixed Drink', drinks: 1.5 }
  , { name: 'Cocktail', drinks: 2.0 }
];

const ALCOHOL_RISK_LEVELS = ['NONE', 'LOW', 'MODERATE', 'HIGH'];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mean (values) {
  const valid = values.filter(function finite (v) { return typeof v === 'number' && Number.isFinite(v); });
  if (!valid.length) { return null; }
  return valid.reduce(function sum (a, b) { return a + b; }, 0) / valid.length;
}

function round (value, decimals) {
  if (value === null || value === undefined || !Number.isFinite(value)) { return null; }
  const factor = Math.pow(10, decimals || 0);
  return Math.round(value * factor) / factor;
}

function hourlyMeans (agg) {
  const hourly = agg && agg.glucose && Array.isArray(agg.glucose.hourly) ? agg.glucose.hourly : [];
  const means = new Array(24).fill(null);
  hourly.forEach(function each (h) {
    if (h && h.hour >= 0 && h.hour < 24) { means[h.hour] = h.mean; }
  });
  return means;
}

function wrapHour (hour) {
  return ((hour % 24) + 24) % 24;
}

function readingsOf (agg) {
  return agg && agg.glucose && Array.isArray(agg.glucose.readings) ? agg.glucose.readings : [];
}

function readingsBetween (readings, startMs, endMs) {
  return readings.filter(function inside (r) { return r.mills >= startMs && r.mills <= endMs; });
}

function entryMills (t) {
  if (Number.isFinite(Number(t.mills))) { return Number(t.mills); }
  const parsed = Date.parse(t.created_at);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function periodDays (agg) {
  const days = agg && agg.period ? Number(agg.period.days) : NaN;
  return Number.isFinite(days) && days > 0 ? days : null;
}

// ---------------------------------------------------------------------------
// 6.6.1 circadian profile
// ---------------------------------------------------------------------------

function circadianProfile (agg, opts) {
  opts = opts || {};
  const bedHour = Number.isFinite(Number(opts.bedHour)) ? wrapHour(Number(opts.bedHour)) : 22;
  const wakeHour = Number.isFinite(Number(opts.wakeHour)) ? wrapHour(Number(opts.wakeHour)) : 7;
  const h = hourlyMeans(agg);

  const overnightHours = [];
  for (let hour = bedHour; hour !== wakeHour; hour = wrapHour(hour + 1)) {
    overnightHours.push(h[hour]);
    if (overnightHours.length > 24) { break; }
  }

  const wake = h[wakeHour];
  const before = mean([h[wrapHour(wakeHour - 3)], h[wrapHour(wakeHour - 2)], h[wrapHour(wakeHour - 1)]]);
  const dawnRise = wake !== null && before !== null ? wake - before : null;
  const twoAfter = h[wrapHour(wakeHour + 2)];

  return {
    bedHour: bedHour
    , wakeHour: wakeHour
    , preSleepAvg: h[wrapHour(bedHour - 1)]
    , overnightAvg: mean(overnightHours)
    , wakeGlucose: wake
    , riseAfterWake2h: wake !== null && twoAfter !== null ? twoAfter - wake : null
    , dawnRise: dawnRise
    , dawnDetected: dawnRise !== null && dawnRise > 15
  };
}

// ---------------------------------------------------------------------------
// 6.6.2 negative basal
// ---------------------------------------------------------------------------

function negativeBasal (agg) {
  const s = agg && agg.insulin && agg.insulin.suspensions ? agg.insulin.suspensions : {};
  const byHour = Array.isArray(s.byHour) ? s.byHour : [];
  const heaviestHours = byHour
    .filter(function used (h) { return h && h.minutes > 0; })
    .sort(function desc (a, b) { return b.minutes - a.minutes || a.hour - b.hour; })
    .slice(0, 3)
    .map(function copy (h) { return { hour: h.hour, minutes: h.minutes }; });

  return {
    events: s.events || 0
    , totalMinutes: s.totalMinutes || 0
    , pctOfPeriod: s.pctOfPeriod || 0
    , subBasalMinutes: s.subBasalMinutes || 0
    , overcorrectionEvents: s.overcorrectionEvents || 0
    , byHour: byHour
    , highSuspensionRate: (s.pctOfPeriod || 0) > 10
    , overcorrectionPattern: (s.overcorrectionEvents || 0) > 3
    , heaviestHours: heaviestHours
  };
}

// ---------------------------------------------------------------------------
// 6.6.7 CGM signal quality
// ---------------------------------------------------------------------------

function cgmSignalQuality (agg) {
  const readings = readingsOf(agg);
  const gaps = [];
  for (let i = 1; i < readings.length; i++) {
    const diff = readings[i].mills - readings[i - 1].mills;
    if (diff > GAP_THRESHOLD_MS) {
      const minutes = diff / MINUTE;
      gaps.push({
        startMills: readings[i - 1].mills
        , minutes: Math.round(minutes)
        , estimatedReadings: Math.max(0, Math.floor(minutes / 5) - 1)
      });
    }
  }

  const days = periodDays(agg);
  const expected = days ? days * READINGS_PER_DAY : null;
  const coverage = expected ? Math.min(100, readings.length / expected * 100) : (readings.length ? 100 : 0);

  return {
    gaps: gaps.length
    , estimatedReadings: gaps.reduce(function sum (acc, g) { return acc + g.estimatedReadings; }, 0)
    , longestGapMin: gaps.length ? Math.max.apply(null, gaps.map(function m (g) { return g.minutes; })) : 0
    , avgGapMin: gaps.length ? mean(gaps.map(function m (g) { return g.minutes; })) : 0
    , coveragePct: coverage
    , recentGaps: gaps.slice(-5)
  };
}

// ---------------------------------------------------------------------------
// 7.1 food response patterns
// ---------------------------------------------------------------------------

// Metrics for one meal, or null when the glucose coverage is insufficient.
function mealResponse (meal, readings) {
  const pre = mean(readingsBetween(readings, meal.mills - PRE_MEAL_WINDOW_MS, meal.mills)
    .map(function v (r) { return r.mgdl; }));
  if (pre === null) { return null; }

  const post = readings.filter(function after (r) {
    return r.mills > meal.mills && r.mills <= meal.mills + POST_MEAL_WINDOW_MS;
  });
  if (post.length < MIN_POST_MEAL_READINGS) { return null; }

  let peak = post[0];
  post.forEach(function findPeak (r) { if (r.mgdl > peak.mgdl) { peak = r; } });

  // trapezoid area of the excursion above the pre-meal mean, in mg/dL·h
  const points = [{ mills: meal.mills, mgdl: pre }].concat(post);
  let auc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = Math.max(0, points[i - 1].mgdl - pre);
    const b = Math.max(0, points[i].mgdl - pre);
    auc += (a + b) / 2 * ((points[i].mills - points[i - 1].mills) / HOUR);
  }

  function windowMean (fromH, toH) {
    return mean(readingsBetween(readings, meal.mills + fromH * HOUR, meal.mills + toH * HOUR)
      .map(function v (r) { return r.mgdl; }));
  }

  return {
    pre: pre
    , peakRise: peak.mgdl - pre
    , timeToPeakMin: (peak.mills - meal.mills) / MINUTE
    , auc: auc
    , post2h: windowMean(1.5, 2.5)
    , post4h: windowMean(3.5, 4.5)
  };
}

function foodResponsePatterns (agg) {
  const readings = readingsOf(agg);
  const entries = agg && agg.carbs && Array.isArray(agg.carbs.entries) ? agg.carbs.entries : [];
  const groups = {};

  entries.forEach(function eachMeal (meal) {
    if (!meal || typeof meal.foodType !== 'string' || !meal.foodType.trim()) { return; }
    const response = mealResponse(meal, readings);
    if (!response) { return; }
    const key = meal.foodType.trim();
    if (!groups[key]) { groups[key] = []; }
    groups[key].push({ grams: meal.grams, response: response });
  });

  return Object.keys(groups)
    .filter(function enough (key) { return groups[key].length >= MIN_MEALS_PER_FOOD; })
    .map(function summarise (key) {
      const meals = groups[key];
      const responses = meals.map(function r (m) { return m.response; });
      const peakRise = mean(responses.map(function v (r) { return r.peakRise; }));
      return {
        foodType: key
        , mealCount: meals.length
        , avgCarbs: mean(meals.map(function g (m) { return m.grams; }))
        , peakRise: peakRise
        , timeToPeakMin: mean(responses.map(function v (r) { return r.timeToPeakMin; }))
        , auc: mean(responses.map(function v (r) { return r.auc; }))
        , post2h: mean(responses.map(function v (r) { return r.post2h; }))
        , post4h: mean(responses.map(function v (r) { return r.post4h; }))
        , highImpact: peakRise > HIGH_IMPACT_RISE
      };
    })
    .sort(function byRise (a, b) { return b.peakRise - a.peakRise; })
    .slice(0, MAX_FOOD_TYPES);
}

// ---------------------------------------------------------------------------
// 7.2 meal events
// ---------------------------------------------------------------------------

/**
 * The most recent `limit` meals, returned in ascending order of time.
 */
function mealEvents (agg, opts) {
  opts = opts || {};
  const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? Number(opts.limit) : 20;
  const readings = readingsOf(agg);
  const boluses = agg && agg.insulin && Array.isArray(agg.insulin.boluses) ? agg.insulin.boluses : [];
  const entries = (agg && agg.carbs && Array.isArray(agg.carbs.entries) ? agg.carbs.entries : [])
    .slice()
    .sort(function asc (a, b) { return a.mills - b.mills; })
    .slice(-limit);

  return entries.map(function toEvent (meal) {
    const glucose = [];
    let last = null;
    readings.forEach(function pick (r) {
      if (r.mills <= meal.mills) { last = r; }
    });
    if (last) {
      glucose.push({ minutesAfter: Math.round((last.mills - meal.mills) / MINUTE), mgdl: last.mgdl });
    }
    readings.forEach(function post (r) {
      if (r.mills > meal.mills && r.mills <= meal.mills + POST_MEAL_WINDOW_MS) {
        glucose.push({ minutesAfter: Math.round((r.mills - meal.mills) / MINUTE), mgdl: r.mgdl });
      }
    });

    const matched = boluses.filter(function near (b) {
      return b.mills >= meal.mills - BOLUS_MATCH_BEFORE_MS && b.mills <= meal.mills + BOLUS_MATCH_AFTER_MS;
    });
    let bolus = null;
    if (matched.length) {
      let largest = matched[0];
      let totalUnits = 0, manualUnits = 0, automaticUnits = 0;
      matched.forEach(function sum (b) {
        totalUnits += b.units;
        if (b.automatic) { automaticUnits += b.units; } else { manualUnits += b.units; }
        if (b.units > largest.units) { largest = b; }
      });
      bolus = {
        totalUnits: totalUnits
        , manualUnits: manualUnits
        , automaticUnits: automaticUnits
        , largestMills: largest.mills
      };
    }

    return {
      id: meal.id || null
      , mills: meal.mills
      , grams: meal.grams
      , foodType: meal.foodType || null
      , glucose: glucose
      , bolus: bolus
      , effectiveCR: bolus && bolus.totalUnits > 0 ? meal.grams / bolus.totalUnits : null
    };
  });
}

// ---------------------------------------------------------------------------
// 6.9 pattern detection
// ---------------------------------------------------------------------------

function fmt (value) {
  return value === null || value === undefined ? 'n/a' : String(round(value, 1));
}

function detectPatterns (agg) {
  const g = agg && agg.glucose ? agg.glucose : {};
  const h = hourlyMeans(agg);
  const patterns = [];

  function add (id, title, severity, description) {
    patterns.push({ id: id, title: title, severity: severity, description: description });
  }

  const overnight = mean(h.slice(0, 6));
  if (overnight !== null) {
    if (overnight < 70) {
      add('overnight_lows', 'Overnight Lows', 'high', 'Average glucose between 00:00 and 05:59 is ' + fmt(overnight) + ' mg/dL (below 70).');
    } else if (overnight < 80) {
      add('overnight_lows', 'Overnight Lows', 'medium', 'Average glucose between 00:00 and 05:59 is ' + fmt(overnight) + ' mg/dL (below 80).');
    }
  }

  const tbr = Number(g.tbrPct);
  if (Number.isFinite(tbr)) {
    if (tbr > 8) {
      add('frequent_lows', 'Frequent Lows', 'high', 'Time below 70 mg/dL is ' + fmt(tbr) + '% (above 8%).');
    } else if (tbr > 4) {
      add('frequent_lows', 'Frequent Lows', 'medium', 'Time below 70 mg/dL is ' + fmt(tbr) + '% (above 4%).');
    }
  }

  if (overnight !== null) {
    if (overnight > 200) {
      add('overnight_highs', 'Overnight Highs', 'high', 'Average glucose between 00:00 and 05:59 is ' + fmt(overnight) + ' mg/dL (above 200).');
    } else if (overnight > 180) {
      add('overnight_highs', 'Overnight Highs', 'medium', 'Average glucose between 00:00 and 05:59 is ' + fmt(overnight) + ' mg/dL (above 180).');
    }
  }

  const dawnFrom = h[3] !== null ? h[3] : h[4];
  const dawnTo = h[7] !== null ? h[7] : h[6];
  if (dawnFrom !== null && dawnTo !== null) {
    const rise = dawnTo - dawnFrom;
    if (rise > 40) {
      add('dawn_phenomenon', 'Dawn Phenomenon', 'high', 'Glucose rises ' + fmt(rise) + ' mg/dL between 03:00 and 07:00 (above 40).');
    } else if (rise > 20) {
      add('dawn_phenomenon', 'Dawn Phenomenon', 'medium', 'Glucose rises ' + fmt(rise) + ' mg/dL between 03:00 and 07:00 (above 20).');
    }
  }

  const windows = [[6, 8], [11, 13], [17, 19]];
  const spiking = windows.filter(function rises (w) {
    return h[w[0]] !== null && h[w[1]] !== null && h[w[1]] - h[w[0]] > 50;
  });
  if (spiking.length === 3) {
    add('post_meal_spikes', 'Post-Meal Spikes', 'high', 'All three meal windows (06-08, 11-13, 17-19) rise more than 50 mg/dL.');
  } else if (spiking.length === 2) {
    add('post_meal_spikes', 'Post-Meal Spikes', 'medium', 'Two of three meal windows (06-08, 11-13, 17-19) rise more than 50 mg/dL.');
  }

  const cv = Number(g.cv);
  if (Number.isFinite(cv)) {
    if (cv > 45) {
      add('high_variability', 'High Variability', 'high', 'Glucose CV is ' + fmt(cv) + '% (above 45%).');
    } else if (cv > 36) {
      add('high_variability', 'High Variability', 'medium', 'Glucose CV is ' + fmt(cv) + '% (above 36%).');
    }
  }

  const tar = Number(g.tarPct);
  if (Number.isFinite(tar)) {
    if (tar > 40) {
      add('consistent_highs', 'Consistent Highs', 'high', 'Time above 180 mg/dL is ' + fmt(tar) + '% (above 40%).');
    } else if (tar > 25) {
      add('consistent_highs', 'Consistent Highs', 'medium', 'Time above 180 mg/dL is ' + fmt(tar) + '% (above 25%).');
    }
  }

  // Consistent Lows: the medium condition (mean < 100 and TBR > 2%) gates the
  // pattern; a mean under 90 within that condition makes it high.
  const avg = Number(g.mean);
  if (Number.isFinite(avg) && Number.isFinite(tbr) && avg < 100 && tbr > 2) {
    if (avg < 90) {
      add('consistent_lows', 'Consistent Lows', 'high', 'Average glucose is ' + fmt(avg) + ' mg/dL with ' + fmt(tbr) + '% time below range.');
    } else {
      add('consistent_lows', 'Consistent Lows', 'medium', 'Average glucose is ' + fmt(avg) + ' mg/dL with ' + fmt(tbr) + '% time below range.');
    }
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// 6.10 settings score
// ---------------------------------------------------------------------------

function tirPoints (tir) {
  if (!Number.isFinite(tir)) { return 0; }
  if (tir >= 90) { return 40; }
  if (tir >= 70) { return (tir - 50) / 40 * 40; }
  if (tir >= 50) { return (tir - 50) / 20 * 16; }
  return 0;
}

function tbrPoints (tbr) {
  if (!Number.isFinite(tbr)) { return 0; }
  if (tbr < 1) { return 25; }
  if (tbr < 4) { return 20; }
  if (tbr < 8) { return 25 - tbr * 2.5; }
  return 0;
}

function cvPoints (cv) {
  if (!Number.isFinite(cv)) { return 0; }
  if (cv < 30) { return 20; }
  if (cv < 36) { return 15; }
  if (cv < 45) { return 8; }
  return 0;
}

function gmiPoints (gmi) {
  if (!Number.isFinite(gmi)) { return 0; }
  if (gmi < 6.5) { return 15; }
  if (gmi < 7.0) { return 12; }
  if (gmi < 7.5) { return 8; }
  if (gmi < 8.0) { return 4; }
  return 0;
}

function gradeFor (total) {
  if (total >= 90) { return 'A'; }
  if (total >= 80) { return 'B'; }
  if (total >= 70) { return 'C'; }
  if (total >= 60) { return 'D'; }
  return 'F';
}

function settingsScore (agg) {
  const g = agg && agg.glucose ? agg.glucose : {};
  const tir = Number(g.inRangePct);
  const tbr = Number(g.tbrPct);
  const components = {
    tir: tirPoints(tir)
    , tbr: tbrPoints(tbr)
    , cv: cvPoints(Number(g.cv))
    , gmi: gmiPoints(Number(g.gmi))
  };
  const total = Math.round(components.tir + components.tbr + components.cv + components.gmi);
  return {
    total: total
    , grade: gradeFor(total)
    , components: components
    , settingsAlreadyOptimal: Number.isFinite(tir) && Number.isFinite(tbr) && tir > 85 && tbr < 4
  };
}

// ---------------------------------------------------------------------------
// 6.6.5 caffeine
// ---------------------------------------------------------------------------

function caffeineLevelAt (entries, atMs) {
  let total = 0;
  entries.forEach(function decay (e) {
    if (e.mills > atMs) { return; }
    const hours = (atMs - e.mills) / HOUR;
    total += e.mg * Math.pow(0.5, hours / CAFFEINE_HALF_LIFE_HOURS);
  });
  return total;
}

function alcoholLevelAt (entries, atMs) {
  let total = 0;
  entries.forEach(function metabolise (e) {
    if (e.mills > atMs) { return; }
    const hours = (atMs - e.mills) / HOUR;
    total += Math.max(0, e.drinks - hours * ALCOHOL_DRINKS_PER_HOUR);
  });
  return total;
}

// Max of the model sampled every 15 min from local midnight to now, plus at
// every intake instant today (the model peaks right at an intake).
function peakSinceMidnight (entries, nowMs, timezone, levelAt) {
  const midnight = localMoment(nowMs, timezone).startOf('day').valueOf();
  let peak = 0;
  for (let t = midnight; t <= nowMs; t += MODEL_SAMPLE_MS) {
    peak = Math.max(peak, levelAt(entries, t));
  }
  entries.forEach(function atIntake (e) {
    if (e.mills >= midnight && e.mills <= nowMs) {
      peak = Math.max(peak, levelAt(entries, e.mills));
    }
  });
  return Math.max(peak, levelAt(entries, nowMs));
}

function sortedValidEntries (entries, valueKey) {
  return (entries || [])
    .filter(function valid (e) {
      return e && Number.isFinite(Number(e.mills)) && Number(e[valueKey]) > 0;
    })
    .map(function norm (e) {
      const copy = { mills: Number(e.mills), source: e.source || null };
      copy[valueKey] = Number(e[valueKey]);
      return copy;
    })
    .sort(function asc (a, b) { return a.mills - b.mills; });
}

function recentOf (entries, nowMs) {
  return entries
    .filter(function last24 (e) { return e.mills <= nowMs && e.mills > nowMs - DAY; })
    .slice(-5)
    .reverse();
}

/**
 * @param {{mills:number, mg:number, source?:string}[]} entries
 * @param {number} nowMs
 * @param {{timezone?:string}} [opts]
 */
function caffeineModel (entries, nowMs, opts) {
  opts = opts || {};
  const timezone = opts.timezone || 'UTC';
  const all = sortedValidEntries(entries, 'mg');
  const past = all.filter(function before (e) { return e.mills <= nowMs; });
  const last24 = past.filter(function recent (e) { return e.mills > nowMs - DAY; });
  const currentMg = caffeineLevelAt(past, nowMs);
  const lastIntake = past.length ? past[past.length - 1] : null;

  let level = 'none';
  if (currentMg > CAFFEINE_HIGH_MG) { level = 'high'; }
  else if (currentMg > CAFFEINE_MODERATE_MG) { level = 'moderate'; }

  return {
    currentMg: currentMg
    , total24hMg: last24.reduce(function sum (acc, e) { return acc + e.mg; }, 0)
    , intakeCount: last24.length
    , lastIntakeMinutesAgo: lastIntake ? Math.round((nowMs - lastIntake.mills) / MINUTE) : null
    , peakTodayMg: peakSinceMidnight(past, nowMs, timezone, caffeineLevelAt)
    , level: level
    , recent: recentOf(past, nowMs)
  };
}

// ---------------------------------------------------------------------------
// 6.6.6 alcohol
// ---------------------------------------------------------------------------

/**
 * @param {{mills:number, drinks:number, source?:string}[]} entries
 * @param {number} nowMs
 * @param {{timezone?:string}} [opts]
 */
function alcoholModel (entries, nowMs, opts) {
  opts = opts || {};
  const timezone = opts.timezone || 'UTC';
  const all = sortedValidEntries(entries, 'drinks');
  const past = all.filter(function before (e) { return e.mills <= nowMs; });
  const last24 = past.filter(function recent (e) { return e.mills > nowMs - ALCOHOL_RISK_WINDOW_MS; });
  const currentDrinks = alcoholLevelAt(past, nowMs);
  const lastDrink = past.length ? past[past.length - 1] : null;
  const peakToday = peakSinceMidnight(past, nowMs, timezone, alcoholLevelAt);

  let clearanceMills = null;
  past.forEach(function clearance (e) {
    const end = e.mills + e.drinks / ALCOHOL_DRINKS_PER_HOUR * HOUR;
    if (end > nowMs && (clearanceMills === null || end > clearanceMills)) { clearanceMills = end; }
  });

  let riskIndex = 0;
  if (last24.length) {
    const basis = Math.max(currentDrinks, peakToday);
    if (basis >= 5) { riskIndex = 3; }
    else if (basis >= 3) { riskIndex = 2; }
    else { riskIndex = 1; }
    const inPeakWindow = last24.some(function peak (e) {
      const since = nowMs - e.mills;
      return since >= ALCOHOL_PEAK_START_MS && since <= ALCOHOL_PEAK_END_MS;
    });
    if (inPeakWindow) { riskIndex = Math.min(3, riskIndex + 1); }
  }

  return {
    currentDrinks: currentDrinks
    , total24hDrinks: last24.reduce(function sum (acc, e) { return acc + e.drinks; }, 0)
    , intakeCount: last24.length
    , lastDrinkMinutesAgo: lastDrink ? Math.round((nowMs - lastDrink.mills) / MINUTE) : null
    , clearanceMills: clearanceMills
    , risk: ALCOHOL_RISK_LEVELS[riskIndex]
    , riskWindowEndMills: last24.length ? last24[last24.length - 1].mills + ALCOHOL_RISK_WINDOW_MS : null
    , recent: recentOf(past, nowMs)
  };
}

// ---------------------------------------------------------------------------
// design 5.8 treatment extraction
// ---------------------------------------------------------------------------

function extractCaffeineEntries (treatments) {
  return (treatments || [])
    .filter(function isCaffeine (t) { return t && t.eventType === 'Caffeine' && Number(t.caffeineMg) > 0; })
    .map(function toEntry (t) {
      return { mills: entryMills(t), mg: Number(t.caffeineMg), source: t.notes || 'Caffeine' };
    })
    .filter(function valid (e) { return Number.isFinite(e.mills); })
    .sort(function asc (a, b) { return a.mills - b.mills; });
}

function extractAlcoholEntries (treatments) {
  return (treatments || [])
    .filter(function isAlcohol (t) { return t && t.eventType === 'Alcohol' && Number(t.drinks) > 0; })
    .map(function toEntry (t) {
      return { mills: entryMills(t), drinks: Number(t.drinks), source: t.notes || 'Alcohol' };
    })
    .filter(function valid (e) { return Number.isFinite(e.mills); })
    .sort(function asc (a, b) { return a.mills - b.mills; });
}

module.exports = {
  circadianProfile: circadianProfile
  , negativeBasal: negativeBasal
  , cgmSignalQuality: cgmSignalQuality
  , foodResponsePatterns: foodResponsePatterns
  , mealEvents: mealEvents
  , detectPatterns: detectPatterns
  , settingsScore: settingsScore
  , caffeineModel: caffeineModel
  , alcoholModel: alcoholModel
  , extractCaffeineEntries: extractCaffeineEntries
  , extractAlcoholEntries: extractAlcoholEntries
  , CAFFEINE_PRESETS: CAFFEINE_PRESETS
  , ALCOHOL_PRESETS: ALCOHOL_PRESETS
};
