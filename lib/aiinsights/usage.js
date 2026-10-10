'use strict';

// Token estimation, pricing, budget gate and usage records for the AI Insights
// plugin (spec 3.6, design doc 6.3 / 8.5). Pure functions; the caller supplies
// the month's spend from the ai_usage collection.

const CHARS_PER_TOKEN = 4;
const DEFAULT_WARN_PERCENT = 80;

// USD per 1M tokens, matched in order against the lower-cased model name.
// Order matters: gpt-4o-mini must be tested before gpt-4o, and gemini flash
// before the generic gemini entry.
const PRICING = [
  { match: 'opus', input: 5, output: 25, test: function matchOpus (m) { return m.indexOf('opus') >= 0; } }
  , { match: 'sonnet', input: 3, output: 15, test: function matchSonnet (m) { return m.indexOf('sonnet') >= 0; } }
  , { match: 'haiku', input: 1, output: 5, test: function matchHaiku (m) { return m.indexOf('haiku') >= 0; } }
  , { match: 'gpt-4o-mini', input: 0.15, output: 0.6, test: function matchGpt4oMini (m) { return m.indexOf('gpt-4o-mini') >= 0; } }
  , { match: 'gpt-4o', input: 2.5, output: 10, test: function matchGpt4o (m) { return m.indexOf('gpt-4o') >= 0 || m.indexOf('gpt-4.1') >= 0; } }
  , { match: 'gemini-flash', input: 0.3, output: 1.0, test: function matchGeminiFlash (m) { return m.indexOf('gemini') >= 0 && m.indexOf('flash') >= 0; } }
  , { match: 'gemini', input: 1.25, output: 5, test: function matchGemini (m) { return m.indexOf('gemini') >= 0; } }
  , { match: 'default', input: 3, output: 15, test: function matchDefault () { return true; } }
];

const PRE_CALL_ESTIMATE = {
  settings_one: 0.07
  , settings_three: 0.21
  , default: 0.02
};

function estimateTokens (text) {
  if (text === undefined || text === null) {
    return 0;
  }
  const length = typeof text === 'string' ? text.length : String(text).length;
  return Math.ceil(length / CHARS_PER_TOKEN);
}

function pricingFor (model) {
  const name = String(model || '').toLowerCase();
  for (let i = 0; i < PRICING.length; i++) {
    const entry = PRICING[i];
    if (entry.test(name)) {
      return { input: entry.input, output: entry.output, match: entry.match };
    }
  }
  const fallback = PRICING[PRICING.length - 1];
  return { input: fallback.input, output: fallback.output, match: fallback.match };
}

function round6 (value) {
  return Math.round(value * 1e6) / 1e6;
}

function toCount (value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function estimateCostUsd (model, inputTokens, outputTokens) {
  const price = pricingFor(model);
  const cost = (toCount(inputTokens) * price.input + toCount(outputTokens) * price.output) / 1e6;
  return round6(cost);
}

function preCallEstimate (kind, settingCount) {
  if (kind === 'settings') {
    const count = Number(settingCount);
    if (count >= 3) {
      return PRE_CALL_ESTIMATE.settings_three;
    }
    if (count === 2) {
      return round6(PRE_CALL_ESTIMATE.settings_one * 2);
    }
    return PRE_CALL_ESTIMATE.settings_one;
  }
  return PRE_CALL_ESTIMATE.default;
}

function monthKey (date) {
  const d = date instanceof Date ? date : (date === undefined || date === null ? new Date() : new Date(date));
  if (Number.isNaN(d.getTime())) {
    throw new TypeError('monthKey: invalid date');
  }
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  return year + '-' + (month < 10 ? '0' + month : String(month));
}

function budgetGate (params) {
  const input = params && typeof params === 'object' ? params : {};
  const budget = input.budget && typeof input.budget === 'object' ? input.budget : {};
  const cap = Number(budget.monthlyCapUsd) > 0 ? Number(budget.monthlyCapUsd) : 0;
  const warnPercent = Number.isFinite(Number(budget.warnPercent)) && budget.warnPercent !== null && budget.warnPercent !== undefined && budget.warnPercent !== ''
    ? Number(budget.warnPercent)
    : DEFAULT_WARN_PERCENT;
  const hardBlock = budget.hardBlock === true;
  const confirmBeforeCall = budget.confirmBeforeCall === true;
  const spent = Number.isFinite(Number(input.monthSpentUsd)) ? Math.max(0, Number(input.monthSpentUsd)) : 0;
  const estimate = preCallEstimate(input.kind, input.settingCount);

  const result = {
    allowed: true
    , httpStatus: 200
    , reason: null
    , warning: null
    , estimatedCostUsd: estimate
    , monthSpentUsd: round6(spent)
    , capUsd: cap
    , percentUsed: null
  };

  if (cap > 0) {
    result.percentUsed = round6((spent / cap) * 100);

    if (hardBlock && spent + estimate > cap) {
      result.allowed = false;
      result.httpStatus = 402;
      result.reason = 'budget_exceeded';
      return result;
    }

    if (spent / cap >= warnPercent / 100) {
      result.warning = 'budget_warning';
    }
  }

  if (confirmBeforeCall && input.confirmCost !== true) {
    result.allowed = false;
    result.httpStatus = 409;
    result.reason = 'confirmation_required';
  }

  return result;
}

function reportedCount (value) {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) && n >= 0 ? n : null;
}

function buildUsageRecord (params) {
  const input = params && typeof params === 'object' ? params : {};
  const now = input.now instanceof Date ? input.now : (input.now ? new Date(input.now) : new Date());
  const reported = input.reportedUsage && typeof input.reportedUsage === 'object' ? input.reportedUsage : {};

  const estimatedInput = estimateTokens(input.systemPrompt) + estimateTokens(input.userPrompt);
  const estimatedOutput = estimateTokens(input.responseText);
  const reportedInput = reportedCount(reported.inputTokens);
  const reportedOutput = reportedCount(reported.outputTokens);

  const useReported = reportedInput !== null && reportedOutput !== null;
  const cost = useReported
    ? estimateCostUsd(input.model, reportedInput, reportedOutput)
    : estimateCostUsd(input.model, estimatedInput, estimatedOutput);

  return {
    created_at: now.toISOString()
    , kind: input.kind || 'unknown'
    , model: input.model || null
    , estimated_input_tokens: estimatedInput
    , estimated_output_tokens: estimatedOutput
    , reported_input_tokens: reportedInput
    , reported_output_tokens: reportedOutput
    , estimated_cost_usd: cost
    , month: monthKey(now)
  };
}

module.exports = {
  CHARS_PER_TOKEN
  , PRICING
  , PRE_CALL_ESTIMATE
  , DEFAULT_WARN_PERCENT
  , estimateTokens
  , pricingFor
  , estimateCostUsd
  , preCallEstimate
  , monthKey
  , budgetGate
  , buildUsageRecord
};
