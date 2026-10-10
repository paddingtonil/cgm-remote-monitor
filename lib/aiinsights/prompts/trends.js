'use strict';

// Trends & Insights prompts (spec 9.1 system, 9.2 user) and the shared
// Therapy Context block (spec 9.4) used by both Trends and Ask Loopy.

const units = require('./units');
const format = require('./format');

const fmt = format.fmt;
const fmtSigned = format.fmtSigned;
const fmtTime12 = format.fmtTime12;
const fmtHour24 = format.fmtHour24;

// Spec lines 957-977, verbatim.
const SYSTEM_TEMPLATE = [
  '{{UNIT_CONTEXT}}'
  , ''
  , 'You are an expert diabetes advisor providing a trends summary for a specific Loop AID user. You have their REAL glucose readings, insulin delivery, carb logs, pump settings, and biometrics. These are actual numbers from their actual pump and CGM — not hypothetical.'
  , '{{PERSONALITY}}'
  , ''
  , 'YOUR #1 RULE — ALWAYS GROUND IN THEIR DATA:'
  , 'Every sentence you write must reference this person\'s specific numbers. Do NOT write generic summaries like "maintaining good control" — write "Your TIR is **87%** with an average glucose of **142 mg/dL** and only **2.1%** time below range." The user can read generic diabetes content anywhere — the value here is that you\'re interpreting THEIR data.'
  , ''
  , 'VOICE: You are speaking directly TO this person. Address them as "you"/"your" everywhere — never "the user", "this user", "this person", or any other third-person reference.'
  , ''
  , 'RESPONSE FORMAT — you MUST use exactly this structure:'
  , ''
  , 'SUMMARY:'
  , 'Write 2-4 sentences summarizing this person\'s glucose control for this period, citing their specific TIR, average glucose, time below/above range, and any notable patterns. Use **bold** for key numbers.'
  , ''
  , 'HIGHLIGHTS:'
  , '- First key observation citing their specific data (one sentence)'
  , '- Second key observation citing their specific data (one sentence)'
  , '- Third key observation citing their specific data (one sentence)'
  , ''
  , 'Keep it concise and actionable. Every highlight must include at least one specific number from their data.'
].join('\n');

const TAB_LABELS = {
  daily: 'Daily'
  , weekly: 'Weekly'
  , monthly: 'Monthly'
};

const NO_DATA = 'No therapy data currently available.';

/**
 * System prompt (spec 9.1).
 * @param {{personality?: string}} [opts]
 */
function systemPrompt (opts) {
  const o = opts || {};
  return SYSTEM_TEMPLATE
    .replace('{{UNIT_CONTEXT}}', units.unitContext())
    .replace('{{PERSONALITY}}', units.personality(o.personality));
}

/**
 * User prompt (spec 9.2).
 * @param {{tab: 'daily'|'weekly'|'monthly', therapyContext: string}} input
 */
function userPrompt (input) {
  const i = input || {};
  const tabLabel = TAB_LABELS[i.tab];
  if (!tabLabel) {
    throw new Error('Unknown trends tab: ' + String(i.tab));
  }
  const ctx = i.therapyContext && i.therapyContext.trim() ? i.therapyContext : NO_DATA;
  return 'Generate a ' + tabLabel + ' trends summary for this user\'s diabetes data:\n\n' + ctx;
}

function sortedSchedule (items) {
  return (items || []).slice().sort(function bySeconds (a, b) {
    return a.startSeconds - b.startSeconds;
  });
}

function scheduleLines (items, decimals, unit) {
  return sortedSchedule(items).map(function eachItem (item) {
    return '  ' + fmtTime12(item.startSeconds) + ': ' + fmt(item.value, decimals) + ' ' + unit;
  });
}

function hasMean (h) {
  return h && typeof h.mean === 'number' && isFinite(h.mean);
}

/**
 * Therapy Context block (spec 9.4), shared by Trends and Ask Loopy.
 * @param {AggregatedData|null} agg
 * @param {{biometricContext?: string}} [opts] biometricContext: pre-rendered
 *   two-space indented lines for the BIOMETRIC DATA block ('' = omit block).
 * @returns {string}
 */
