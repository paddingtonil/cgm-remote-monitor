'use strict';

// Unannounced-meal (UAM) analysis for the AI Insights plugin.
// Pure and retrospective: takes AggregatedData, returns the UAM score and the
// detected meal-like glucose episodes. Nothing here touches storage or the
// AI provider, and nothing here is a dosing value.
//
// Method (ICR/ISF baseline, the interpretable benchmark):
//   CHO_eq = ICR * (dG / ISF + I_effect)
// where dG is the CGM rise from episode onset to peak and I_effect is the
// insulin (U) that acted between onset and peak. The result is a
// glucose-equivalent disturbance, not a measured carbohydrate amount, so it is
// reported as a range and withheld when confidence is low.
//
// I_effect counts boluses (including automatic ones) and basal deviations from
// the scheduled rate (temp basals, suspensions) as separate small doses, as Loop
// does. Basal history before the window start is unavailable, so episodes in the
// first DIA of a window carry a note. Fat/protein or exercise effects cannot be
// separated from carbohydrate.

const integrator = require('./basal-integrator');

const localMoment = integrator.localMoment;

const MINUTE = 60 * 1000;

const ROC_WINDOW_STEPS = 3;
const ROC_START = 1.0; // mg/dL per minute over the 15 minute window
const MIN_RISE = 30; // mg/dL, onset to peak
const MIN_START_GLUCOSE = 70;
const MAX_ONSET_BACKTRACK_STEPS = 6;
const PEAK_DROP = 8; // mg/dL below the running peak ends the episode
const PEAK_STALL_MS = 30 * MINUTE;
const MAX_EPISODE_MS = 3 * 60 * MINUTE;
const GAP_MS = 10 * MINUTE;
const MIN_CHO_EQ = 10; // g, below this the rise is explained by insulin/noise

const ANNOUNCE_BEFORE_MS = 15 * MINUTE;
const ANNOUNCE_AFTER_MS = 45 * MINUTE;
const BOLUS_BEFORE_MS = 15 * MINUTE;
const BOLUS_AFTER_MS = 30 * MINUTE;
const MIN_MANUAL_BOLUS = 0.5;

const DEFAULT_DIA_HOURS = 6;
const DEFAULT_PEAK_MIN = 75;
const FAST_PEAK_MIN = 55;
const ACTION_DELAY_MIN = 10;
const PARAM_SPREAD = 0.2; // +/- on ICR and ISF for the reported range

const LONG_EPISODE_MS = 150 * MINUTE;
const HIGH_IOB_UNITS = 1.5;
const TRUNCATED_MS = 30 * MINUTE;

const CAVEAT = 'Glucose-equivalent estimate under simplified assumptions, not a measured carbohydrate amount and not a dosing value.';

function round (value, decimals) {
  if (value === null || value === undefined || !Number.isFinite(value)) { return null; }
  const factor = Math.pow(10, decimals || 0);
  return Math.round(value * factor) / factor;
}

function scheduleValueAt (schedule, seconds) {
  if (!Array.isArray(schedule) || !schedule.length) { return null; }
  const sorted = schedule.slice().sort(function asc (a, b) { return a.startSeconds - b.startSeconds; });
  let value = sorted[sorted.length - 1].value;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].startSeconds <= seconds) { value = sorted[i].value; }
  }
  return Number.isFinite(value) && value > 0 ? value : null;
}

function secondsOfDay (mills, timezone) {
  const m = localMoment(mills, timezone);
  return m.hour() * 3600 + m.minute() * 60 + m.second();
}

/**
 * Cumulative fraction of a bolus that has acted `sinceDose` minutes after delivery.
 * Loop's ExponentialInsulinModel: an action delay, then an exponential curve
 * defined by the action duration (DIA) and the peak activity time. 0..1.
 */
function insulinFraction (sinceDose, diaMin, peakMin) {
  const minutes = sinceDose - ACTION_DELAY_MIN;
  if (!(minutes > 0)) { return 0; }
  if (minutes >= diaMin) { return 1; }
  const peak = Math.min(peakMin, diaMin * 0.4);
  const tau = peak * (1 - peak / diaMin) / (1 - 2 * peak / diaMin);
  const a = 2 * tau / diaMin;
  const s = 1 / (1 - a + (1 + a) * Math.exp(-diaMin / tau));
  // the bracketed term is the IOB-remaining curve; absorbed is its complement
  const f = s * (1 - a) * ((minutes * minutes / (tau * diaMin * (1 - a)) - minutes / tau - 1) * Math.exp(-minutes / tau) + 1);
  return Math.max(0, Math.min(1, f));
}

function rocAt (readings, i) {
  const j = i - ROC_WINDOW_STEPS;
  if (j < 0 || i >= readings.length) { return null; }
  const dt = (readings[i].mills - readings[j].mills) / MINUTE;
  if (dt < 10 || dt > 20) { return null; }
  return (readings[i].mgdl - readings[j].mgdl) / dt;
}

