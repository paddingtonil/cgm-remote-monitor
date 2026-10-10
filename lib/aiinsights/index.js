'use strict';

// AI Insights service (docs/proposals/ai-insights-design.md section 3).
// Created in bootevent.setupInternals when ENABLE contains `aiinsights`, and
// exposed as ctx.aiinsights. The router (lib/api/aiinsights) and the plugin
// (lib/plugins/aiinsights.js) talk to this object; nothing else touches the
// provider or the AI collections directly.

function init (env, ctx) {
  var config = require('./config');
  var provider = require('./provider');
  var usage = require('./usage');
  var createJobs = require('./jobs');
  var types = require('./types');

  var store = require('../server/aiinsights-store')(env, ctx);
  var envCfg = config.envConfig(env);
  var jobs = createJobs({ concurrency: 1 });

  var service = {
    store: store
    , jobs: jobs
    , envCfg: envCfg
    , config: config
    , types: types
    , provider: provider
    , usage: usage
  };

  // --------------------------------------------------------------- state --

  service.isKeyConfigured = function isKeyConfigured () {
    return env.enclave.isAiApiKeySet();
  };

  // Locked mode (design 7.2): if a caller with NO credential would already be
  // permitted to run an analysis, the deployment's default roles are too
  // open (e.g. AUTH_DEFAULT_ROLES=admin or ai-insights) and the feature
  // refuses to serve anything but GET /settings. Re-evaluated per request
  // so a role change at runtime takes effect immediately.
  service.isLocked = function isLocked () {
    try {
      var anonymous = ctx.authorization.resolveAnonymous();
      var permitted = ctx.authorization.checkMultiple('api:aiinsights:analyze:create', anonymous.shiros)
        || ctx.authorization.checkMultiple('api:aiinsights:chat:create', anonymous.shiros)
        || ctx.authorization.checkMultiple('api:aiinsights:suggestions:read', anonymous.shiros);
      return permitted;
    } catch (err) {
      console.error('[aiinsights] unable to evaluate default roles, locking feature', err.message);
      return true;
    }
  };

  service.lockReason = function lockReason () {
    return 'AI Insights is locked because the default (unauthenticated) roles grant access to it. '
      + 'Remove ai-insights / admin from AUTH_DEFAULT_ROLES and give the permission to a named subject instead.';
  };

  // ------------------------------------------------------------ settings --

  service.getSettings = async function getSettings () {
    var stored = await store.getSettings();
    return config.mergeSettings(stored, envCfg);
  };

  service.updateSettings = async function updateSettings (patch) {
    var validated = config.validatePatch(patch);
    if (!validated.ok) {
      var err = new Error(validated.errors.join('; '));
      err.status = 400;
      err.code = 'invalid_settings';
      throw err;
    }
    var stored = (await store.getSettings()) || { };
    var next = config.deepMerge(stored, validated.value);
    delete next._id;
    await store.saveSettings(next);
    return config.mergeSettings(next, envCfg);
  };

  service.providerConfig = function providerConfig () {
    return provider.effectiveConfig(envCfg.provider);
  };

  /**
   * What the browser is allowed to know about the provider: no key.
   */
  service.publicProviderInfo = function publicProviderInfo () {
    var cfg = service.providerConfig();
    return {
      configured: service.isKeyConfigured()
      , format: cfg.format
      , model: cfg.model
      , baseUrl: cfg.baseUrl
      , maxTokens: cfg.maxTokens
      , temperature: cfg.temperature
    };
  };

  /**
   * Readiness for a billable call (design 11.4): key, env privacy ack, UI
   * privacy ack, not locked. Returns { ok, status, reason }.
   */
  service.readiness = function readiness (settings) {
    if (service.isLocked()) {
      return { ok: false, status: 403, reason: 'locked', message: service.lockReason() };
    }
    if (!service.isKeyConfigured()) {
      return { ok: false, status: 503, reason: 'provider_not_configured', message: 'AIINSIGHTS_API_KEY is not set on the server.' };
    }
    if (!envCfg.privacyAck) {
      return { ok: false, status: 403, reason: 'privacy_ack_required', message: 'Set AIINSIGHTS_PRIVACY_ACK=true to allow sending glucose, insulin and carb data to the AI provider.' };
    }
    if (!settings || !settings.privacyAcknowledgedAt) {
      return { ok: false, status: 403, reason: 'privacy_ack_required', message: 'Acknowledge the privacy notice in AI Insights settings before running an analysis.' };
    }
    return { ok: true, status: 200, reason: null, message: null };
  };

  // --------------------------------------------------------------- usage --

  service.monthUsage = async function monthUsage (month, settings) {
    month = month || usage.monthKey(new Date());
    var spent = await store.monthSpent(month);
    settings = settings || await service.getSettings();
    var cap = settings.budget.monthlyCapUsd || 0;
    return {
      month: month
      , estimatedCostUsd: Math.round(spent.totalUsd * 1e6) / 1e6
      , callCount: spent.count
      , capUsd: cap
      , warnPercent: settings.budget.warnPercent
      , percentUsed: cap > 0 ? Math.round(spent.totalUsd / cap * 1000) / 10 : null
      , blocked: cap > 0 && settings.budget.hardBlock && spent.totalUsd >= cap
    };
  };

  service.budgetGate = async function budgetGate (settings, kind, settingCount, confirmCost) {
    var spent = await store.monthSpent(usage.monthKey(new Date()));
    return usage.budgetGate({
      budget: settings.budget
      , monthSpentUsd: spent.totalUsd
      , kind: kind
      , settingCount: settingCount
      , confirmCost: confirmCost
    });
  };

  // ------------------------------------------------------------ provider --

  service.testConnection = async function testConnection () {
    if (!service.isKeyConfigured()) {
      return { ok: false, status: 0, message: 'AIINSIGHTS_API_KEY is not set on the server.' };
    }
    var cfg = service.providerConfig();
    var result = await env.enclave.withAiApiKey(function withKey (key) {
      return provider.testConnection(cfg, key, { allowPrivateUrl: envCfg.allowPrivateUrl });
    });
    try {
      await store.insertAnalysis({
        kind: 'connection_test'
        , input: { }
        , provider: { format: cfg.format, model: cfg.model, latency_ms: result.latencyMs || null, http_status: result.status || null }
        , error: result.ok ? null : (result.message || 'failed')
      });
    } catch (err) {
      console.error('[aiinsights] unable to record connection test', err.message);
    }
    return result;
  };

  /**
   * One provider round-trip with usage accounting. Returns
   * { text, usage, status, latencyMs, usageRecord, model, format }.
   */
  service.sendPrompt = async function sendPrompt (opts) {
    var cfg = service.providerConfig();
    if (envCfg.debugPrompts) {
      console.log('[aiinsights] system prompt (' + opts.kind + '):\n' + opts.systemPrompt);
      console.log('[aiinsights] user prompt (' + opts.kind + '):\n' + opts.userPrompt);
    }
    var result = await env.enclave.withAiApiKey(function withKey (key) {
      return provider.sendPrompt(cfg, key, opts.systemPrompt, opts.userPrompt, {
        maxTokens: opts.maxTokens
        , signal: opts.signal
        , allowPrivateUrl: envCfg.allowPrivateUrl
      });
    });
    if (envCfg.debugPrompts) {
      console.log('[aiinsights] response (' + opts.kind + '):\n' + result.text);
    }
    var record = usage.buildUsageRecord({
      kind: opts.kind
      , model: cfg.model
      , systemPrompt: opts.systemPrompt
      , userPrompt: opts.userPrompt
      , responseText: result.text
      , reportedUsage: result.usage
    });
    try {
      await store.insertUsage(record);
    } catch (err) {
      console.error('[aiinsights] unable to record usage', err.message);
    }
    console.log('[aiinsights] kind=' + opts.kind + ' provider=' + cfg.format + ' model=' + cfg.model
      + ' status=' + result.status + ' latency=' + result.latencyMs + 'ms est_cost=' + record.estimated_cost_usd);
    return {
      text: result.text
      , usage: result.usage
      , status: result.status
      , latencyMs: result.latencyMs
      , usageRecord: record
      , model: cfg.model
      , format: cfg.format
    };
  };

  // ------------------------------------------------------- data + analysis --

  service.aggregator = require('./aggregator')(env, ctx);
  service.analyzers = require('./analyzers');
  service.analysis = require('./analysis')(env, ctx, service);

  return service;
}

module.exports = init;