function buildTherapyContext (agg, opts) {
  const o = opts || {};
  if (!agg || !agg.glucose || !agg.glucose.count) {
    return NO_DATA;
  }
  const g = agg.glucose;
  const ins = agg.insulin || {};
  const carbs = agg.carbs || {};
  const settings = agg.settings || {};
  const days = agg.period && typeof agg.period.days === 'number' ? agg.period.days : 0;
  const lines = [];

  lines.push('CURRENT THERAPY SETTINGS:');
  lines.push('Basal Rates:');
  Array.prototype.push.apply(lines, scheduleLines(settings.basal, 2, 'U/hr'));
  lines.push('Carb Ratios:');
  Array.prototype.push.apply(lines, scheduleLines(settings.carbratio, 1, 'g/U'));
  lines.push('Insulin Sensitivity Factors:');
  Array.prototype.push.apply(lines, scheduleLines(settings.sens, 0, 'mg/dL per U'));
  lines.push('Insulin Type: ' + (settings.insulinType || 'Unknown'));
  lines.push('Duration of Insulin Action (DIA): ' +
    (settings.dia === null || settings.dia === undefined ? 'unknown' : fmt(settings.dia, 1)) + ' hours');
  lines.push('');

  lines.push('RECENT GLUCOSE STATISTICS (' + days + ' Days):');
  lines.push('  Average Glucose: ' + fmt(g.mean, 0) + ' mg/dL');
  lines.push('  Time in Range (70-180): ' + fmt(g.tirPct, 1) + '%');
  lines.push('  Time in Tight Range (70-' + agg.tightRangeUpperBound + '): ' + fmt(g.titrPct, 1) + '%');
  lines.push('  Time Below Range (<70): ' + fmt(g.tbrPct, 1) + '%');
  lines.push('  Time Above Range (>180): ' + fmt(g.tarPct, 1) + '%');
  lines.push('  GMI (est. A1C): ' + fmt(g.gmi, 1) + '%');
  lines.push('  Coefficient of Variation: ' + fmt(g.cv, 1) + '%');
  lines.push('  Standard Deviation: ' + fmt(g.sd, 1) + ' mg/dL');
  lines.push('');

  lines.push('INSULIN STATISTICS:');
  lines.push('  Total Daily Insulin (TDI): ' + fmt(ins.tddAvg, 1) + ' U/day');
  lines.push('  TDI Range: ' + fmt(ins.tddMin, 1) + '–' + fmt(ins.tddMax, 1) + ' U/day');
  lines.push('  TDI Variability (CV): ' + fmt(ins.tddCv, 0) + '%');
  if (ins.tddWeekOverWeekPct !== null && ins.tddWeekOverWeekPct !== undefined) {
    lines.push('  TDI Week-over-Week: ' + fmtSigned(ins.tddWeekOverWeekPct, 0) + '%');
  }
  lines.push('  Basal %: ' + fmt(ins.basalPct, 0) + '%');
  lines.push('  Bolus %: ' + fmt(ins.bolusPct, 0) + '%');
  lines.push('  Correction Boluses: ' + (ins.correctionCount || 0));
  if (typeof ins.tddAvg === 'number' && ins.tddAvg > 0) {
    lines.push('  TDI-Derived ISF (Rule of 1800): ' + Math.round(1800 / ins.tddAvg) + ' mg/dL per U');
    lines.push('  TDI-Derived CR (Rule of 500): ' + Math.round(500 / ins.tddAvg) + ' g/U');
  }
  lines.push('');

  lines.push('CARB STATISTICS:');
  lines.push('  Average Daily Carbs: ' + fmt(carbs.dailyAvg, 0) + ' g/day');
  lines.push('  Average Carbs Per Meal: ' + fmt(carbs.perMealAvg, 0) + ' g');
  lines.push('  Total Meals Logged: ' + (carbs.entryCount || 0));
  lines.push('');

  lines.push('HOURLY GLUCOSE AVERAGES:');
  (g.hourly || []).forEach(function eachHour (h, idx) {
    if (hasMean(h)) {
      const hour = typeof h.hour === 'number' ? h.hour : idx;
      lines.push('  ' + fmtHour24(hour) + ' — ' + fmt(h.mean, 0) + ' mg/dL');
    }
  });

  const bio = (o.biometricContext || '').replace(/\s+$/, '');
  if (bio) {
    lines.push('');
    if (!/^BIOMETRIC DATA:/.test(bio)) {
      lines.push('BIOMETRIC DATA:');
    }
    lines.push(bio);
  }

  return lines.join('\n');
}

module.exports = {
  systemPrompt
  , userPrompt
  , buildTherapyContext
  , TAB_LABELS
  , NO_DATA
};
