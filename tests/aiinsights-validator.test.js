'use strict';

require('should');

const validator = require('../lib/aiinsights/validator');

describe('aiinsights validator', function () {

  const snapshot = {
    basal: [{ startSeconds: 0, value: 0.8 }, { startSeconds: 21600, value: 1.0 }]
    , carbratio: [{ startSeconds: 0, value: 10 }]
    , sens: [{ startSeconds: 0, value: 50 }]
    , dia: 6
    , insulinType: 'Novolog'
    , profileName: 'Default'
    , profileId: null
    , profileUnits: 'mg/dl'
    , system: 'Loop'
    , timezone: 'UTC'
  };

  // hourly means: 0..23 -> 120 + hour*3 (120, 123, ..., 189); hour 5 has no data
  const hourly = [];
  for (let h = 0; h < 24; h++) {
    hourly.push({ hour: h, mean: h === 5 ? null : 120 + h * 3, count: h === 5 ? 0 : 50 });
  }

  function response (overrides) {
    const base = {
      past_suggestion_evaluations: {}
      , suggestions: []
      , overall_assessment: 'All good.'
      , next_recommended_focus: null
    };
    return Object.assign(base, overrides || {});
  }

  function suggestion (settingType, blocks, overrides) {
    const base = {
      time_blocks: blocks
      , plain_summary: 'Plain words.'
      , reasoning: 'Average glucose was 150 mg/dL overnight.'
      , confidence: 'medium'
      , success_criteria: {
        expected_outcomes: ['Overnight average should fall below 130 mg/dL']
        , evaluation_days: 5
        , revert_warnings: ['More than 2 lows']
        , metric_targets: { overnight_avg: '<130 mg/dL' }
      }
    };
    return Object.assign(base, overrides || {});
  }

  function parse (obj, opts) {
    return validator.parseSettingsResponse(JSON.stringify(obj), Object.assign({
      settingType: 'basal_rate'
      , snapshot: snapshot
      , hourly: hourly
      , mealCount: 20
      , correctionCount: 10
    }, opts || {}));
  }

  const basalBlock = { start_seconds: 0, end_seconds: 21600, current_value: 0.8, proposed_value: 0.85 };

  describe('extractJson', function () {
    it('extracts a ```json fenced block', function () {
      const text = 'Here you go:\n```json\n{"a": 1}\n```\nThanks';
      validator.extractJson(text).should.equal('{"a": 1}');
    });

    it('extracts a bare ``` fenced block', function () {
      validator.extractJson('```\n{"a": 2}\n```').should.equal('{"a": 2}');
    });

    it('extracts from the first { to the last } when there is prefix and suffix text', function () {
      const text = 'Sure! {"a": {"b": 3}} Let me know if you need anything else.';
      validator.extractJson(text).should.equal('{"a": {"b": 3}}');
    });

    it('returns null when there is no object at all', function () {
      (validator.extractJson('no json here') === null).should.be.true();
      (validator.extractJson(null) === null).should.be.true();
    });
  });

  describe('repairTruncatedJson / parseJsonLenient', function () {
    const full = response({
      suggestions: [suggestion('basal_rate', [basalBlock, { start_seconds: 21600, end_seconds: 43200, current_value: 1.0, proposed_value: 1.05 }])]
    });
    const fullText = JSON.stringify(full);

    it('repairs a response truncated mid-string', function () {
      const idx = fullText.indexOf('Average glucose was');
      const cut = fullText.slice(0, idx + 12); // "...Average glu
      const parsed = validator.parseJsonLenient(cut);
      parsed.should.have.property('suggestions').with.lengthOf(1);
      parsed.suggestions[0].time_blocks.should.have.lengthOf(2);
    });

    it('repairs a response truncated mid-array', function () {
      const idx = fullText.indexOf('"start_seconds":21600');
      const cut = fullText.slice(0, idx + 30); // inside the second block
      const parsed = validator.parseJsonLenient(cut);
      parsed.suggestions.should.have.lengthOf(1);
      parsed.suggestions[0].time_blocks.length.should.be.aboveOrEqual(1);
      parsed.suggestions[0].time_blocks[0].should.eql(basalBlock);
    });

    it('closes an open string and missing brackets', function () {
      const repaired = validator.repairTruncatedJson('{"a": [1, 2, {"b": "hel');
      JSON.parse(repaired).should.eql({ a: [1, 2, { b: 'hel' }] });
    });

    it('drops a dangling key after the last comma', function () {
      const repaired = validator.repairTruncatedJson('{"a": 1, "b": 2, "c":');
      JSON.parse(repaired).should.eql({ a: 1, b: 2 });
    });

    it('throws when the text cannot be repaired', function () {
      (function () {
        validator.parseJsonLenient('this is not json at all');
      }).should.throw();
    });
  });

  describe('roundToStep', function () {
    it('rounds to 0.1, 0.05 and integers', function () {
      validator.roundToStep(10.26, 0.1).should.equal(10.3);
      validator.roundToStep(0.87, 0.05).should.equal(0.85);
      validator.roundToStep(0.88, 0.05).should.equal(0.9);
      validator.roundToStep(49.6, 1).should.equal(50);
    });
  });

  describe('parseSettingsResponse: envelope and invalid input', function () {
    it('returns invalid_json for garbage', function () {
      const result = validator.parseSettingsResponse('I cannot help with that.', { settingType: 'basal_rate' });
      result.error.should.equal('invalid_json');
      result.suggestions.should.eql([]);
      result.pastEvaluations.should.eql({});
      result.validationNotes.length.should.be.above(0);
    });

    it('returns empty_thinking_response for an API envelope', function () {
      const envelope = { candidates: [], usageMetadata: { promptTokenCount: 10 } };
      const result = parse(envelope);
      result.error.should.equal('empty_thinking_response');
      result.suggestions.should.eql([]);
      validator.isApiEnvelope(envelope).should.be.true();
      validator.isApiEnvelope({ suggestions: [] }).should.be.false();
    });

    it('parses a fenced JSON response', function () {
      const text = 'Analysis:\n```json\n' + JSON.stringify(response({ suggestions: [suggestion('basal_rate', [basalBlock])] })) + '\n```';
      const result = validator.parseSettingsResponse(text, { settingType: 'basal_rate', snapshot: snapshot, hourly: hourly });
      (result.error === null).should.be.true();
      result.suggestions.should.have.lengthOf(1);
      result.overallAssessment.should.equal('All good.');
    });
  });

  describe('parseSettingsResponse: required fields and rounding', function () {
    it('skips a suggestion with missing confidence', function () {
      const s = suggestion('basal_rate', [basalBlock]);
      delete s.confidence;
      const result = parse(response({ suggestions: [s] }));
      result.suggestions.should.have.lengthOf(0);
      result.validationNotes.join(' ').should.match(/invalid confidence/);
    });

    it('skips a suggestion without time_blocks or reasoning', function () {
      const noBlocks = suggestion('basal_rate', [basalBlock]);
      delete noBlocks.time_blocks;
      const noReasoning = suggestion('basal_rate', [basalBlock]);
      delete noReasoning.reasoning;
      const result = parse(response({ suggestions: [noBlocks, noReasoning] }));
      result.suggestions.should.have.lengthOf(0);
      result.validationNotes.join(' ').should.match(/time_blocks/).and.match(/reasoning/);
    });

    it('rounds carb ratio to 0.1', function () {
      const result = parse(response({
        suggestions: [suggestion('carb_ratio', [{ start_seconds: 0, end_seconds: 86400, current_value: 10, proposed_value: 10.96 }])]
      }), { settingType: 'carb_ratio' });
      result.suggestions[0].time_blocks[0].proposed_value.should.equal(11);
    });

    it('rounds basal to 0.05', function () {
      const result = parse(response({
        suggestions: [suggestion('basal_rate', [{ start_seconds: 0, end_seconds: 21600, current_value: 0.8, proposed_value: 0.87 }])]
      }));
      result.suggestions[0].time_blocks[0].proposed_value.should.equal(0.85);
    });

    it('rounds ISF to an integer', function () {
      const result = parse(response({
        suggestions: [suggestion('insulin_sensitivity', [{ start_seconds: 0, end_seconds: 86400, current_value: 50, proposed_value: 45.4 }])]
      }), { settingType: 'insulin_sensitivity' });
      result.suggestions[0].time_blocks[0].proposed_value.should.equal(45);
    });

    it('coerces numeric strings', function () {
      const result = parse(response({
        suggestions: [suggestion('basal_rate', [{ start_seconds: '0', end_seconds: '21600', current_value: '0.8', proposed_value: '0.85' }])]
      }));
      result.suggestions[0].time_blocks[0].should.eql(basalBlock);
    });
  });

  describe('validateTimeBlocks: bounds, change thresholds, no-op', function () {
    it('rejects a proposed value outside absolute bounds', function () {
      const notes = [];
      const blocks = validator.validateTimeBlocks([
        { start_seconds: 0, end_seconds: 21600, current_value: 25, proposed_value: 31 }
      ], 'basal_rate', notes);
      blocks.should.have.lengthOf(0);
      notes.join(' ').should.match(/absolute bounds/).and.match(/rejected/);
    });

    it('rejects a current value outside absolute bounds', function () {
      const notes = [];
      const blocks = validator.validateTimeBlocks([
        { start_seconds: 0, end_seconds: 21600, current_value: 1.5, proposed_value: 2.5 }
      ], 'carb_ratio', notes);
      blocks.should.have.lengthOf(0);
      notes.join(' ').should.match(/current 1.5 outside absolute bounds/);
    });

    it('keeps a value outside the recommended range with a note', function () {
      const notes = [];
      const blocks = validator.validateTimeBlocks([
        { start_seconds: 0, end_seconds: 21600, current_value: 10.4, proposed_value: 11 }
      ], 'basal_rate', notes);
      blocks.should.have.lengthOf(1);
      blocks[0].proposed_value.should.equal(11);
      notes.join(' ').should.match(/recommended range/).and.match(/kept/);
    });

    it('clamps a 20% basal change to 15% with a note', function () {
      const notes = [];
      const blocks = validator.validateTimeBlocks([
        { start_seconds: 0, end_seconds: 21600, current_value: 1.0, proposed_value: 1.2 }
      ], 'basal_rate', notes);
      blocks.should.have.lengthOf(1);
      blocks[0].proposed_value.should.equal(1.15);
      notes.join(' ').should.match(/clamped/);
    });

    it('rejects a 40% basal change', function () {
      const notes = [];
      const blocks = validator.validateTimeBlocks([
        { start_seconds: 0, end_seconds: 21600, current_value: 1.0, proposed_value: 1.4 }
      ], 'basal_rate', notes);
      blocks.should.have.lengthOf(0);
      notes.join(' ').should.match(/exceeds 15%/).and.match(/rejected/);
    });

    it('clamps a 30% carb ratio change to 25%', function () {
      const notes = [];
      const blocks = validator.validateTimeBlocks([
        { start_seconds: 0, end_seconds: 86400, current_value: 10, proposed_value: 13 }
      ], 'carb_ratio', notes);
      blocks.should.have.lengthOf(1);
      blocks[0].proposed_value.should.equal(12.5);
      notes.join(' ').should.match(/clamped/);
    });

    it('rejects a 50% carb ratio change', function () {
      const notes = [];
      const blocks = validator.validateTimeBlocks([
        { start_seconds: 0, end_seconds: 86400, current_value: 10, proposed_value: 15 }
      ], 'carb_ratio', notes);
      blocks.should.have.lengthOf(0);
      notes.join(' ').should.match(/rejected/);
    });

    it('keeps a clamped ISF value within the threshold after rounding', function () {
      const notes = [];
      const blocks = validator.validateTimeBlocks([
        { start_seconds: 0, end_seconds: 86400, current_value: 50, proposed_value: 65 }
      ], 'insulin_sensitivity', notes);
      blocks.should.have.lengthOf(1);
      blocks[0].proposed_value.should.equal(62);
    });

    it('drops a no-op block where proposed equals current after rounding', function () {
      const notes = [];
      const blocks = validator.validateTimeBlocks([
        { start_seconds: 0, end_seconds: 21600, current_value: 0.8, proposed_value: 0.81 }
      ], 'basal_rate', notes);
      blocks.should.have.lengthOf(0);
      notes.join(' ').should.match(/no-op/);
    });

    it('rejects invalid time ranges', function () {
      const notes = [];
      const blocks = validator.validateTimeBlocks([
        { start_seconds: 21600, end_seconds: 21600, current_value: 0.8, proposed_value: 0.9 }
        , { start_seconds: -10, end_seconds: 3600, current_value: 0.8, proposed_value: 0.9 }
        , { start_seconds: 0, end_seconds: 90000, current_value: 0.8, proposed_value: 0.9 }
        , { start_seconds: 0.5, end_seconds: 3600, current_value: 0.8, proposed_value: 0.9 }
      ], 'basal_rate', notes);
      blocks.should.have.lengthOf(0);
      notes.should.have.lengthOf(4);
    });

    it('skips a suggestion when every block is filtered out', function () {
      const result = parse(response({
        suggestions: [suggestion('basal_rate', [{ start_seconds: 0, end_seconds: 21600, current_value: 0.8, proposed_value: 0.8 }])]
      }));
      result.suggestions.should.have.lengthOf(0);
      result.validationNotes.join(' ').should.match(/no valid time_blocks/);
    });
  });

  describe('snapshot cross-check', function () {
    it('notes when current_value disagrees with the profile', function () {
      const result = parse(response({
        suggestions: [suggestion('basal_rate', [{ start_seconds: 21600, end_seconds: 43200, current_value: 0.8, proposed_value: 0.9 }])]
      }));
      result.suggestions.should.have.lengthOf(1);
      result.suggestions[0].validation_notes.join(' ').should.match(/differs from profile value 1/);
    });

    it('does not note when current_value agrees with the profile', function () {
      const result = parse(response({ suggestions: [suggestion('basal_rate', [basalBlock])] }));
      result.suggestions[0].validation_notes.join(' ').should.not.match(/differs from profile/);
    });
  });

  describe('mergeSuggestions', function () {
    it('merges two basal suggestions into one with sorted blocks and highest confidence', function () {
      const result = parse(response({
        suggestions: [
          suggestion('basal_rate', [{ start_seconds: 21600, end_seconds: 43200, current_value: 1.0, proposed_value: 1.1 }], {
            confidence: 'low', reasoning: 'Second reasoning.', plain_summary: ''
          })
          , suggestion('basal_rate', [basalBlock], { confidence: 'high', reasoning: 'First reasoning.', plain_summary: 'Summary B' })
        ]
      }));
      result.suggestions.should.have.lengthOf(1);
      const merged = result.suggestions[0];
      merged.setting_type.should.equal('basal_rate');
      merged.time_blocks.should.have.lengthOf(2);
      merged.time_blocks[0].start_seconds.should.equal(0);
      merged.time_blocks[1].start_seconds.should.equal(21600);
      merged.confidence.should.equal('high');
      merged.reasoning.should.equal('Second reasoning. First reasoning.');
      merged.plain_summary.should.equal('Summary B');
      merged.success_criteria.expected_outcomes.should.have.lengthOf(1);
    });

    it('returns null for an empty list', function () {
      (validator.mergeSuggestions([], 'basal_rate') === null).should.be.true();
    });
  });

  describe('checkCitations', function () {
    it('notes a citation that does not match any hourly mean', function () {
      // hourly means span 120..189, so 95 and 399 cannot match
      const notes = validator.checkCitations('The overnight average was 95 mg/dL and glucose peaked at 399.', hourly);
      notes.should.containEql('citation 95 mg/dL not found in hourly averages');
      notes.should.containEql('citation 399 mg/dL not found in hourly averages');
    });

    it('does not note a matching citation (within +-2)', function () {
      // hour 10 mean is 150; hour 20 mean is 180
      const notes = validator.checkCitations('Average glucose of 151 mg/dL at 10am and glucose around 182 in the evening.', hourly);
      notes.should.eql([]);
    });

    it('dedupes repeated numbers and ignores values outside 40..400', function () {
      const notes = validator.checkCitations('Readings of 30 mg/dL, 500 mg/dL and 250 mg/dL, then 250 mg/dL again.', hourly);
      notes.should.eql(['citation 250 mg/dL not found in hourly averages']);
    });

    it('is a no-op when hourly data is absent', function () {
      validator.checkCitations('162 mg/dL', []).should.eql([]);
    });

    it('attaches mismatch notes to the parsed suggestion', function () {
      const result = parse(response({
        suggestions: [suggestion('basal_rate', [basalBlock], { reasoning: 'Average glucose was 95 mg/dL overnight.' })]
      }));
      result.suggestions[0].validation_notes.join(' ').should.match(/citation 95/);
    });
  });

  describe('applyConfidenceCap', function () {
    it('caps carb ratio confidence with 3 meals', function () {
      const result = parse(response({
        suggestions: [suggestion('carb_ratio', [{ start_seconds: 0, end_seconds: 86400, current_value: 10, proposed_value: 11 }], { confidence: 'high' })]
      }), { settingType: 'carb_ratio', mealCount: 3 });
      result.suggestions.should.have.lengthOf(1);
      result.suggestions[0].confidence.should.equal('low');
      result.suggestions[0].reasoning.should.match(/⚠️ Limited data: only 3 meal entries/);
      result.suggestions[0].validation_notes.join(' ').should.match(/confidence capped/);
    });

    it('caps ISF confidence with 2 corrections', function () {
      const result = parse(response({
        suggestions: [suggestion('insulin_sensitivity', [{ start_seconds: 0, end_seconds: 86400, current_value: 50, proposed_value: 45 }], { confidence: 'medium' })]
      }), { settingType: 'insulin_sensitivity', correctionCount: 2 });
      result.suggestions[0].confidence.should.equal('low');
      result.suggestions[0].reasoning.should.match(/Limited data: only 2 correction boluses/);
    });

    it('does not cap basal or when counts are sufficient', function () {
      const basal = parse(response({ suggestions: [suggestion('basal_rate', [basalBlock])] }), { mealCount: 0, correctionCount: 0 });
      basal.suggestions[0].confidence.should.equal('medium');
      const cr = parse(response({
        suggestions: [suggestion('carb_ratio', [{ start_seconds: 0, end_seconds: 86400, current_value: 10, proposed_value: 11 }])]
      }), { settingType: 'carb_ratio', mealCount: 5 });
      cr.suggestions[0].confidence.should.equal('medium');
    });
  });

  describe('hasContradiction', function () {
    it('returns the matched phrase case-insensitively', function () {
      validator.hasContradiction('There is Insufficient Data to be sure.').should.equal('insufficient data');
      (validator.hasContradiction('Clear pattern of highs.') === null).should.be.true();
    });

    it('drops a medium-confidence suggestion whose reasoning contradicts itself', function () {
      const result = parse(response({
        suggestions: [suggestion('basal_rate', [basalBlock], { reasoning: 'Overnight ISF cannot be determined from this data, so I kept close to current settings.' })]
      }));
      result.suggestions.should.have.lengthOf(0);
      result.validationNotes.join(' ').should.match(/cannot be determined/);
    });

    it('keeps a low-confidence suggestion with a contradiction phrase', function () {
      const result = parse(response({
        suggestions: [suggestion('basal_rate', [basalBlock], { confidence: 'low', reasoning: 'Insufficient data, but a small nudge seems safe.' })]
      }));
      result.suggestions.should.have.lengthOf(1);
    });
  });

  describe('success_criteria', function () {
    it('drops success_criteria without expected_outcomes and defaults evaluation_days', function () {
      const withoutOutcomes = suggestion('basal_rate', [basalBlock], { success_criteria: { evaluation_days: 7 } });
      const result = parse(response({ suggestions: [withoutOutcomes] }));
      (result.suggestions[0].success_criteria === null).should.be.true();

      const noDays = suggestion('basal_rate', [basalBlock], { success_criteria: { expected_outcomes: ['Lower highs'] } });
      const result2 = parse(response({ suggestions: [noDays] }));
      result2.suggestions[0].success_criteria.should.eql({
        expected_outcomes: ['Lower highs']
        , evaluation_days: 5
        , revert_warnings: []
        , metric_targets: {}
      });
    });

    it('clamps evaluation_days to 1..30', function () {
      const tooMany = suggestion('basal_rate', [basalBlock], { success_criteria: { expected_outcomes: ['x'], evaluation_days: 99 } });
      parse(response({ suggestions: [tooMany] })).suggestions[0].success_criteria.evaluation_days.should.equal(30);
      const tooFew = suggestion('basal_rate', [basalBlock], { success_criteria: { expected_outcomes: ['x'], evaluation_days: 0 } });
      parse(response({ suggestions: [tooFew] })).suggestions[0].success_criteria.evaluation_days.should.equal(1);
    });
  });

  describe('pastEvaluations and nextRecommendedFocus', function () {
    it('sanitises past_suggestion_evaluations', function () {
      const result = parse(response({
        past_suggestion_evaluations: {
          'rec-1': { criteria_met: '2', criteria_total: 3.4, verdict: 'partial', reasoning: 'Dropped <b>from</b> 145 to 132.' }
          , 'rec-2': { criteria_met: 1, criteria_total: 2, verdict: 'amazing', reasoning: 'bad verdict' }
          , 'rec-3': 'not an object'
          , 'rec-4': { verdict: 'success' }
        }
      }));
      Object.keys(result.pastEvaluations).should.eql(['rec-1', 'rec-4']);
      result.pastEvaluations['rec-1'].should.eql({ criteria_met: 2, criteria_total: 3, verdict: 'partial', reasoning: 'Dropped from 145 to 132.' });
      result.pastEvaluations['rec-4'].should.eql({ criteria_met: 0, criteria_total: 0, verdict: 'success', reasoning: '' });
    });

    it('maps an invalid next_recommended_focus to null and keeps a valid one', function () {
      parse(response({ next_recommended_focus: 'bolus_wizard' })).should.have.property('nextRecommendedFocus', null);
      parse(response({ next_recommended_focus: 'null' })).should.have.property('nextRecommendedFocus', null);
      parse(response({ next_recommended_focus: 'carb_ratio' })).should.have.property('nextRecommendedFocus', 'carb_ratio');
    });
  });

  describe('HTML stripping', function () {
    it('strips tags from all free-text fields', function () {
      const result = parse(response({
        overall_assessment: 'Looks <script>alert(1)</script>fine'
        , suggestions: [suggestion('basal_rate', [basalBlock], {
          reasoning: 'Average <i>glucose</i> was 150 mg/dL.'
          , plain_summary: '<b>Bold</b> claim'
          , success_criteria: {
            expected_outcomes: ['<em>Lower</em> overnight']
            , revert_warnings: ['<a href="x">lows</a>']
            , metric_targets: { avg: '<130 mg/dL', other: '<span>x</span>' }
          }
        })]
      }));
      result.overallAssessment.should.equal('Looks alert(1)fine');
      const s = result.suggestions[0];
      s.reasoning.should.equal('Average glucose was 150 mg/dL.');
      s.plain_summary.should.equal('Bold claim');
      s.success_criteria.expected_outcomes.should.eql(['Lower overnight']);
      s.success_criteria.revert_warnings.should.eql(['lows']);
      s.success_criteria.metric_targets.other.should.equal('x');
    });
  });

  describe('parseTrends', function () {
    it('parses SUMMARY and HIGHLIGHTS sections', function () {
      const text = 'SUMMARY:\nYour week was steady.\nNights were quiet.\n\nHIGHLIGHTS:\n- TIR rose to 74%\n• Fewer lows\n* Dawn rise on 3 days\n  continued on next line';
      const result = validator.parseTrends(text);
      result.summary.should.equal('Your week was steady. Nights were quiet.');
      result.highlights.should.eql(['TIR rose to 74%', 'Fewer lows', 'Dawn rise on 3 days continued on next line']);
    });

    it('accepts headers without a colon, mixed case and markdown bold', function () {
      const result = validator.parseTrends('**Summary** Steady week.\nHighlight\n- One thing');
      result.summary.should.equal('Steady week.');
      result.highlights.should.eql(['One thing']);
    });

    it('falls back to the whole text as the summary', function () {
      const result = validator.parseTrends('  Just a paragraph with no headers.  ');
      result.summary.should.equal('Just a paragraph with no headers.');
      result.highlights.should.eql([]);
    });
  });

  describe('parseDebrief', function () {
    it('splits body and learnings', function () {
      const text = 'Your pizza behaved like ~65g of carbs over 4 hours.\n\nLEARNINGS:\n- Extend the bolus for pizza\n* Pre-bolus 15 minutes';
      const result = validator.parseDebrief(text);
      result.body.should.equal('Your pizza behaved like ~65g of carbs over 4 hours.');
      result.learnings.should.eql(['Extend the bolus for pizza', 'Pre-bolus 15 minutes']);
      result.effectiveCarbs.should.equal(65);
    });

    it('defaults the learnings when none are present', function () {
      const result = validator.parseDebrief('Nothing unusual here.');
      result.body.should.equal('Nothing unusual here.');
      result.learnings.should.eql(['Review your carb count for this meal type']);
      (result.effectiveCarbs === null).should.be.true();
    });

    it('extracts effective carbs via every supported phrasing', function () {
      validator.parseDebrief('This meal was effectively 40 g.').effectiveCarbs.should.equal(40);
      validator.parseDebrief('It was equivalent to ~55g of carbs.').effectiveCarbs.should.equal(55);
      validator.parseDebrief('The snack acted as 20g.').effectiveCarbs.should.equal(20);
    });
  });
});
