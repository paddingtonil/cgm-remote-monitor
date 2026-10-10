'use strict';

// REST surface of the AI Insights plugin, mounted at /api/v1/aiinsights
// (docs/proposals/ai-insights-design.md section 7). Every route checks a
// four-part permission so the default `readable` role (*:*:read) never
// matches; billable routes additionally pass the readiness + budget gates.

var consts = require('../../constants');
var types = require('../../aiinsights/types');

var PERM = {
  suggestionsRead: 'api:aiinsights:suggestions:read'
  , suggestionsUpdate: 'api:aiinsights:suggestions:update'
  , analyze: 'api:aiinsights:analyze:create'
  , chat: 'api:aiinsights:chat:create'
  , careportal: 'api:aiinsights:careportal:create'
  , settingsRead: 'api:aiinsights:settings:read'
  , settingsUpdate: 'api:aiinsights:settings:update'
};

var HOUR = 60 * 60 * 1000;
var LIMITS = {
  analyze: { max: 6, windowMs: HOUR }
  , trends: { max: 20, windowMs: HOUR }
  , chat: { max: 30, windowMs: 10 * 60 * 1000 }
  , testConnection: { max: 10, windowMs: HOUR }
  , report: { max: 10, windowMs: HOUR }
};

var SUGGESTION_STATUSES = ['pending', 'applied', 'dismissed', 'reverted', 'superseded'];

