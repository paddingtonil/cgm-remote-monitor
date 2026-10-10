'use strict';

// Settings model for AI Insights (docs/proposals/ai-insights-design.md 4).
//
// Two layers:
//   env   (AIINSIGHTS_* -> env.extendedSettings.aiinsights): provider, key
//         presence, privacy acknowledgement, operator defaults
//   Mongo (ai_settings 'default'): everything the user edits in the UI
// A value missing from Mongo falls back to env, and a value missing from env
// falls back to the spec defaults below (spec section 4).

var types = require('./types');

var DEFAULT_SETTINGS = {
  analysisPeriod: 14
  , aiPersonality: 'supportive_coach'
  , tightRangeUpperBound: 140
  , features: {
    circadian: false
    , foodResponse: false
    , mealDebrief: false
    , preMealAdvisor: false
    , caffeineTracking: false
    , alcoholTracking: false
    , cgmBackfillDetection: false
    , agpChart: false
  }
  , monitor: {
    enabled: false
    , frequency: 'weekly'
    , minConfidence: 'medium'
    , quietHours: { enabled: false, start: 22, end: 7 }
    , notificationStyle: 'push'
    , lastRunAt: null
  }
  , budget: {
    monthlyCapUsd: 0
    , warnPercent: 80
    , hardBlock: false
    , confirmBeforeCall: false
  }
  , sleepSchedule: { bedHour: 22, wakeHour: 7 }
  , developerMode: false
  , privacyAcknowledgedAt: null
};

// Nightscout defaults for the provider. The spec defaults to OpenAI; this
// deployment defaults to Gemini (product decision 2026-10-10). Both are only
// used when AIINSIGHTS_BASE_URL / AIINSIGHTS_MODEL are not set.
var DEFAULT_PROVIDER = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta'
  , model: 'gemini-3.8-flash'
};

var MONITOR_FREQUENCIES = { '6h': 6, '12h': 12, daily: 24, weekly: 24 * 7 };
var NOTIFICATION_STYLES = ['banner', 'push', 'silent'];

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge (base, patch) {
  var out = Array.isArray(base) ? base.slice() : Object.assign({ }, base);
  if (!isPlainObject(patch)) { return out; }
  Object.keys(patch).forEach(function eachKey (key) {
    if (isPlainObject(base[key]) && isPlainObject(patch[key])) {
      out[key] = deepMerge(base[key], patch[key]);
    } else if (patch[key] !== undefined) {
      out[key] = patch[key];
    }
  });
  return out;
}

function parseJsonSetting (value) {
  if (isPlainObject(value)) { return value; }
  if (typeof value !== 'string' || !value.trim()) { return null; }
  try {
    var parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : null;
  } catch (err) {
    console.warn('aiinsights: AIINSIGHTS_GEMINI_GENERATION_CONFIG is not valid JSON, ignored');
    return null;
  }
}

/**
 * Operator configuration derived from env (never contains the key).
 */
function envConfig (env) {
  var ext = (env.extendedSettings && env.extendedSettings.aiinsights) || { };
  var provider = {
    baseUrl: ext.baseUrl || DEFAULT_PROVIDER.baseUrl
    , model: ext.model || DEFAULT_PROVIDER.model
    , requestFormat: ext.requestFormat || null
    , endpointPath: ext.endpointPath || null
    , apiVersion: ext.apiVersion || null
    , organizationId: ext.organizationId || null
    , geminiGenerationConfig: parseJsonSetting(ext.geminiGenerationConfig)
  };
  return {
    provider: provider
    , allowPrivateUrl: ext.allowPrivateUrl === true
    , privacyAck: ext.privacyAck === true
    , debugPrompts: ext.debugPrompts === true
    // operator defaults for user settings (optional)
    , defaults: {
      analysisPeriod: types.ANALYSIS_PERIODS.indexOf(ext.analysisPeriod) > -1 ? ext.analysisPeriod : undefined
      , aiPersonality: types.PERSONALITIES.indexOf(ext.personality) > -1 ? ext.personality : undefined
      , tightRangeUpperBound: typeof ext.tightRangeUpperBound === 'number' ? ext.tightRangeUpperBound : undefined
    }
  };
}

