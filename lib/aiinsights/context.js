'use strict';

// Prompt context blocks (spec 6.6 supplemental context, 6.6.15 engagement,
// 9.5 chat DATA blocks). Every block is a plain string in the exact wording
// of the spec; blocks are joined with a blank line, in spec order, and each
// is conditional on its feature flag or on data being present.

var analyzers = require('./analyzers');
var trendsPrompts = require('./prompts/trends');
var format = require('./prompts/format');

var MINUTE = 60 * 1000;
var HOUR = 60 * MINUTE;
var DAY = 24 * HOUR;

function fmt (n, d) { return format.fmt(n, d); }
function fmtSigned (n, d) { return format.fmtSigned(n, d); }

function agoText (minutes) {
  if (minutes === null || minutes === undefined) { return 'unknown'; }
  if (minutes < 60) { return minutes + ' minutes ago'; }
  var h = Math.floor(minutes / 60);
  var m = minutes % 60;
  return h + 'h ' + m + 'm ago';
}

function createContext (env, ctx, service) {
  var moment = ctx.moment || require('moment-timezone');

  function clock (mills, tz) {
    return moment.tz(mills, tz || 'UTC').format('h:mm A');
  }

  function dateTime (mills, tz) {
    return moment.tz(mills, tz || 'UTC').format('MM/dd h:mm A'.replace('dd', 'DD'));
  }

  // ---- 6.6.1 ----------------------------------------------------------------
  function circadianBlock (agg, settings) {
    var sleep = (settings && settings.sleepSchedule) || { };
    var c = analyzers.circadianProfile(agg, { bedHour: sleep.bedHour, wakeHour: sleep.wakeHour });
    var lines = [
      '## Circadian Glucose Profile'
      , '- Estimated bed time: ' + c.bedHour + ':00, wake time: ' + c.wakeHour + ':00'
      , '- Pre-sleep avg glucose: ' + fmt(c.preSleepAvg, 0) + ' mg/dL'
      , '- Overnight avg glucose: ' + fmt(c.overnightAvg, 0) + ' mg/dL'
      , '- Wake glucose: ' + fmt(c.wakeGlucose, 0) + ' mg/dL'
      , '- Rise after wake (2h): ' + fmtSigned(c.riseAfterWake2h, 0) + ' mg/dL'
    ];
    if (c.dawnDetected) {
      lines.push('- ** DAWN PHENOMENON DETECTED: ' + fmt(c.dawnRise, 0) + ' mg/dL rise in 3h before wake **');
    }
    return lines.join('\n');
  }

  // ---- 6.6.2 ----------------------------------------------------------------
  function negativeBasalBlock (agg) {
    var s = analyzers.negativeBasal(agg);
    var heaviest = (s.heaviestHours || []).filter(function has (h) { return h.minutes > 0; })
      .map(function each (h) { return format.fmtHour24(h.hour) + ' (' + Math.round(h.minutes) + 'min)'; });
    var lines = [
      '## Negative Basal / Suspension Analysis'
      , '- Suspension events: ' + s.events
      , '- Total suspension time: ' + Math.round(s.totalMinutes) + ' minutes (' + fmt(s.pctOfPeriod, 1) + '% of period)'
      , '- Sub-scheduled basal time: ' + Math.round(s.subBasalMinutes) + ' minutes'
      , '- Overcorrection events (suspend → rebound >180): ' + s.overcorrectionEvents
    ];
    if (heaviest.length) {
      lines.push('- Heaviest suspension hours: ' + heaviest.join(', '));
    }
    if (s.highSuspensionRate) {
      lines.push('** HIGH SUSPENSION RATE: Frequent insulin suspensions — basal may be too high **');
    }
    if (s.overcorrectionPattern) {
      lines.push('** OVERCORRECTION PATTERN: Suspensions followed by rebound highs suggest settings oscillation **');
    }
    return lines.join('\n');
  }

  // ---- 6.6.4 ----------------------------------------------------------------
  function foodResponseBlock (agg) {
    var patterns = analyzers.foodResponsePatterns(agg);
    if (!patterns.length) { return ''; }
    var lines = ['## Food-Type Response Patterns'];
    patterns.forEach(function each (p) {
      lines.push('- **' + p.foodType + '** (' + p.mealCount + ' meals, avg ' + fmt(p.avgCarbs, 0) + 'g): peak rise '
        + fmt(p.peakRise, 0) + ' mg/dL in ' + fmt(p.timeToPeakMin, 0) + ' min, 2h post ' + fmt(p.post2h, 0)
        + ' mg/dL, 4h post ' + fmt(p.post4h, 0) + ' mg/dL');
    });
    var high = patterns.filter(function h (p) { return p.highImpact; }).map(function n (p) { return p.foodType; });
    if (high.length) {
      lines.push('** HIGH IMPACT FOODS: ' + high.join(', ') + ' cause >60 mg/dL glucose spikes **');
    }
    return lines.join('\n');
  }

  // ---- 6.6.5 ----------------------------------------------------------------
  function caffeineBlock (treatments, nowMs, tz) {
    var entries = analyzers.extractCaffeineEntries(treatments);
    var model = analyzers.caffeineModel(entries, nowMs, { timezone: tz });
    if (!model.intakeCount) { return ''; }
    var lines = [
      '## Caffeine Intake'
      , '- Current estimated caffeine level: ' + fmt(model.currentMg, 0) + ' mg'
      , '- Total caffeine last 24h: ' + fmt(model.total24hMg, 0) + ' mg (' + model.intakeCount + ' intake(s))'
      , '- Last intake: ' + agoText(model.lastIntakeMinutesAgo)
      , '- Peak caffeine level today: ' + fmt(model.peakTodayMg, 0) + ' mg'
    ];
    if (model.level === 'high') {
      lines.push('** HIGH CAFFEINE: Current level >200mg may significantly affect insulin sensitivity and glucose variability **');
    } else if (model.level === 'moderate') {
      lines.push('** MODERATE CAFFEINE: May influence glucose response, especially post-meal **');
    }
    if (model.recent && model.recent.length) {
      lines.push('- Recent entries: ' + model.recent.map(function each (e) {
        return clock(e.mills, tz) + ' ' + e.source + ' (' + fmt(e.mg, 0) + 'mg)';
      }).join('; '));
    }
    return lines.join('\n');
  }

  // ---- 6.6.6 ----------------------------------------------------------------
  function alcoholBlock (treatments, nowMs, tz) {
    var entries = analyzers.extractAlcoholEntries(treatments);
    var model = analyzers.alcoholModel(entries, nowMs, { timezone: tz });
    if (!model.intakeCount) { return ''; }
    var lines = [
      '## Alcohol Intake'
      , '- Current estimated alcohol level: ' + fmt(model.currentDrinks, 1) + ' standard drinks'
      , '- Total drinks last 24h: ' + fmt(model.total24hDrinks, 1) + ' (' + model.intakeCount + ' intake(s))'
      , '- Last drink: ' + agoText(model.lastDrinkMinutesAgo)
      , '- Estimated alcohol clearance: ' + (model.clearanceMills ? clock(model.clearanceMills, tz) : 'cleared')
      , '- Delayed hypoglycemia risk: ' + model.risk
      , '- Risk window ends: ' + (model.riskWindowEndMills ? clock(model.riskWindowEndMills, tz) : 'n/a')
    ];
    if (model.risk === 'HIGH') {
      lines.push('** HIGH ALCOHOL HYPO RISK: Significant delayed hypoglycemia risk. Gluconeogenesis suppressed. Do NOT recommend basal increases. **');
    } else if (model.risk === 'MODERATE') {
      lines.push('** MODERATE ALCOHOL HYPO RISK: Delayed hypoglycemia risk present. Consider reduced confidence in settings changes. **');
    }
    if (model.recent && model.recent.length) {
      lines.push('- Recent entries: ' + model.recent.map(function each (e) {
        return clock(e.mills, tz) + ' ' + e.source + ' (' + fmt(e.drinks, 1) + ' drinks)';
      }).join('; '));
    }
    return lines.join('\n');
  }

  // ---- 6.6.7 ----------------------------------------------------------------
  function cgmQualityBlock (agg) {
    var q = analyzers.cgmSignalQuality(agg);
    var days = Math.round(agg.period.days);
    var tz = agg.period.timezone;
    var lines = [
      'CGM SIGNAL QUALITY (' + days + '-day):'
      , '  Signal gaps detected: ' + q.gaps
      , '  Total estimated readings: ' + q.estimatedReadings
      , '  Longest gap: ' + Math.round(q.longestGapMin) + ' min'
      , '  Average gap: ' + fmt(q.avgGapMin, 0) + ' min'
      , '  Real-time coverage: ' + fmt(q.coveragePct, 1) + '%'
    ];
    if (q.recentGaps && q.recentGaps.length) {
      lines.push('  Recent gaps:');
      q.recentGaps.forEach(function each (g) {
        lines.push('    ' + dateTime(g.startMills, tz) + ': ' + Math.round(g.minutes) + ' min gap, ' + g.estimatedReadings + ' estimated readings');
      });
    }
    return lines.join('\n');
  }

  // ---- 6.6.8 ----------------------------------------------------------------
  function debriefHistoryBlock (debriefs, tz) {
    if (!debriefs || !debriefs.length) { return ''; }
    var lines = ['MEAL DEBRIEF HISTORY (' + debriefs.length + ' debriefs):'];
    debriefs.slice(0, 10).forEach(function each (d) {
      var p = d.parsed || { };
      var input = d.input || { };
      lines.push('  ' + dateTime(input.meal_mills || Date.parse(d.created_at), tz) + ': ' + (input.meal_name || 'Meal')
        + ' — effective ~' + fmt(p.effectiveCarbs, 0) + 'g (predicted peak ' + fmt(p.predictedPeak, 0) + ', actual ' + fmt(p.actualPeak, 0) + ')');
      (p.learnings || []).slice(0, 2).forEach(function eachLearning (l) {
        lines.push('    - ' + l);
      });
    });
    return lines.join('\n');
  }

  // ---- 6.6.15 ---------------------------------------------------------------
  async function engagementStats (store) {
    var recent = await store.listSuggestions({ status: { $in: ['applied', 'reverted', 'dismissed'] } }, 10);
    var counts = { applied: 0, reverted: 0, dismissed: 0, total: recent.length };
    recent.forEach(function each (s) { counts[s.status] = (counts[s.status] || 0) + 1; });
    return counts;
  }

  function engagementBlock (agg, counts) {
    var days = Math.max(1, Math.round(agg.period.days));
    var logged = agg.carbs.entryCount;
    var loggingRate = logged / (days * 3);
    var tar = agg.glucose.tarPct || 0;
    var lines = [
      'USER ENGAGEMENT & ADHERENCE:'
      , '- Carb logging rate: ' + logged + ' meals logged over ' + days + ' days (' + fmt(loggingRate * 100, 0) + '% of ~3/day estimate)'
      , '- Corrections per day: ' + fmt(agg.insulin.correctionsPerDay, 1)
      , '- Recent suggestions: ' + counts.applied + ' applied, ' + counts.reverted + ' reverted, ' + counts.dismissed + ' dismissed (of last ' + counts.total + ')'
    ];
    if (loggingRate < 0.5) {
      lines.push('⚠️ LOW CARB LOGGING (<50% of estimated meals)');
    }
    if (agg.insulin.correctionsPerDay < 0.3 && tar > 20) {
      lines.push('⚠️ FEW CORRECTIONS despite high time-above-range — possible disengagement');
    }
    if (counts.total >= 3 && counts.reverted / counts.total > 0.5) {
      lines.push('⚠️ HIGH SUGGESTION REVERSION (' + fmt(counts.reverted / counts.total * 100, 0) + '% reverted) — user may not trust recommendations');
    }
    return lines.join('\n');
  }

  /**
   * Spec 6.6: blocks in order, each gated by its feature flag.
   * @returns {Promise<string>}
   */
  async function buildSupplementalContext (agg, settings, opts) {
    opts = opts || { };
    var nowMs = opts.nowMs || Date.now();
    var tz = agg.period.timezone;
    var features = (settings && settings.features) || { };
    var treatments = agg.treatments || [];
    var blocks = [];

    if (features.circadian) {
      blocks.push(circadianBlock(agg, settings));
      blocks.push(negativeBasalBlock(agg));
    }
    if (features.foodResponse) {
      blocks.push(foodResponseBlock(agg));
    }
    if (features.caffeineTracking) {
      blocks.push(caffeineBlock(treatments, nowMs, tz));
    }
    if (features.alcoholTracking) {
      blocks.push(alcoholBlock(treatments, nowMs, tz));
    }
    if (features.cgmBackfillDetection) {
      blocks.push(cgmQualityBlock(agg));
    }
    if (features.mealDebrief && service && service.store) {
      var debriefs = await service.store.listAnalyses({ kind: 'debrief', error: null }, 10);
      blocks.push(debriefHistoryBlock(debriefs, tz));
    }
    var counts = service && service.store ? await engagementStats(service.store) : { applied: 0, reverted: 0, dismissed: 0, total: 0 };
    blocks.push(engagementBlock(agg, counts));

    return blocks.filter(function nonEmpty (b) { return b && b.trim(); }).join('\n\n');
  }

  // ---- 9.5 chat blocks ------------------------------------------------------

  /**
   * CURRENT GLUCOSE (REAL-TIME) from the in-memory ddata sgvs (last 3 hours,
   * sampled every ~25 minutes).
   */
  function buildRecentGlucose (sgvs, nowMs, tz) {
    var recent = (sgvs || []).filter(function valid (s) {
      return s && Number(s.mgdl) >= 39 && s.mills <= nowMs && s.mills >= nowMs - 3 * HOUR;
    }).sort(function asc (a, b) { return a.mills - b.mills; });
    if (!recent.length) { return ''; }
    var latest = recent[recent.length - 1];
    var thirtyAgo = recent.filter(function old (s) { return s.mills <= latest.mills - 30 * MINUTE; });
    var trendText = 'stable';
    var delta = null;
    if (thirtyAgo.length) {
      delta = latest.mgdl - thirtyAgo[thirtyAgo.length - 1].mgdl;
      if (delta > 5) { trendText = 'rising'; } else if (delta < -5) { trendText = 'falling'; }
    }
    var lines = [
      'CURRENT GLUCOSE (REAL-TIME):'
      , '  Latest Reading: ' + Math.round(latest.mgdl) + ' mg/dL (' + Math.round((nowMs - latest.mills) / MINUTE) + ' min ago)'
    ];
    if (delta !== null) {
      lines.push('  30-min Trend: ' + trendText + ' (' + fmtSigned(delta, 0) + ' mg/dL)');
    }
    lines.push('  Recent Readings:');
    var lastPrinted = -Infinity;
    recent.forEach(function each (s) {
      if (s.mills - lastPrinted >= 25 * MINUTE) {
        lines.push('    ' + clock(s.mills, tz) + ': ' + Math.round(s.mgdl) + ' mg/dL');
        lastPrinted = s.mills;
      }
    });
    return lines.join('\n');
  }

  /**
   * LAST 7 DAYS block (spec 9.5 item 2, second part).
   */
  function buildLast7Days (agg, nowMs) {
    var tz = agg.period.timezone;
    var today = moment.tz(nowMs, tz);
    var lines = ['LAST 7 DAYS (today is ' + today.format('ddd MM/DD') + '):'
      , 'Hourly Glucose Averages by Day (mg/dL, hours 00-23, "-" = no data):'];
    var byDay = agg.glucose.hourlyByDay || { };
    Object.keys(byDay).sort().slice(-7).forEach(function eachDay (key) {
      var label = moment.tz(key, 'YYYY-MM-DD', tz).format('ddd MM/DD');
      var vals = byDay[key].map(function v (x) { return x === null || x === undefined ? '-' : String(Math.round(x)); });
      lines.push('  ' + label + ': ' + vals.join(' '));
    });
    var since = nowMs - 7 * DAY;
    var boluses = (agg.insulin.boluses || []).filter(function recent (b) { return b.mills >= since; });
    if (boluses.length) {
      lines.push('Boluses:');
      boluses.forEach(function each (b) {
        lines.push('  ' + moment.tz(b.mills, tz).format('ddd MM/DD h:mm A') + ': ' + fmt(b.units, 2) + ' U');
      });
    }
    var carbs = (agg.carbs.entries || []).filter(function recent (c) { return c.mills >= since; });
    if (carbs.length) {
      lines.push('Carb Entries:');
      carbs.forEach(function each (c) {
        lines.push('  ' + moment.tz(c.mills, tz).format('ddd MM/DD h:mm A') + ': ' + Math.round(c.grams) + ' g');
      });
    }
    return lines.join('\n');
  }

  /**
   * LIVE LOOP STATUS (spec 9.5 item 4) from the latest devicestatus carrying
   * `loop` (Loop) or `openaps` (AAPS/Trio/oref0). Design 5.6.
   */
  function buildLiveStatus (devicestatus, agg, nowMs) {
    var docs = (devicestatus || []).filter(function has (d) { return d && (d.loop || d.openaps); });
    if (!docs.length) { return ''; }
    var latest = docs[docs.length - 1];
    var tz = agg ? agg.period.timezone : 'UTC';
    var lines = ['LIVE LOOP STATUS:'];
    var loop = latest.loop;
    var oa = latest.openaps;
    var iob = loop && loop.iob ? loop.iob.iob : (oa && oa.iob ? (oa.iob.iob !== undefined ? oa.iob.iob : null) : null);
    var cob = loop && loop.cob ? loop.cob.cob : (oa && oa.suggested ? oa.suggested.COB : null);
    if (iob !== null && iob !== undefined) { lines.push('  IOB (Insulin On Board): ' + fmt(iob, 2) + ' U'); }
    if (cob !== null && cob !== undefined) { lines.push('  COB (Carbs On Board): ' + Math.round(cob) + ' g'); }

    var enacted = loop ? loop.enacted : (oa ? oa.enacted : null);
    var statusMills = Number(latest.mills) || Date.parse(latest.created_at);
    var recentEnacted = docs.filter(function recent (d) {
      var m = Number(d.mills) || Date.parse(d.created_at);
      var e = d.loop ? d.loop.enacted : (d.openaps ? d.openaps.enacted : null);
      return e && (e.received === true || e.rate !== undefined) && m >= nowMs - 30 * MINUTE;
    });
    var closed = recentEnacted.length > 0;
    var autoBolus = loop && loop.automaticDoseRecommendation && loop.automaticDoseRecommendation.bolusVolume !== undefined;
    lines.push('  Loop Mode: ' + (closed ? 'Closed Loop' : 'Open Loop') + ' (' + (autoBolus ? 'Automatic Bolus' : 'Temp Basal Only') + ')');

    var override = latest.override;
    if (override && override.active) {
      var pct = override.multiplier !== undefined ? Math.round(override.multiplier * 100) + '%' : 'n/a';
      var range = override.currentCorrectionRange ? ' target ' + Math.round(override.currentCorrectionRange.minValue) + '-' + Math.round(override.currentCorrectionRange.maxValue) : '';
      var remaining = 'indefinite';
      if (override.duration && override.timestamp) {
        var endMs = Date.parse(override.timestamp) + override.duration * 1000;
        var left = Math.max(0, endMs - nowMs);
        remaining = Math.floor(left / HOUR) + 'h ' + Math.floor((left % HOUR) / MINUTE) + 'm remaining';
      }
      lines.push('  Active Override: ' + (override.name || 'Custom') + ' (insulin needs ' + pct + ')' + range + ' (' + remaining + ')');
    }
    if (Number.isFinite(statusMills)) {
      lines.push('  Last Loop: ' + Math.round((nowMs - statusMills) / MINUTE) + ' min ago');
    }
    if (enacted && enacted.rate !== undefined && agg && agg.settings && agg.settings.basal && agg.settings.basal.length) {
      var local = moment.tz(nowMs, tz);
      var seconds = local.hours() * 3600 + local.minutes() * 60;
      var scheduled = agg.settings.basal.reduce(function pick (acc, item) { return item.startSeconds <= seconds ? item.value : acc; }, agg.settings.basal[agg.settings.basal.length - 1].value);
      var pctOf = scheduled > 0 ? Math.round(enacted.rate / scheduled * 100) : null;
      lines.push('  Current Delivery: ' + fmt(enacted.rate, 2) + ' U/hr' + (pctOf !== null ? ' (' + pctOf + '% of scheduled)' : ''));
    }
    var predicted = loop && loop.predicted && Array.isArray(loop.predicted.values) ? loop.predicted.values
      : (oa && oa.suggested && oa.suggested.predBGs && Array.isArray(oa.suggested.predBGs.IOB) ? oa.suggested.predBGs.IOB : null);
    if (predicted && predicted.length) {
      var start = loop && loop.predicted && loop.predicted.startDate ? Date.parse(loop.predicted.startDate) : statusMills;
      var in30 = predicted[Math.min(6, predicted.length - 1)];
      var lastIdx = predicted.length - 1;
      lines.push('  Predicted Glucose: ' + Math.round(predicted[0]) + ' now → ' + Math.round(in30) + ' in 30 min → '
        + Math.round(predicted[lastIdx]) + ' at ' + clock(start + lastIdx * 5 * MINUTE, tz));
    }
    if (latest.pump) {
      if (latest.pump.battery && latest.pump.battery.percent !== undefined) {
        lines.push('  Pump Battery: ' + Math.round(latest.pump.battery.percent) + '%');
      }
      if (latest.pump.reservoir !== undefined && latest.pump.reservoir !== null) {
        lines.push('  Reservoir: ' + Math.round(latest.pump.reservoir) + ' U remaining');
      }
    }
    return lines.join('\n');
  }

  /**
   * Full chat DATA context (spec 9.5): real-time glucose, therapy context +
   * last 7 days, supplemental context, live status.
   */
  async function buildChatContext (agg, settings, opts) {
    opts = opts || { };
    var nowMs = opts.nowMs || Date.now();
    var tz = agg.period.timezone;
    var sgvs = (ctx.ddata && ctx.ddata.sgvs) || [];
    var devicestatus = (ctx.ddata && ctx.ddata.devicestatus && ctx.ddata.devicestatus.length) ? ctx.ddata.devicestatus : agg.devicestatus;
    var parts = [
      buildRecentGlucose(sgvs, nowMs, tz)
      , trendsPrompts.buildTherapyContext(agg, { })
      , buildLast7Days(agg, nowMs)
      , await buildSupplementalContext(agg, settings, { nowMs: nowMs })
      , buildLiveStatus(devicestatus, agg, nowMs)
    ];
    return parts.filter(function nonEmpty (p) { return p && p.trim(); }).join('\n\n');
  }

  return {
    circadianBlock: circadianBlock
    , negativeBasalBlock: negativeBasalBlock
    , foodResponseBlock: foodResponseBlock
    , caffeineBlock: caffeineBlock
    , alcoholBlock: alcoholBlock
    , cgmQualityBlock: cgmQualityBlock
    , debriefHistoryBlock: debriefHistoryBlock
    , engagementBlock: engagementBlock
    , engagementStats: engagementStats
    , buildSupplementalContext: buildSupplementalContext
    , buildRecentGlucose: buildRecentGlucose
    , buildLast7Days: buildLast7Days
    , buildLiveStatus: buildLiveStatus
    , buildChatContext: buildChatContext
  };
}

module.exports = createContext;