function configure (app, wares, ctx) {
  var express = require('express');
  var api = express.Router();
  var service = ctx.aiinsights;
  var limiter = require('../../aiinsights/ratelimit')();

  api.use(wares.sendJSONStatus);
  api.use(wares.jsonParser);

  function fail (res, status, message, description) {
    return res.sendJSONStatus(res, status, message, description);
  }

  function handleError (res, err, what) {
    var status = err && typeof err.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : consts.HTTP_INTERNAL_ERROR;
    if (status >= 500) {
      console.error('[aiinsights] ' + what + ' failed:', err && err.stack ? err.stack : err);
    }
    return fail(res, status, what + ' failed', err && err.message ? err.message : String(err));
  }

  // Locked mode (design 7.2): everything but GET /settings answers 403 when
  // anonymous callers would be permitted to use the feature.
  api.use(function lockedGuard (req, res, next) {
    if (req.method === 'GET' && /^\/aiinsights\/settings\/?$/.test(req.path)) { return next(); }
    if (service.isLocked()) {
      return fail(res, 403, 'AI Insights is locked', service.lockReason());
    }
    next();
  });

  function parsePeriod (value, fallback) {
    var n = parseInt(value, 10);
    if (types.ANALYSIS_PERIODS.indexOf(n) > -1) { return n; }
    return fallback;
  }

  async function settingsOrFail (res) {
    try {
      return await service.getSettings();
    } catch (err) {
      handleError(res, err, 'Loading settings');
      return null;
    }
  }

  async function billableGate (req, res, settings, kind, settingCount) {
    var ready = service.readiness(settings);
    if (!ready.ok) {
      fail(res, ready.status, ready.reason, ready.message);
      return null;
    }
    var gate = await service.budgetGate(settings, kind, settingCount, req.body && req.body.confirmCost === true);
    if (!gate.allowed) {
      res.status(gate.httpStatus).json({
        status: gate.httpStatus
        , message: gate.reason
        , description: gate.reason === 'budget_exceeded'
          ? 'Monthly AI budget reached (' + gate.monthSpentUsd + ' of ' + gate.capUsd + ' USD)'
          : 'Confirm the estimated cost before running this call'
        , requiresConfirmation: gate.reason === 'confirmation_required'
        , estimatedCostUsd: gate.estimatedCostUsd
        , monthSpentUsd: gate.monthSpentUsd
        , capUsd: gate.capUsd
      });
      return null;
    }
    return gate;
  }

  // ---- settings ----------------------------------------------------------------

  api.get('/aiinsights/settings', ctx.authorization.isPermitted(PERM.settingsRead), async function getSettings (req, res) {
    try {
      var settings = await service.getSettings();
      var locked = service.isLocked();
      res.json({
        settings: settings
        , provider: service.publicProviderInfo()
        , privacyAck: service.envCfg.privacyAck
        , locked: locked
        , lockReason: locked ? service.lockReason() : null
        , readiness: service.readiness(settings)
        , periods: types.ANALYSIS_PERIODS
        , personalities: types.PERSONALITIES
        , units: 'mg/dl'
      });
    } catch (err) {
      handleError(res, err, 'Loading settings');
    }
  });

  api.put('/aiinsights/settings', ctx.authorization.isPermitted(PERM.settingsUpdate), async function putSettings (req, res) {
    try {
      var settings = await service.updateSettings(req.body);
      res.json({ settings: settings, readiness: service.readiness(settings) });
    } catch (err) {
      handleError(res, err, 'Saving settings');
    }
  });

  api.post('/aiinsights/settings/test-connection', ctx.authorization.isPermitted(PERM.settingsUpdate)
    , limiter.middleware('test-connection', LIMITS.testConnection), async function testConnection (req, res) {
      try {
        var result = await service.testConnection();
        res.status(result.ok ? 200 : 502).json(result);
      } catch (err) {
        handleError(res, err, 'Connection test');
      }
    });

  api.get('/aiinsights/usage', ctx.authorization.isPermitted(PERM.settingsRead), async function getUsage (req, res) {
    try {
      var month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : undefined;
      res.json(await service.monthUsage(month));
    } catch (err) {
      handleError(res, err, 'Loading usage');
    }
  });

  // ---- local analytics (no provider call) --------------------------------------

  api.get('/aiinsights/aggregate', ctx.authorization.isPermitted(PERM.suggestionsRead), async function getAggregate (req, res) {
    var settings = await settingsOrFail(res);
    if (!settings) { return; }
    try {
      var period = parsePeriod(req.query.period, settings.analysisPeriod);
      var data = await service.analysis.aggregateForPeriod(period, settings, { fresh: req.query.fresh === 'true' });
      var agg = data.agg;
      res.json({
        period: agg.period
        , glucose: Object.assign({ }, agg.glucose, { readings: undefined, hourlyByDay: undefined })
        , insulin: Object.assign({ }, agg.insulin, { boluses: undefined, daily: agg.insulin.daily })
        , carbs: Object.assign({ }, agg.carbs, { entries: undefined })
        , settings: agg.settings
        , tightRangeUpperBound: agg.tightRangeUpperBound
        , patterns: data.patterns
        , score: data.score
      });
    } catch (err) {
      handleError(res, err, 'Aggregation');
    }
  });

  api.get('/aiinsights/summary', ctx.authorization.isPermitted(PERM.suggestionsRead), async function getSummary (req, res) {
    try {
      res.json(await service.analysis.summary());
    } catch (err) {
      handleError(res, err, 'Summary');
    }
  });

  // ---- provider calls (async jobs) ---------------------------------------------

  api.post('/aiinsights/analyze', ctx.authorization.isPermitted(PERM.analyze)
    , limiter.middleware('analyze', LIMITS.analyze), async function postAnalyze (req, res) {
      var body = req.body || { };
      var settingType = body.settingType || 'basal_rate';
      if (settingType !== 'all' && types.SETTING_TYPES.indexOf(settingType) === -1) {
        return fail(res, consts.HTTP_BAD_REQUEST, 'Bad settingType', 'settingType must be all, basal_rate, carb_ratio or insulin_sensitivity');
      }
      var settings = await settingsOrFail(res);
      if (!settings) { return; }
      var period = parsePeriod(body.period, settings.analysisPeriod);
      var settingCount = settingType === 'all' ? 3 : 1;
      var gate = await billableGate(req, res, settings, 'settings', settingCount);
      if (!gate) { return; }

      var job = service.jobs.submit({
        kind: 'settings'
        , key: 'settings:' + settingType + ':' + period
        , run: function run (handle) {
          return service.analysis.runSettingsAnalysis({
            settingType: settingType
            , period: period
            , settings: settings
            , progress: handle.progress
            , jobId: handle.jobId
          });
        }
      });
      res.status(202).json({ jobId: job.jobId, status: job.status, deduplicated: job.deduplicated === true
        , estimatedCostUsd: gate.estimatedCostUsd, warning: gate.warning });
    });

  api.post('/aiinsights/trends', ctx.authorization.isPermitted(PERM.analyze)
    , limiter.middleware('trends', LIMITS.trends), async function postTrends (req, res) {
      var body = req.body || { };
      var tab = body.tab;
      if (!service.analysis.TRENDS_TABS[tab] || tab === 'stats') {
        return fail(res, consts.HTTP_BAD_REQUEST, 'Bad tab', 'tab must be daily, weekly or monthly');
      }
      var settings = await settingsOrFail(res);
      if (!settings) { return; }
      try {
        if (body.refresh !== true) {
          var cached = await service.analysis.cachedTrends(tab, settings, Date.now());
          if (cached) { return res.json(service.analysis.trendsView(cached)); }
        }
      } catch (err) {
        return handleError(res, err, 'Trends cache');
      }
      var gate = await billableGate(req, res, settings, 'trends', 0);
      if (!gate) { return; }
      var job = service.jobs.submit({
        kind: 'trends'
        , key: 'trends:' + tab
        , run: function run (handle) {
          return service.analysis.runTrends({ tab: tab, settings: settings, jobId: handle.jobId });
        }
      });
      res.status(202).json({ jobId: job.jobId, status: job.status, estimatedCostUsd: gate.estimatedCostUsd, warning: gate.warning });
    });

  api.post('/aiinsights/chat', ctx.authorization.isPermitted(PERM.chat)
    , limiter.middleware('chat', LIMITS.chat), async function postChat (req, res) {
      var body = req.body || { };
      var message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message || message.length > 4000) {
        return fail(res, consts.HTTP_BAD_REQUEST, 'Bad message', 'message must be 1..4000 characters');
      }
      var history = Array.isArray(body.history) ? body.history.filter(function valid (h) {
        return h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.length <= 8000;
      }).slice(-10) : [];
      var settings = await settingsOrFail(res);
      if (!settings) { return; }
      var gate = await billableGate(req, res, settings, 'chat', 0);
      if (!gate) { return; }
      var job = service.jobs.submit({
        kind: 'chat'
        , run: function run (handle) {
          return service.analysis.runChat({ message: message, history: history, settings: settings, jobId: handle.jobId });
        }
      });
      res.status(202).json({ jobId: job.jobId, status: job.status, estimatedCostUsd: gate.estimatedCostUsd, warning: gate.warning });
    });

  api.get('/aiinsights/jobs/:jobId', ctx.authorization.isPermitted(PERM.suggestionsRead), function getJob (req, res) {
    var job = service.jobs.get(String(req.params.jobId));
    if (!job) {
      return fail(res, 404, 'Job not found', 'Unknown or expired jobId (jobs are kept for 15 minutes after completion; a server restart drops in-flight jobs)');
    }
    res.json(job);
  });

  // ---- suggestions --------------------------------------------------------------

  api.get('/aiinsights/suggestions', ctx.authorization.isPermitted(PERM.suggestionsRead), async function getSuggestions (req, res) {
    try {
      var filter = { };
      if (typeof req.query.status === 'string') {
        var statuses = req.query.status.split(',').filter(function known (s) { return SUGGESTION_STATUSES.indexOf(s) > -1; });
        if (statuses.length) { filter.status = { $in: statuses }; }
      }
      if (typeof req.query.settingType === 'string' && types.SETTING_TYPES.indexOf(req.query.settingType) > -1) {
        filter.setting_type = req.query.settingType;
      }
      var limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      res.json(await service.store.listSuggestions(filter, limit));
    } catch (err) {
      handleError(res, err, 'Listing suggestions');
    }
  });

  api.patch('/aiinsights/suggestions/:recordId', ctx.authorization.isPermitted(PERM.suggestionsUpdate), async function patchSuggestion (req, res) {
    var status = req.body && req.body.status;
    if (['applied', 'dismissed', 'reverted', 'pending'].indexOf(status) === -1) {
      return fail(res, consts.HTTP_BAD_REQUEST, 'Bad status', 'status must be applied, dismissed, reverted or pending');
    }
    try {
      var existing = await service.store.getSuggestion(req.params.recordId);
      if (!existing) { return fail(res, 404, 'Suggestion not found', String(req.params.recordId)); }
      if (existing.out_of_recommended_range && status === 'applied' && req.body.confirmOutOfRange !== true) {
        return res.status(409).json({ status: 409, message: 'confirmation_required'
          , description: 'This suggestion is outside the recommended range; confirm explicitly to mark it applied'
          , requiresConfirmation: true });
      }
      var now = new Date().toISOString();
      var patch = { status: status, status_changed_at: now };
      if (status === 'applied') {
        patch.applied_at = now;
        patch.evaluation = null;
      }
      var updated = await service.store.updateSuggestion(req.params.recordId, patch);
      service.analysis.invalidateCache();
      res.json(updated);
    } catch (err) {
      handleError(res, err, 'Updating suggestion');
    }
  });

  api.get('/aiinsights/analyses', ctx.authorization.isPermitted(PERM.suggestionsRead), async function getAnalyses (req, res) {
    try {
      var filter = { };
      var kinds = ['settings', 'trends', 'chat', 'meal_advice', 'pre_meal', 'debrief', 'connection_test'];
      if (typeof req.query.kind === 'string' && kinds.indexOf(req.query.kind) > -1) { filter.kind = req.query.kind; }
      var limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
      var rows = await service.store.listAnalyses(filter, limit);
      var developer = req.query.raw === 'true';
      res.json(rows.map(function view (r) {
        if (!developer) { delete r.response_text; }
        return r;
      }));
    } catch (err) {
      handleError(res, err, 'Listing analyses');
    }
  });

  // ---- careportal: caffeine / alcohol (design 5.8) ------------------------------

  api.post('/aiinsights/careportal', ctx.authorization.isPermitted(PERM.careportal), async function postCareportal (req, res) {
    var body = req.body || { };
    var analyzers = service.analyzers;
    var doc;
    function presetValue (list, name, field) {
      var hit = list.find(function byName (p) { return p.name === name; });
      return hit ? hit[field] : undefined;
    }
    if (body.kind === 'caffeine') {
      var presetMg = body.preset ? presetValue(analyzers.CAFFEINE_PRESETS, body.preset, 'mg') : undefined;
      var mg = presetMg !== undefined ? presetMg : Number(body.amount);
      if (!(mg > 0 && mg <= 2000)) { return fail(res, consts.HTTP_BAD_REQUEST, 'Bad amount', 'caffeine mg must be 1..2000 or a known preset'); }
      doc = { eventType: 'Caffeine', caffeineMg: mg, notes: body.preset || body.notes || 'Caffeine' };
    } else if (body.kind === 'alcohol') {
      var presetDrinks = body.preset ? presetValue(analyzers.ALCOHOL_PRESETS, body.preset, 'drinks') : undefined;
      var drinks = presetDrinks !== undefined ? presetDrinks : Number(body.amount);
      if (!(drinks > 0 && drinks <= 30)) { return fail(res, consts.HTTP_BAD_REQUEST, 'Bad amount', 'drinks must be 0.1..30 or a known preset'); }
      doc = { eventType: 'Alcohol', drinks: drinks, notes: body.preset || body.notes || 'Alcohol' };
    } else {
      return fail(res, consts.HTTP_BAD_REQUEST, 'Bad kind', 'kind must be caffeine or alcohol');
    }
    var created = body.created_at && !isNaN(Date.parse(body.created_at)) ? new Date(body.created_at).toISOString() : new Date().toISOString();
    doc.created_at = created;
    doc.enteredBy = 'aiinsights';
    ctx.treatments.create([doc], function created_cb (err, result) {
      if (err) { return handleError(res, err, 'Saving treatment'); }
      service.analysis.invalidateCache();
      res.status(201).json(Array.isArray(result) ? result[0] : result);
    });
  });

  return api;
}

module.exports = configure;
module.exports.PERM = PERM;
module.exports.LIMITS = LIMITS;
