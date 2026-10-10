'use strict';

// Meal Insights prompts: food-pattern advice (spec 7.3), Pre-Meal Advisor
// (spec 7.4) and Meal Debrief (spec 7.5).

const units = require('./units');
const format = require('./format');

const fmt = format.fmt;

// Spec lines 852-853, verbatim.
const ADVICE_SYSTEM_TEMPLATE = [
  'You are a diabetes meal advisor. Be concise and practical. You are speaking directly to the person eating: address them as "you"/"your", never "the user" or any third-person reference.'
  , '{{UNIT_CONTEXT}}'
].join('\n');

// Spec lines 858-865, verbatim.
const ADVICE_USER_TEMPLATE = [
  'Based on my glucose response pattern for {foodType}:'
  , '- Average carbs: {0}g per meal'
  , '- Peak glucose rise: {0} mg/dL'
  , '- Time to peak: {0} minutes'
  , '- 2h post-meal average: {0} mg/dL'
  , '- 4h post-meal average: {0} mg/dL'
  , ''
  , 'Give me brief, practical advice for managing this food. Include: timing of pre-bolus, any carb ratio considerations, and alternative strategies. Keep it under 4 sentences.'
].join('\n');

// Spec lines 874-874, verbatim.
const PRE_MEAL_SYSTEM = [
  'You are a diabetes pre-meal advisor. Give brief, actionable advice based on this person\'s own history. Keep it under 3 sentences. You are speaking directly to them: address them as "you"/"your", never "the user" or any third-person reference.'
].join('\n');

// Spec lines 889-889, verbatim.
const PRE_MEAL_QUESTION = [
  'What should I consider for bolusing this time? Be specific about timing and approach.'
].join('\n');

// Spec lines 900-900, verbatim.
const DEBRIEF_SYSTEM = [
  'You are a diabetes meal analysis assistant. Analyze predicted vs actual glucose response. Be concise and practical. You are speaking directly to the person who ate the meal: address them as "you"/"your", never "the user" or any third-person reference.'
].join('\n');

// Spec lines 924-924, verbatim.
const DEBRIEF_ANALYZE = [
  'Analyze: What happened vs what was predicted? What did the carbs effectively behave like? What should be learned for next time? Keep it under 5 sentences.'
].join('\n');

// Spec lines 926-926, verbatim.
const DEBRIEF_IMPORTANT = [
  'IMPORTANT: End your response with a line starting with \'LEARNINGS:\' followed by 2-3 short bullet points (one per line, each starting with \'- \'). These will be shown as takeaways.'
].join('\n');

function isSet (v) {
  return v !== null && v !== undefined;
}

// ---- 7.3 advice by food pattern -------------------------------------------

function adviceSystem () {
  return ADVICE_SYSTEM_TEMPLATE.replace('{{UNIT_CONTEXT}}', units.unitContext());
}

/**
 * @param {{foodType: string, avgCarbs: number, peakRise: number, timeToPeakMin: number, post2h: number, post4h: number}} pattern
 */
function adviceUser (pattern) {
  const p = pattern || {};
  return ADVICE_USER_TEMPLATE
    .replace('{foodType}', function replaceFood () { return String(p.foodType); })
    .replace('{0}g per meal', fmt(p.avgCarbs, 0) + 'g per meal')
    .replace('Peak glucose rise: {0}', 'Peak glucose rise: ' + fmt(p.peakRise, 0))
    .replace('Time to peak: {0}', 'Time to peak: ' + fmt(p.timeToPeakMin, 0))
    .replace('2h post-meal average: {0}', '2h post-meal average: ' + fmt(p.post2h, 0))
    .replace('4h post-meal average: {0}', '4h post-meal average: ' + fmt(p.post4h, 0));
}

// ---- 7.4 pre-meal advisor ---------------------------------------------------

function preMealSystem () {
  return PRE_MEAL_SYSTEM;
}

/**
 * @param {{foodType: string, mealCount: number, avgCarbs: number, avgPeakRise: number, avgTimeToPeakMin: number, debriefs?: {effectiveCarbs: number|null, learnings: string[]}[]}} input
 */
function preMealUser (input) {
  const i = input || {};
  const debriefs = Array.isArray(i.debriefs) ? i.debriefs : [];
  const lines = [];
  lines.push('I\'m about to eat ' + i.foodType + '.');
  lines.push('My personal history with this food (' + (i.mealCount || 0) + ' meals):');
  lines.push('- Average carbs: ' + fmt(i.avgCarbs, 0) + 'g');
  if (typeof i.avgPeakRise === 'number' && i.avgPeakRise > 0) {
    lines.push('- Average peak glucose rise: +' + fmt(i.avgPeakRise, 0) + ' mg/dL');
  }
  lines.push('- Average time to peak: ' + fmt(i.avgTimeToPeakMin, 0) + ' min');
  lines.push('');
  if (debriefs.length) {
    lines.push('Recent meal debriefs for this food:');
    debriefs.forEach(function eachDebrief (d) {
      if (isSet(d.effectiveCarbs)) {
        lines.push('- Effective carbs: ~' + fmt(d.effectiveCarbs, 0) + 'g');
      }
      (d.learnings || []).forEach(function eachLearning (l) {
        lines.push('- ' + l);
      });
    });
    lines.push('');
  }
  lines.push(PRE_MEAL_QUESTION);
  return lines.join('\n');
}