/**
 * Sustained glucose rises: [{ onsetIdx, peakIdx }].
 */
function detectRises (readings) {
  const out = [];
  let i = ROC_WINDOW_STEPS;
  while (i < readings.length - 1) {
    const r0 = rocAt(readings, i);
    const r1 = rocAt(readings, i + 1);
    if (r0 === null || r1 === null || r0 < ROC_START || r1 < ROC_START) { i++; continue; }

    let onset = i - ROC_WINDOW_STEPS;
    let back = 0;
    while (onset > 0 && back < MAX_ONSET_BACKTRACK_STEPS
      && readings[onset].mills - readings[onset - 1].mills <= GAP_MS
      && readings[onset - 1].mgdl < readings[onset].mgdl) {
      onset--;
      back++;
    }

    let peak = i;
    for (let j = i + 1; j < readings.length; j++) {
      if (readings[j].mills - readings[j - 1].mills > GAP_MS) { break; }
      if (readings[j].mills - readings[onset].mills > MAX_EPISODE_MS) { break; }
      if (readings[j].mgdl >= readings[peak].mgdl) { peak = j; }
      if (readings[j].mgdl < readings[peak].mgdl - PEAK_DROP) { break; }
      if (readings[j].mills - readings[peak].mills > PEAK_STALL_MS) { break; }
    }

    if (readings[peak].mgdl - readings[onset].mgdl >= MIN_RISE) {
      out.push({ onsetIdx: onset, peakIdx: peak });
    }
    i = Math.max(peak + 1, i + 1);
  }
  return out;
}

function hasGap (readings, fromIdx, toIdx) {
  for (let k = fromIdx + 1; k <= toIdx; k++) {
    if (readings[k].mills - readings[k - 1].mills > GAP_MS) { return true; }
  }
  return false;
}

function buildEpisode (readings, rise, ctx) {
  const onset = readings[rise.onsetIdx];
  const peak = readings[rise.peakIdx];
  const g0 = onset.mgdl;
  const dG = peak.mgdl - g0;
  const durationMs = peak.mills - onset.mills;

  if (g0 < MIN_START_GLUCOSE) { return null; }

  const carbs = ctx.carbs.filter(function near (c) {
    return c.mills >= onset.mills - ANNOUNCE_BEFORE_MS && c.mills <= onset.mills + ANNOUNCE_AFTER_MS;
  });
  const announced = carbs.length > 0;

  const manualBolus = ctx.boluses.some(function near (b) {
    return !b.automatic && b.units >= MIN_MANUAL_BOLUS
      && b.mills >= onset.mills - BOLUS_BEFORE_MS && b.mills <= onset.mills + BOLUS_AFTER_MS;
  });

  const icr = scheduleValueAt(ctx.carbratio, secondsOfDay(onset.mills, ctx.timezone));
  const isf = scheduleValueAt(ctx.sens, secondsOfDay(onset.mills, ctx.timezone));

  let iobAtOnset = 0;
  let iEffect = 0;
  const doseFrom = onset.mills - ctx.diaMin * MINUTE - ACTION_DELAY_MIN * MINUTE;
  ctx.doses.forEach(function eachBolus (b) {
    if (b.mills < doseFrom || b.mills > peak.mills) { return; }
    const sinceOnset = (onset.mills - b.mills) / MINUTE;
    const sincePeak = (peak.mills - b.mills) / MINUTE;
    iobAtOnset += b.units * (1 - insulinFraction(sinceOnset, ctx.diaMin, ctx.peakMin));
    iEffect += b.units * (insulinFraction(sincePeak, ctx.diaMin, ctx.peakMin)
      - insulinFraction(sinceOnset, ctx.diaMin, ctx.peakMin));
  });

  let choMid = null;
  let choLow = null;
  let choHigh = null;
  if (icr && isf) {
    choMid = icr * (dG / isf + iEffect);
    choLow = icr * (1 - PARAM_SPREAD) * (dG / (isf * (1 + PARAM_SPREAD)) + iEffect);
    choHigh = icr * (1 + PARAM_SPREAD) * (dG / (isf * (1 - PARAM_SPREAD)) + iEffect);
  }
  if (choMid !== null && choMid < MIN_CHO_EQ) { return null; }

  const notes = [];
  let penalty = 0;
  if (!icr || !isf) { penalty += 3; notes.push('no ICR/ISF in profile'); }
  if (hasGap(readings, Math.max(0, rise.onsetIdx - 3), rise.peakIdx)) { penalty += 2; notes.push('CGM gap'); }
  if (onset.mills < ctx.fromMs + ctx.diaMin * MINUTE) { notes.push('basal history before the window is not available'); }
  if (iobAtOnset > HIGH_IOB_UNITS) { penalty += 1; notes.push('high insulin on board'); }
  if (durationMs > LONG_EPISODE_MS) { penalty += 1; notes.push('slow, long rise'); }
  const truncated = peak.mills > ctx.toMs - TRUNCATED_MS;
  if (truncated) { penalty += 2; notes.push('episode runs past the window end'); }
  const confidence = penalty >= 2 ? 'low' : penalty === 1 ? 'medium' : 'high';

  const hasFigure = confidence !== 'low' && choMid !== null;
  return {
    onsetMills: onset.mills
    , peakMills: peak.mills
    , startMgdl: g0
    , peakMgdl: peak.mgdl
    , riseMgdl: dG
    , durationMin: Math.round(durationMs / MINUTE)
    , announced: announced
    , type: announced ? 'announced' : (manualBolus ? 'bolus_no_carbs' : 'unannounced')
    , loggedCarbs: announced ? carbs.reduce(function sum (acc, c) { return acc + c.grams; }, 0) : null
    , insulinEffectUnits: round(iEffect, 2)
    , iobAtOnset: round(iobAtOnset, 2)
    , estimatedCho: hasFigure ? { low: Math.round(choLow), mid: Math.round(choMid), high: Math.round(choHigh) } : null
    , confidence: confidence
    , noPreciseFigure: !hasFigure
    , notes: notes
  };
}