/**
 * Effective user settings: spec defaults <- env defaults <- stored doc.
 */
function mergeSettings (stored, envCfg) {
  var merged = deepMerge(DEFAULT_SETTINGS, (envCfg && envCfg.defaults) || { });
  merged = deepMerge(merged, stored || { });
  delete merged._id;
  // dependent features (spec 4): debrief and pre-meal need foodResponse
  if (!merged.features.foodResponse) {
    merged.features.mealDebrief = false;
    merged.features.preMealAdvisor = false;
  }
  return merged;
}

function isInt (v) { return Number.isInteger(v); }
function isHour (v) { return isInt(v) && v >= 0 && v <= 23; }
function isBool (v) { return typeof v === 'boolean'; }

/**
 * Validates a PUT /settings patch (design 4.3). Returns { ok, errors, value }
 * where value contains only recognised keys with validated values.
 */
function validatePatch (patch) {
  var errors = [];
  var value = { };
  if (!isPlainObject(patch)) {
    return { ok: false, errors: ['body must be an object'], value: value };
  }

  if (patch.analysisPeriod !== undefined) {
    if (types.ANALYSIS_PERIODS.indexOf(patch.analysisPeriod) > -1) { value.analysisPeriod = patch.analysisPeriod; } else { errors.push('analysisPeriod must be one of ' + types.ANALYSIS_PERIODS.join(', ')); }
  }
  if (patch.aiPersonality !== undefined) {
    if (types.PERSONALITIES.indexOf(patch.aiPersonality) > -1) { value.aiPersonality = patch.aiPersonality; } else { errors.push('aiPersonality must be one of ' + types.PERSONALITIES.join(', ')); }
  }
  if (patch.tightRangeUpperBound !== undefined) {
    var t = patch.tightRangeUpperBound;
    if (isInt(t) && t >= 120 && t <= 160 && t % 5 === 0) { value.tightRangeUpperBound = t; } else { errors.push('tightRangeUpperBound must be 120..160 in steps of 5'); }
  }
  if (patch.features !== undefined) {
    if (isPlainObject(patch.features)) {
      value.features = { };
      Object.keys(DEFAULT_SETTINGS.features).forEach(function eachFeature (name) {
        if (patch.features[name] !== undefined) {
          if (isBool(patch.features[name])) { value.features[name] = patch.features[name]; } else { errors.push('features.' + name + ' must be boolean'); }
        }
      });
    } else { errors.push('features must be an object'); }
  }
  if (patch.monitor !== undefined) {
    if (isPlainObject(patch.monitor)) {
      var m = patch.monitor;
      value.monitor = { };
      if (m.enabled !== undefined) { if (isBool(m.enabled)) { value.monitor.enabled = m.enabled; } else { errors.push('monitor.enabled must be boolean'); } }
      if (m.frequency !== undefined) { if (MONITOR_FREQUENCIES[m.frequency]) { value.monitor.frequency = m.frequency; } else { errors.push('monitor.frequency must be one of ' + Object.keys(MONITOR_FREQUENCIES).join(', ')); } }
      if (m.minConfidence !== undefined) { if (types.CONFIDENCES.indexOf(m.minConfidence) > -1) { value.monitor.minConfidence = m.minConfidence; } else { errors.push('monitor.minConfidence must be low, medium or high'); } }
      if (m.notificationStyle !== undefined) { if (NOTIFICATION_STYLES.indexOf(m.notificationStyle) > -1) { value.monitor.notificationStyle = m.notificationStyle; } else { errors.push('monitor.notificationStyle must be banner, push or silent'); } }
      if (m.quietHours !== undefined) {
        if (isPlainObject(m.quietHours)) {
          value.monitor.quietHours = { };
          if (m.quietHours.enabled !== undefined) { if (isBool(m.quietHours.enabled)) { value.monitor.quietHours.enabled = m.quietHours.enabled; } else { errors.push('monitor.quietHours.enabled must be boolean'); } }
          if (m.quietHours.start !== undefined) { if (isHour(m.quietHours.start)) { value.monitor.quietHours.start = m.quietHours.start; } else { errors.push('monitor.quietHours.start must be 0..23'); } }
          if (m.quietHours.end !== undefined) { if (isHour(m.quietHours.end)) { value.monitor.quietHours.end = m.quietHours.end; } else { errors.push('monitor.quietHours.end must be 0..23'); } }
        } else { errors.push('monitor.quietHours must be an object'); }
      }
    } else { errors.push('monitor must be an object'); }
  }
  if (patch.budget !== undefined) {
    if (isPlainObject(patch.budget)) {
      var b = patch.budget;
      value.budget = { };
      if (b.monthlyCapUsd !== undefined) { if (typeof b.monthlyCapUsd === 'number' && b.monthlyCapUsd >= 0 && b.monthlyCapUsd <= 10000) { value.budget.monthlyCapUsd = b.monthlyCapUsd; } else { errors.push('budget.monthlyCapUsd must be 0..10000'); } }
      if (b.warnPercent !== undefined) { if (isInt(b.warnPercent) && b.warnPercent >= 0 && b.warnPercent <= 100) { value.budget.warnPercent = b.warnPercent; } else { errors.push('budget.warnPercent must be 0..100'); } }
      if (b.hardBlock !== undefined) { if (isBool(b.hardBlock)) { value.budget.hardBlock = b.hardBlock; } else { errors.push('budget.hardBlock must be boolean'); } }
      if (b.confirmBeforeCall !== undefined) { if (isBool(b.confirmBeforeCall)) { value.budget.confirmBeforeCall = b.confirmBeforeCall; } else { errors.push('budget.confirmBeforeCall must be boolean'); } }
    } else { errors.push('budget must be an object'); }
  }
  if (patch.sleepSchedule !== undefined) {
    if (isPlainObject(patch.sleepSchedule)) {
      value.sleepSchedule = { };
      if (patch.sleepSchedule.bedHour !== undefined) { if (isHour(patch.sleepSchedule.bedHour)) { value.sleepSchedule.bedHour = patch.sleepSchedule.bedHour; } else { errors.push('sleepSchedule.bedHour must be 0..23'); } }
      if (patch.sleepSchedule.wakeHour !== undefined) { if (isHour(patch.sleepSchedule.wakeHour)) { value.sleepSchedule.wakeHour = patch.sleepSchedule.wakeHour; } else { errors.push('sleepSchedule.wakeHour must be 0..23'); } }
    } else { errors.push('sleepSchedule must be an object'); }
  }
  if (patch.developerMode !== undefined) {
    if (isBool(patch.developerMode)) { value.developerMode = patch.developerMode; } else { errors.push('developerMode must be boolean'); }
  }
  if (patch.privacyAcknowledged !== undefined) {
    if (patch.privacyAcknowledged === true) { value.privacyAcknowledgedAt = new Date().toISOString(); } else if (patch.privacyAcknowledged === false) { value.privacyAcknowledgedAt = null; } else { errors.push('privacyAcknowledged must be boolean'); }
  }

  return { ok: errors.length === 0, errors: errors, value: value };
}

function monitorIntervalMs (frequency) {
  var hours = MONITOR_FREQUENCIES[frequency] || MONITOR_FREQUENCIES.weekly;
  return hours * 3600000;
}

module.exports = {
  DEFAULT_SETTINGS: DEFAULT_SETTINGS
  , DEFAULT_PROVIDER: DEFAULT_PROVIDER
  , MONITOR_FREQUENCIES: MONITOR_FREQUENCIES
  , NOTIFICATION_STYLES: NOTIFICATION_STYLES
  , envConfig: envConfig
  , mergeSettings: mergeSettings
  , validatePatch: validatePatch
  , deepMerge: deepMerge
  , monitorIntervalMs: monitorIntervalMs
};
