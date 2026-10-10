'use strict';

require('should');

const usage = require('../lib/aiinsights/usage');

describe('aiinsights usage', function () {

  describe('estimateTokens', function () {
    it('is ceil(chars / 4)', function () {
      usage.estimateTokens('').should.equal(0);
      usage.estimateTokens('abcd').should.equal(1);
      usage.estimateTokens('abcde').should.equal(2);
      usage.estimateTokens('a'.repeat(4000)).should.equal(1000);
    });
    it('tolerates null/undefined', function () {
      usage.estimateTokens(null).should.equal(0);
      usage.estimateTokens(undefined).should.equal(0);
    });
  });

  describe('pricingFor', function () {
    it('opus', function () {
      usage.pricingFor('claude-opus-4-1').should.deepEqual({ input: 5, output: 25, match: 'opus' });
    });
    it('sonnet', function () {
      usage.pricingFor('claude-sonnet-4-5-20250514').should.deepEqual({ input: 3, output: 15, match: 'sonnet' });
    });
    it('haiku', function () {
      usage.pricingFor('claude-3-5-haiku').should.deepEqual({ input: 1, output: 5, match: 'haiku' });
    });
    it('gpt-4o-mini (checked before gpt-4o)', function () {
      usage.pricingFor('gpt-4o-mini').should.deepEqual({ input: 0.15, output: 0.6, match: 'gpt-4o-mini' });
      usage.pricingFor('GPT-4o-Mini-2024-07-18').match.should.equal('gpt-4o-mini');
    });
    it('gpt-4o and gpt-4.1', function () {
      usage.pricingFor('gpt-4o').should.deepEqual({ input: 2.5, output: 10, match: 'gpt-4o' });
      usage.pricingFor('gpt-4.1').should.deepEqual({ input: 2.5, output: 10, match: 'gpt-4o' });
      usage.pricingFor('gpt-4o-2024-08-06').match.should.equal('gpt-4o');
    });
    it('gemini flash', function () {
      usage.pricingFor('gemini-2.0-flash').should.deepEqual({ input: 0.3, output: 1.0, match: 'gemini-flash' });
      usage.pricingFor('gemini-2.5-flash-lite').match.should.equal('gemini-flash');
    });
    it('gemini other', function () {
      usage.pricingFor('gemini-2.5-pro').should.deepEqual({ input: 1.25, output: 5, match: 'gemini' });
    });
    it('default', function () {
      usage.pricingFor('llama-3.3-70b').should.deepEqual({ input: 3, output: 15, match: 'default' });
      usage.pricingFor('').match.should.equal('default');
      usage.pricingFor(undefined).match.should.equal('default');
    });
    it('is case-insensitive', function () {
      usage.pricingFor('Claude-OPUS').match.should.equal('opus');
    });
    it('exposes PRICING in spec order', function () {
      usage.PRICING.map(function name (p) { return p.match; }).should.deepEqual([
        'opus', 'sonnet', 'haiku', 'gpt-4o-mini', 'gpt-4o', 'gemini-flash', 'gemini', 'default'
      ]);
    });
  });

  describe('estimateCostUsd', function () {
    it('computes USD from per-million pricing', function () {
      // gpt-4o: 1M input = 2.5, 1M output = 10
      usage.estimateCostUsd('gpt-4o', 1000000, 1000000).should.equal(12.5);
      usage.estimateCostUsd('gpt-4o', 10000, 2000).should.equal(0.045);
      // sonnet: 3/15
      usage.estimateCostUsd('claude-sonnet-4-5', 20000, 4000).should.equal(0.12);
    });
    it('rounds to 6 decimals and treats missing tokens as 0', function () {
      usage.estimateCostUsd('gpt-4o-mini', 1, 1).should.equal(0.000001);
      usage.estimateCostUsd('gpt-4o-mini', 1, 0).should.equal(0);
      usage.estimateCostUsd('gpt-4o', null, undefined).should.equal(0);
      usage.estimateCostUsd('gpt-4o', -5, 'x').should.equal(0);
    });
  });

  describe('preCallEstimate', function () {
    it('settings with 3 -> 0.21', function () {
      usage.preCallEstimate('settings', 3).should.equal(0.21);
    });
    it('settings with 1 -> 0.07', function () {
      usage.preCallEstimate('settings', 1).should.equal(0.07);
      usage.preCallEstimate('settings').should.equal(0.07);
    });
    it('settings with 2 -> 0.14', function () {
      usage.preCallEstimate('settings', 2).should.equal(0.14);
    });
    it('anything else -> 0.02', function () {
      usage.preCallEstimate('trends').should.equal(0.02);
      usage.preCallEstimate('chat', 3).should.equal(0.02);
      usage.preCallEstimate(undefined).should.equal(0.02);
    });
    it('exposes PRE_CALL_ESTIMATE', function () {
      usage.PRE_CALL_ESTIMATE.should.deepEqual({ settings_one: 0.07, settings_three: 0.21, default: 0.02 });
    });
  });

  describe('monthKey', function () {
    it('formats YYYY-MM in UTC', function () {
      usage.monthKey(new Date('2026-03-15T12:00:00Z')).should.equal('2026-03');
      usage.monthKey(new Date('2026-11-01T00:00:00Z')).should.equal('2026-11');
    });
    it('uses UTC not local time at month boundaries', function () {
      usage.monthKey(new Date('2026-01-31T23:59:59Z')).should.equal('2026-01');
      usage.monthKey(new Date('2026-02-01T00:00:00Z')).should.equal('2026-02');
    });
    it('accepts millis and ISO strings and defaults to now', function () {
      usage.monthKey(Date.UTC(2025, 6, 4)).should.equal('2025-07');
      usage.monthKey('2025-12-25T00:00:00Z').should.equal('2025-12');
      usage.monthKey().should.match(/^\d{4}-\d{2}$/);
    });
    it('throws on invalid dates', function () {
      (function () { usage.monthKey('nope'); }).should.throw();
    });
  });

  describe('budgetGate', function () {
    it('cap 0 -> allowed with estimate and null percentUsed', function () {
      const r = usage.budgetGate({ budget: { monthlyCapUsd: 0, hardBlock: true }, monthSpentUsd: 999, kind: 'settings', settingCount: 3 });
      r.should.deepEqual({
        allowed: true
        , httpStatus: 200
        , reason: null
        , warning: null
        , estimatedCostUsd: 0.21
        , monthSpentUsd: 999
        , capUsd: 0
        , percentUsed: null
      });
    });

    it('missing budget -> allowed', function () {
      const r = usage.budgetGate({ kind: 'trends' });
      r.allowed.should.equal(true);
      r.httpStatus.should.equal(200);
      r.estimatedCostUsd.should.equal(0.02);
      r.monthSpentUsd.should.equal(0);
    });

    it('spent + estimate > cap with hardBlock -> 402 budget_exceeded', function () {
      const r = usage.budgetGate({
        budget: { monthlyCapUsd: 10, hardBlock: true, confirmBeforeCall: true }
        , monthSpentUsd: 9.9
        , kind: 'settings'
        , settingCount: 3
      });
      r.allowed.should.equal(false);
      r.httpStatus.should.equal(402);
      r.reason.should.equal('budget_exceeded');
      r.estimatedCostUsd.should.equal(0.21);
      r.capUsd.should.equal(10);
      r.percentUsed.should.equal(99);
    });

    it('spent + estimate > cap without hardBlock -> allowed with warning', function () {
      const r = usage.budgetGate({
        budget: { monthlyCapUsd: 10, hardBlock: false }
        , monthSpentUsd: 9.9
        , kind: 'settings'
        , settingCount: 3
      });
      r.allowed.should.equal(true);
      r.httpStatus.should.equal(200);
      (r.reason === null).should.equal(true);
      r.warning.should.equal('budget_warning');
    });

    it('spent + estimate exactly equal to cap is not exceeded', function () {
      const r = usage.budgetGate({
        budget: { monthlyCapUsd: 10, hardBlock: true, warnPercent: 100 }
        , monthSpentUsd: 9.98
        , kind: 'trends'
      });
      r.allowed.should.equal(true);
      r.httpStatus.should.equal(200);
    });

    it('warns at warnPercent (default 80)', function () {
      const warn = usage.budgetGate({ budget: { monthlyCapUsd: 10 }, monthSpentUsd: 8, kind: 'trends' });
      warn.allowed.should.equal(true);
      warn.warning.should.equal('budget_warning');
      warn.percentUsed.should.equal(80);

      const noWarn = usage.budgetGate({ budget: { monthlyCapUsd: 10 }, monthSpentUsd: 7.99, kind: 'trends' });
      (noWarn.warning === null).should.equal(true);
    });

    it('honours a custom warnPercent', function () {
      const r = usage.budgetGate({ budget: { monthlyCapUsd: 10, warnPercent: 50 }, monthSpentUsd: 5, kind: 'trends' });
      r.warning.should.equal('budget_warning');
      const r2 = usage.budgetGate({ budget: { monthlyCapUsd: 10, warnPercent: 90 }, monthSpentUsd: 8.5, kind: 'trends' });
      (r2.warning === null).should.equal(true);
    });

    it('confirmBeforeCall without confirmCost -> 409 confirmation_required', function () {
      const r = usage.budgetGate({ budget: { monthlyCapUsd: 0, confirmBeforeCall: true }, monthSpentUsd: 0, kind: 'settings', settingCount: 1 });
      r.allowed.should.equal(false);
      r.httpStatus.should.equal(409);
      r.reason.should.equal('confirmation_required');
      r.estimatedCostUsd.should.equal(0.07);
    });

    it('confirmBeforeCall with confirmCost true -> allowed', function () {
      const r = usage.budgetGate({ budget: { monthlyCapUsd: 0, confirmBeforeCall: true }, monthSpentUsd: 0, kind: 'settings', settingCount: 1, confirmCost: true });
      r.allowed.should.equal(true);
      r.httpStatus.should.equal(200);
    });

    it('confirmBeforeCall with truthy non-boolean confirmCost still requires confirmation', function () {
      const r = usage.budgetGate({ budget: { confirmBeforeCall: true }, kind: 'trends', confirmCost: 'true' });
      r.httpStatus.should.equal(409);
    });

    it('402 wins over 409 and keeps the warning when confirmation is required', function () {
      const blocked = usage.budgetGate({
        budget: { monthlyCapUsd: 1, hardBlock: true, confirmBeforeCall: true }
        , monthSpentUsd: 1
        , kind: 'trends'
      });
      blocked.httpStatus.should.equal(402);
      blocked.reason.should.equal('budget_exceeded');

      const confirm = usage.budgetGate({
        budget: { monthlyCapUsd: 10, hardBlock: true, confirmBeforeCall: true }
        , monthSpentUsd: 8.5
        , kind: 'trends'
      });
      confirm.httpStatus.should.equal(409);
      confirm.reason.should.equal('confirmation_required');
      confirm.warning.should.equal('budget_warning');
    });
  });

  describe('buildUsageRecord', function () {
    const now = new Date('2026-05-10T08:30:00Z');

    it('builds a record with estimates when no reported usage', function () {
      const rec = usage.buildUsageRecord({
        kind: 'settings'
        , model: 'gpt-4o'
        , systemPrompt: 'a'.repeat(400)
        , userPrompt: 'b'.repeat(800)
        , responseText: 'c'.repeat(200)
        , now: now
      });
      rec.created_at.should.equal('2026-05-10T08:30:00.000Z');
      rec.kind.should.equal('settings');
      rec.model.should.equal('gpt-4o');
      rec.estimated_input_tokens.should.equal(300);
      rec.estimated_output_tokens.should.equal(50);
      (rec.reported_input_tokens === null).should.equal(true);
      (rec.reported_output_tokens === null).should.equal(true);
      rec.estimated_cost_usd.should.equal(usage.estimateCostUsd('gpt-4o', 300, 50));
      rec.month.should.equal('2026-05');
    });

    it('prefers reported tokens for cost when both are present', function () {
      const rec = usage.buildUsageRecord({
        kind: 'trends'
        , model: 'claude-sonnet-4-5'
        , systemPrompt: 'x'.repeat(40)
        , userPrompt: 'y'.repeat(40)
        , responseText: 'z'.repeat(40)
        , reportedUsage: { inputTokens: 20000, outputTokens: 4000 }
        , now: now
      });
      rec.reported_input_tokens.should.equal(20000);
      rec.reported_output_tokens.should.equal(4000);
      rec.estimated_input_tokens.should.equal(20);
      rec.estimated_output_tokens.should.equal(10);
      rec.estimated_cost_usd.should.equal(0.12);
    });

    it('falls back to estimates when only one reported value is present', function () {
      const rec = usage.buildUsageRecord({
        kind: 'chat'
        , model: 'gpt-4o'
        , systemPrompt: 'a'.repeat(4000)
        , userPrompt: ''
        , responseText: 'b'.repeat(4000)
        , reportedUsage: { inputTokens: 5, outputTokens: null }
        , now: now
      });
      rec.reported_input_tokens.should.equal(5);
      (rec.reported_output_tokens === null).should.equal(true);
      rec.estimated_cost_usd.should.equal(usage.estimateCostUsd('gpt-4o', 1000, 1000));
    });

    it('defaults now to the current time', function () {
      const before = Date.now();
      const rec = usage.buildUsageRecord({ kind: 'k', model: 'm', systemPrompt: '', userPrompt: '', responseText: '' });
      new Date(rec.created_at).getTime().should.be.aboveOrEqual(before);
      rec.month.should.equal(usage.monthKey(new Date(rec.created_at)));
    });
  });
});