/**
 * @param {Object} agg  AggregatedData (lib/aiinsights/types.js)
 * @returns {{score:(number|null), episodes:Object[], totals:Object, byHour:number[], caveat:string}}
 */
function analyze (agg) {
  const glucose = agg && agg.glucose && Array.isArray(agg.glucose.readings) ? agg.glucose.readings : [];
  const readings = glucose.slice().sort(function asc (a, b) { return a.mills - b.mills; });
  const period = (agg && agg.period) || {};
  const settings = (agg && agg.settings) || {};
  const timezone = period.timezone || settings.timezone || 'UTC';
  const dia = Number(settings.dia);

  const ctx = {
    carbs: agg && agg.carbs && Array.isArray(agg.carbs.entries) ? agg.carbs.entries : []
    , boluses: agg && agg.insulin && Array.isArray(agg.insulin.boluses) ? agg.insulin.boluses : []
    , netBasal: agg && agg.insulin && Array.isArray(agg.insulin.netBasal) ? agg.insulin.netBasal : []
    , carbratio: settings.carbratio
    , sens: settings.sens
    , diaMin: (Number.isFinite(dia) && dia >= 2 ? dia : DEFAULT_DIA_HOURS) * 60
    , peakMin: /fiasp|lyumjev/i.test(String(settings.insulinType || '')) ? FAST_PEAK_MIN : DEFAULT_PEAK_MIN
    , timezone: timezone
    , toMs: Number(period.toMs) || (readings.length ? readings[readings.length - 1].mills : 0)
  };

  // boluses and basal deviations are both insulin the CGM has to be explained against
  ctx.doses = ctx.boluses.map(function toDose (b) { return { mills: b.mills, units: b.units }; })
    .concat(ctx.netBasal)
    .sort(function asc (a, b) { return a.mills - b.mills; });
  ctx.fromMs = Number(period.fromMs) || 0;

  const episodes = detectRises(readings).map(function build (rise) {
    return buildEpisode(readings, rise, ctx);
  }).filter(Boolean);

  const announced = episodes.filter(function isA (e) { return e.announced; }).length;
  const unannounced = episodes.length - announced;
  const days = Number(period.days) > 0 ? Number(period.days) : null;

  const byHour = new Array(24).fill(0);
  let low = 0;
  let high = 0;
  let withFigure = 0;
  episodes.forEach(function tally (e) {
    if (e.announced) { return; }
    byHour[localMoment(e.onsetMills, timezone).hour()]++;
    if (e.estimatedCho) {
      low += e.estimatedCho.low;
      high += e.estimatedCho.high;
      withFigure++;
    }
  });

  return {
    score: episodes.length ? round(announced / episodes.length * 100, 0) : null
    , episodes: episodes
    , totals: {
      episodes: episodes.length
      , announced: announced
      , unannounced: unannounced
      , bolusNoCarbs: episodes.filter(function isB (e) { return e.type === 'bolus_no_carbs'; }).length
      , perDay: days ? round(unannounced / days, 2) : null
      , withoutFigure: unannounced - withFigure
      , estimatedChoPerDay: days && withFigure ? { low: round(low / days, 0), high: round(high / days, 0) } : null
    }
    , byHour: byHour
    , caveat: CAVEAT
  };
}

module.exports = {
  analyze: analyze
  , detectRises: detectRises
  , insulinFraction: insulinFraction
  , scheduleValueAt: scheduleValueAt
};