/**
 * Local (non-AI) summary shown immediately (spec 7.4).
 * @param {{foodType: string, mealCount: number, avgCarbs: number, avgAbsorptionHours: number, lastDate: string|Date|number}} input
 */
function localPreMealSummary (input) {
  const i = input || {};
  let last = i.lastDate;
  if (last instanceof Date || typeof last === 'number') {
    last = new Date(last).toLocaleDateString('en-US');
  }
  return 'You\'ve had ' + i.foodType + ' ' + (i.mealCount || 0) + ' times. Avg carbs: ' + fmt(i.avgCarbs, 0) +
    'g. Avg absorption: ' + fmt(i.avgAbsorptionHours, 1) + 'h. Last: ' + last + '.';
}

/**
 * Summary after enrichment with glucose-response data (spec 7.4).
 * @param {{foodType: string, mealCount: number, avgPeakRise: number, avgTimeToPeakMin: number, avgCarbs: number}} input
 */
function enrichedPreMealSummary (input) {
  const i = input || {};
  return 'You\'ve had ' + i.foodType + ' ' + (i.mealCount || 0) + ' times. Avg peak: +' + fmt(i.avgPeakRise, 0) +
    ' mg/dL in ' + fmt(i.avgTimeToPeakMin, 0) + ' min. Avg carbs: ' + fmt(i.avgCarbs, 0) + 'g.';
}

// ---- 7.5 meal debrief -------------------------------------------------------

function debriefSystem () {
  return DEBRIEF_SYSTEM;
}

function seriesLines (points) {
  return (points || []).map(function eachPoint (p) {
    return '  ' + fmt(p.min, 0) + 'min: ' + fmt(p.value, 0);
  });
}

/**
 * @param {Object} input
 * @param {string} input.name
 * @param {number} input.carbsEntered
 * @param {{grams:number, confidence:number}|null} [input.aiSuggested]
 * @param {{fat:number, protein:number, fiber:number, cal:number}|null} [input.nutrition]
 * @param {number|null} [input.absorptionHours]
 * @param {number|null} [input.preMealGlucose]
 * @param {{min:number, value:number}[]} input.predicted
 * @param {{min:number, value:number}[]} input.actual
 * @param {{foodType:string, mealCount:number, avgPeakRise:number, avgTimeToPeakMin:number}|null} [input.history]
 * @param {string[]} [input.correctionPatterns]
 */
function debriefUser (input) {
  const i = input || {};
  const lines = [];

  // The spec shows the AI-suggestion fragment on its own line with a leading
  // space; it is a conditional continuation of the "Meal:" line.
  let first = 'Meal: ' + i.name + ', ' + fmt(i.carbsEntered, 0) + 'g carbs entered';
  if (i.aiSuggested && isSet(i.aiSuggested.grams)) {
    first += ' (AI suggested ' + fmt(i.aiSuggested.grams, 0) + 'g, ' + fmt(i.aiSuggested.confidence, 0) + '% confidence)';
  }
  lines.push(first);
  if (i.nutrition) {
    const n = i.nutrition;
    lines.push('Nutrition: ' + fmt(n.fat, 0) + 'g fat, ' + fmt(n.protein, 0) + 'g protein, ' +
      fmt(n.fiber, 0) + 'g fiber, ' + fmt(n.cal, 0) + ' cal');
  }
  if (isSet(i.absorptionHours)) {
    lines.push('Absorption time: ' + fmt(i.absorptionHours, 1) + 'h');
  }
  if (isSet(i.preMealGlucose)) {
    lines.push('Pre-meal glucose: ' + fmt(i.preMealGlucose, 0) + ' mg/dL');
  }
  lines.push('');

  lines.push('Predicted glucose (from Loop at meal time):');
  Array.prototype.push.apply(lines, seriesLines(i.predicted));
  lines.push('');

  lines.push('Actual glucose:');
  Array.prototype.push.apply(lines, seriesLines(i.actual));
  lines.push('');

  if (i.history) {
    const h = i.history;
    lines.push('Historical pattern for ' + h.foodType + ' (' + (h.mealCount || 0) + ' meals): avg peak +' +
      fmt(h.avgPeakRise, 0) + ' mg/dL in ' + fmt(h.avgTimeToPeakMin, 0) + ' min');
    lines.push('');
  }

  const patterns = Array.isArray(i.correctionPatterns) ? i.correctionPatterns : [];
  if (patterns.length) {
    lines.push('Known correction patterns for this meal context:');
    patterns.forEach(function eachPattern (p) {
      lines.push('  • ' + p);
    });
    lines.push('');
  }

  lines.push(DEBRIEF_ANALYZE);
  lines.push('');
  lines.push(DEBRIEF_IMPORTANT);

  return lines.join('\n');
}

module.exports = {
  advice: {
    system: adviceSystem
    , user: adviceUser
  }
  , preMeal: {
    system: preMealSystem
    , user: preMealUser
  }
  , debrief: {
    system: debriefSystem
    , user: debriefUser
  }
  , localPreMealSummary
  , enrichedPreMealSummary
};
