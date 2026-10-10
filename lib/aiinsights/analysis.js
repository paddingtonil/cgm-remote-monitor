'use strict';

// Orchestration of the provider calls (docs/proposals/ai-insights-design.md
// section 9): therapy-settings analysis (9.1), trends (9.2) and chat (9.3).
// Every call goes through service.sendPrompt (budget + usage accounting) and
// every response through validator.js before anything is persisted.

var crypto = require('crypto');
var types = require('./types');
var validator = require('./validator');
var analyzers = require('./analyzers');
var settingsPrompts = require('./prompts/settings');
var trendsPrompts = require('./prompts/trends');
var chatPrompts = require('./prompts/chat');
var format = require('./prompts/format');

var DAY = 24 * 60 * 60 * 1000;
var TRENDS_TABS = { daily: 3, weekly: 7, monthly: 30, stats: 7 };
var THERAPY_CACHE_MS = 5 * 60 * 1000;

function createAnalysis (env, ctx, service) {
  var moment = ctx.moment || require('moment-timezone');
  var context = require('./context')(env, ctx, service);
  var aggCache = { };

  function windowFor (days, nowMs) {
    nowMs = nowMs || Date.now();
    return { fromMs: nowMs - days * DAY, toMs: nowMs, days: days };
  }

  /**
   * Aggregate + local analyses for a period. Cached for 5 minutes per period
   * so chat, pill and trends do not re-read Mongo on every call.
   */
  async function aggregateForPeriod (days, settings, opts) {
    opts = opts || { };
    var key = days + ':' + settings.tightRangeUpperBound;
    var cached = aggCache[key];
    if (!opts.fresh && cached && Date.now() - cached.at < THERAPY_CACHE_MS) {
      return cached.value;
    }
    var w = windowFor(days, opts.nowMs);
    var agg = await service.aggregator.aggregate({
      fromMs: w.fromMs
      , toMs: w.toMs
      , tightRangeUpperBound: settings.tightRangeUpperBound
    });
    var value = {
      agg: agg
      , patterns: analyzers.detectPatterns(agg)
      , score: analyzers.settingsScore(agg)
    };
    aggCache[key] = { at: Date.now(), value: value };
    return value;
  }

  function invalidateCache () { aggCache = { }; }

  // ---- helpers for past suggestions ------------------------------------------

  function scheduleFor (snapshot, settingType) {
    if (settingType === 'basal_rate') { return snapshot.basal; }
    if (settingType === 'carb_ratio') { return snapshot.carbratio; }
    return snapshot.sens;
  }

  function valueAt (schedule, seconds) {
    if (!schedule || !schedule.length) { return null; }
    var sorted = schedule.slice().sort(function asc (a, b) { return a.startSeconds - b.startSeconds; });
    var value = sorted[sorted.length - 1].value;
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].startSeconds <= seconds) { value = sorted[i].value; }
    }
    return value;
  }

  function roundStep (settingType) {
    return validator.GUARDRAILS[settingType].round;
  }

  function describeChange (suggestion) {
    return (suggestion.time_blocks || []).map(function each (b) {
      return format.fmtTime12(b.start_seconds) + '–' + format.fmtTime12(b.end_seconds) + ': ' + b.current_value + ' → ' + b.proposed_value + '.';
    }).join(' ');
  }

  function agoDescription (ms) {
    var minutes = Math.round(ms / 60000);
    if (minutes < 60) { return minutes + ' minutes'; }
    var hours = Math.round(minutes / 60);
    return hours + ' hour' + (hours === 1 ? '' : 's');
  }

  /**
   * Spec 6.2 step 5: suggestions applied in the last 24 h whose proposed
   * values are still what the profile holds now.
   */
  async function collectRecentChanges (settingType, snapshot, nowMs) {
    var since = new Date(nowMs - DAY).toISOString();
    var rows = await service.store.listSuggestions({ setting_type: settingType, status: 'applied', applied_at: { $gte: since } }, 10);
    var schedule = scheduleFor(snapshot, settingType);
    var step = roundStep(settingType);
    return rows.filter(function stillInForce (s) {
      return (s.time_blocks || []).some(function blockMatches (b) {
        var current = valueAt(schedule, b.start_seconds);
        return current !== null && Math.abs(current - b.proposed_value) <= step / 2 + 1e-9;
      });
    }).map(function toChange (s) {
      return {
        applied_ago_text: agoDescription(nowMs - Date.parse(s.applied_at))
        , change_description: describeChange(s)
      };
    });
  }

  /**
   * Spec 6.2 step 6: up to 3 applied suggestions in the last 30 days that
   * carry success criteria and have not been evaluated yet, each with the
   * post-change hourly averages restricted to the hours inside its blocks.
   */
  async function collectPastOutcomes (settingType, agg, nowMs) {
    var since = new Date(nowMs - 30 * DAY).toISOString();
    var rows = await service.store.listSuggestions({
      setting_type: settingType
      , status: 'applied'
      , applied_at: { $gte: since }
      , success_criteria: { $ne: null }
      , evaluation: null
    }, 3);
    var tz = agg.period.timezone;
    return rows.filter(function hasCriteria (s) {
      return s.success_criteria && Array.isArray(s.success_criteria.expected_outcomes) && s.success_criteria.expected_outcomes.length;
    }).map(function toOutcome (s) {
      var appliedMs = Date.parse(s.applied_at);
      var hours = { };
      (s.time_blocks || []).forEach(function eachBlock (b) {
        for (var sec = b.start_seconds; sec < b.end_seconds; sec += 3600) {
          hours[Math.floor(sec / 3600) % 24] = true;
        }
      });
      var sums = { };
      (agg.glucose.readings || []).forEach(function each (r) {
        if (r.mills < appliedMs) { return; }
        var hour = moment.tz(r.mills, tz).hour();
        if (!hours[hour]) { return; }
        if (!sums[hour]) { sums[hour] = { total: 0, count: 0 }; }
        sums[hour].total += r.mgdl;
        sums[hour].count += 1;
      });
      var hourly = [];
      for (var h = 0; h < 24; h++) {
        hourly.push({ hour: h, mean: sums[h] ? sums[h].total / sums[h].count : null, count: sums[h] ? sums[h].count : 0 });
      }
      return {
        record_id: s.record_id
        , applied_days_ago: Math.max(0, Math.floor((nowMs - appliedMs) / DAY))
        , change_description: describeChange(s)
        , evaluation_days: s.success_criteria.evaluation_days || 5
        , expected_outcomes: s.success_criteria.expected_outcomes
        , revert_warnings: s.success_criteria.revert_warnings || []
        , post_change_hourly: hourly
      };
    });
  }

  // ---- 9.1 settings analysis ---------------------------------------------------

  async function analyzeSetting (settingType, shared, progress) {
    var agg = shared.agg;
    var settings = shared.settings;
    var nowMs = shared.nowMs;

    var pastOutcomes = await collectPastOutcomes(settingType, agg, nowMs);
    var recentChanges = await collectRecentChanges(settingType, agg.settings, nowMs);

    var systemPrompt = settingsPrompts.systemPrompt({ personality: settings.aiPersonality });
    var userPrompt = settingsPrompts.userPrompt({
      settingType: settingType
      , agg: agg
      , pastOutcomes: pastOutcomes
      , recentChanges: recentChanges
      , supplementalContext: shared.supplementalContext
      , biometricContext: ''
    });

    var analysisDoc = {
      kind: 'settings'
      , job_id: shared.jobId
      , input: {
        period_days: agg.period.days
        , setting_type: settingType
        , window: { from: new Date(agg.period.fromMs).toISOString(), to: new Date(agg.period.toMs).toISOString() }
        , past_record_ids: pastOutcomes.map(function id (o) { return o.record_id; })
      }
      , aggregate_snapshot: snapshotOf(shared)
      , prompt_chars: { system: systemPrompt.length, user: userPrompt.length }
      , response_text: null
      , parsed: null
      , overall_assessment: ''
      , next_recommended_focus: null
      , provider: null
      , usage_id: null
      , error: null
    };

    var response;
    try {
      response = await service.sendPrompt({ kind: 'settings', systemPrompt: systemPrompt, userPrompt: userPrompt });
    } catch (err) {
      analysisDoc.error = err.message || String(err);
      analysisDoc.provider = { format: service.providerConfig().format, model: service.providerConfig().model, http_status: err.status || null };
      await service.store.insertAnalysis(analysisDoc);
      throw err;
    }

    var parsed = validator.parseSettingsResponse(response.text, {
      settingType: settingType
      , snapshot: agg.settings
      , hourly: agg.glucose.hourly
      , mealCount: agg.carbs.entryCount
      , correctionCount: agg.insulin.correctionCount
    });

    analysisDoc.response_text = response.text;
    analysisDoc.parsed = {
      suggestions: parsed.suggestions
      , pastEvaluations: parsed.pastEvaluations
      , validationNotes: parsed.validationNotes
    };
    analysisDoc.overall_assessment = parsed.overallAssessment;
    analysisDoc.next_recommended_focus = parsed.nextRecommendedFocus;
    analysisDoc.provider = { format: response.format, model: response.model, latency_ms: response.latencyMs, http_status: response.status };
    analysisDoc.usage_id = response.usageRecord && response.usageRecord._id ? String(response.usageRecord._id) : null;
    analysisDoc.error = parsed.error;
    var stored = await service.store.insertAnalysis(analysisDoc);

    // spec 6.2 step 8: write evaluations, supersede older pending, insert new
    var evaluatedAt = new Date(nowMs).toISOString();
    for (var recordId of Object.keys(parsed.pastEvaluations || { })) {
      var evaluation = Object.assign({ }, parsed.pastEvaluations[recordId], { evaluated_at: evaluatedAt, analysis_id: String(stored._id) });
      await service.store.updateSuggestion(recordId, { evaluation: evaluation });
    }

    var inserted = [];
    if (!parsed.error) {
      await service.store.supersedePending(settingType);
      inserted = parsed.suggestions.map(function toDoc (s) {
        return {
          record_id: crypto.randomUUID()
          , created_at: evaluatedAt
          , analysis_id: String(stored._id)
          , setting_type: settingType
          , period_days: agg.period.days
          , time_blocks: s.time_blocks
          , plain_summary: s.plain_summary
          , reasoning: s.reasoning
          , confidence: s.confidence
          , success_criteria: s.success_criteria
          , validation_notes: s.validation_notes || []
          , status: 'pending'
          , status_changed_at: evaluatedAt
          , applied_at: null
          , evaluation: null
          , profile_snapshot_id: agg.settings.profileId || null
          , out_of_recommended_range: outOfRecommended(settingType, s.time_blocks)
        };
      });
      if (inserted.length) {
        await service.store.insertSuggestions(inserted);
      }
    }

    if (progress) { progress(types.SETTING_LABELS[settingType] + ' done'); }

    return {
      analysisId: String(stored._id)
      , settingType: settingType
      , suggestions: inserted
      , pastEvaluations: parsed.pastEvaluations
      , overallAssessment: parsed.overallAssessment
      , nextRecommendedFocus: parsed.nextRecommendedFocus
      , validationNotes: parsed.validationNotes
      , error: parsed.error
      , latencyMs: response.latencyMs
      , estimatedCostUsd: response.usageRecord ? response.usageRecord.estimated_cost_usd : null
    };
  }

  function outOfRecommended (settingType, blocks) {
    var g = validator.GUARDRAILS[settingType];
    return (blocks || []).some(function each (b) { return b.proposed_value < g.recMin || b.proposed_value > g.recMax; });
  }

  function snapshotOf (shared) {
    var g = shared.agg.glucose;
    return {
      tir: g.tirPct, tbr: g.tbrPct, tar: g.tarPct, cv: g.cv, gmi: g.gmi, avg: g.mean, sd: g.sd, count: g.count
      , tdd: shared.agg.insulin.tddAvg
      , basal_pct: shared.agg.insulin.basalPct
      , patterns: shared.patterns
      , score: shared.score
    };
  }

  /**
   * Spec 6.2 orchestration. `settingType` is one of SETTING_TYPES or 'all'.
   */
  async function runSettingsAnalysis (opts) {
    var settings = opts.settings;
    var days = opts.period || settings.analysisPeriod;
    var nowMs = opts.nowMs || Date.now();
    var progress = opts.progress || function noop () { };
    var typesToRun = opts.settingType === 'all' ? types.SETTING_TYPES.slice() : [opts.settingType];

    progress('aggregating ' + days + ' days');
    var data = await aggregateForPeriod(days, settings, { fresh: true, nowMs: nowMs });
    var supplementalContext = await context.buildSupplementalContext(data.agg, settings, { nowMs: nowMs });

    var shared = {
      agg: data.agg
      , patterns: data.patterns
      , score: data.score
      , settings: settings
      , nowMs: nowMs
      , jobId: opts.jobId || null
      , supplementalContext: supplementalContext
    };

    var results = [];
    for (var i = 0; i < typesToRun.length; i++) {
      progress(types.SETTING_LABELS[typesToRun[i]] + ' ' + (i + 1) + '/' + typesToRun.length);
      results.push(await analyzeSetting(typesToRun[i], shared, progress));
    }

    invalidateCache();
    return {
      period: days
      , analyses: results
      , suggestions: results.reduce(function flat (acc, r) { return acc.concat(r.suggestions); }, [])
      , patterns: data.patterns
      , score: data.score
    };
  }

  // ---- 9.2 trends -------------------------------------------------------------------

  function sameLocalDay (isoA, nowMs, tz) {
    return moment.tz(isoA, tz).format('YYYY-MM-DD') === moment.tz(nowMs, tz).format('YYYY-MM-DD');
  }

  async function cachedTrends (tab, settings, nowMs) {
    var latest = await service.store.latestAnalysis({ kind: 'trends', 'input.tab': tab, error: null });
    if (!latest) { return null; }
    var tz = (latest.input && latest.input.timezone) || 'UTC';
    if (!sameLocalDay(latest.created_at, nowMs, tz)) { return null; }
    return latest;
  }

  async function runTrends (opts) {
    var settings = opts.settings;
    var tab = opts.tab;
    var nowMs = opts.nowMs || Date.now();
    var days = TRENDS_TABS[tab];
    var data = await aggregateForPeriod(days, settings, { nowMs: nowMs });
    var therapyContext = trendsPrompts.buildTherapyContext(data.agg, { });
    var systemPrompt = trendsPrompts.systemPrompt({ personality: settings.aiPersonality });
    var userPrompt = trendsPrompts.userPrompt({ tab: tab, therapyContext: therapyContext });

    var doc = {
      kind: 'trends'
      , job_id: opts.jobId || null
      , input: { tab: tab, period_days: days, timezone: data.agg.period.timezone }
      , aggregate_snapshot: snapshotOf({ agg: data.agg, patterns: data.patterns, score: data.score })
      , prompt_chars: { system: systemPrompt.length, user: userPrompt.length }
      , response_text: null
      , parsed: null
      , provider: null
      , usage_id: null
      , error: null
    };
    var response;
    try {
      response = await service.sendPrompt({ kind: 'trends', systemPrompt: systemPrompt, userPrompt: userPrompt });
    } catch (err) {
      doc.error = err.message || String(err);
      await service.store.insertAnalysis(doc);
      throw err;
    }
    var parsed = validator.parseTrends(response.text);
    doc.response_text = response.text;
    doc.parsed = parsed;
    doc.provider = { format: response.format, model: response.model, latency_ms: response.latencyMs, http_status: response.status };
    doc.usage_id = response.usageRecord && response.usageRecord._id ? String(response.usageRecord._id) : null;
    var stored = await service.store.insertAnalysis(doc);
    return trendsView(stored);
  }

  function trendsView (doc) {
    return {
      analysisId: String(doc._id)
      , tab: doc.input.tab
      , periodDays: doc.input.period_days
      , createdAt: doc.created_at
      , summary: doc.parsed ? doc.parsed.summary : ''
      , highlights: doc.parsed ? doc.parsed.highlights : []
      , snapshot: doc.aggregate_snapshot
      , cached: true
    };
  }

  // ---- 9.3 chat ---------------------------------------------------------------------

  async function runChat (opts) {
    var settings = opts.settings;
    var nowMs = opts.nowMs || Date.now();
    var data = await aggregateForPeriod(7, settings, { nowMs: nowMs });
    var dataContext = await context.buildChatContext(data.agg, settings, { nowMs: nowMs });
    var systemPrompt = chatPrompts.systemPrompt({ personality: settings.aiPersonality, context: dataContext });
    var userPrompt = chatPrompts.userPrompt({ message: opts.message, history: opts.history || [] });

    var doc = {
      kind: 'chat'
      , job_id: opts.jobId || null
      , input: { history_length: (opts.history || []).length, message_chars: String(opts.message).length }
      , prompt_chars: { system: systemPrompt.length, user: userPrompt.length }
      , provider: null
      , usage_id: null
      , error: null
    };
    var response;
    try {
      response = await service.sendPrompt({ kind: 'chat', systemPrompt: systemPrompt, userPrompt: userPrompt });
    } catch (err) {
      doc.error = err.message || String(err);
      await service.store.insertAnalysis(doc);
      throw err;
    }
    doc.provider = { format: response.format, model: response.model, latency_ms: response.latencyMs, http_status: response.status };
    doc.usage_id = response.usageRecord && response.usageRecord._id ? String(response.usageRecord._id) : null;
    await service.store.insertAnalysis(doc);
    return { reply: response.text, latencyMs: response.latencyMs };
  }

  // ---- summary for the pill ---------------------------------------------------------

  async function summary () {
    var pending = await service.store.listSuggestions({ status: 'pending' }, 10);
    var last = await service.store.latestAnalysis({ kind: 'settings' });
    return {
      pending: pending.length
      , pendingBySetting: pending.reduce(function count (acc, s) { acc[s.setting_type] = (acc[s.setting_type] || 0) + 1; return acc; }, { })
      , highestConfidence: pending.reduce(function max (acc, s) {
        var order = types.CONFIDENCES;
        return order.indexOf(s.confidence) > order.indexOf(acc) ? s.confidence : acc;
      }, 'low')
      , lastAnalysisAt: last ? last.created_at : null
      , score: last && last.aggregate_snapshot ? last.aggregate_snapshot.score : null
    };
  }

  return {
    TRENDS_TABS: TRENDS_TABS
    , windowFor: windowFor
    , aggregateForPeriod: aggregateForPeriod
    , invalidateCache: invalidateCache
    , collectRecentChanges: collectRecentChanges
    , collectPastOutcomes: collectPastOutcomes
    , describeChange: describeChange
    , runSettingsAnalysis: runSettingsAnalysis
    , runTrends: runTrends
    , cachedTrends: cachedTrends
    , trendsView: trendsView
    , runChat: runChat
    , summary: summary
    , context: context
  };
}

module.exports = createAnalysis;
