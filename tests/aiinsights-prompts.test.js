'use strict';

require('should');

const units = require('../lib/aiinsights/prompts/units');
const format = require('../lib/aiinsights/prompts/format');
const settings = require('../lib/aiinsights/prompts/settings');
const trends = require('../lib/aiinsights/prompts/trends');
const chat = require('../lib/aiinsights/prompts/chat');
const meal = require('../lib/aiinsights/prompts/meal');
const types = require('../lib/aiinsights/types');

const MGDL_UNIT_CONTEXT = [
  'UNIT CONTEXT — IMPORTANT:'
  , '- The user uses mg/dL for blood glucose.'
  , '- ALL glucose values in your response — both numeric figures and any prose — MUST be expressed in mg/dL.'
  , '- Glucose data in the prompt below may be in mg/dL; convert to mg/dL for the user.'
  , '- Use Rule of 1800 (ISF mg/dL per unit ≈ 1800 ÷ TDD) for any insulin sensitivity factor calculations.'
  , '- Time in Range target range is 70-180 mg/dL.'
].join('\n');

function hourly (means) {
  const out = [];
  for (let h = 0; h < 24; h++) {
    const mean = means[h] === undefined ? null : means[h];
    out.push({ hour: h, mean: mean, count: mean === null ? 0 : 10 });
  }
  return out;
}

// Overnight rising sharply (ELEVATED + SIGNIFICANT DRIFT Rising), morning falling
// sharply (SIGNIFICANT DRIFT Falling, not elevated), midday flat and elevated,
// afternoon has a single hour, evening has no data, late night two hours.
const FIXTURE_MEANS = {
  0: 140, 1: 150, 2: 160, 3: null, 4: 170, 5: 185
  , 6: 170, 7: 150, 8: 140, 9: 130
  , 10: 160, 11: 165, 12: 160, 13: 162
  , 14: 120
  , 22: 110, 23: 100
};

function fixtureAgg (overrides) {
  const agg = {
    period: { days: 14, fromMs: 0, toMs: 14 * 86400000, timezone: 'UTC' }
    , tightRangeUpperBound: 140
    , glucose: {
      count: 4032
      , mean: 148.4
      , sd: 42.6
      , cv: 28.7
      , veryHighPct: 3
      , highPct: 20
      , inRangePct: 72.5
      , lowPct: 2
      , veryLowPct: 0.5
      , tirPct: 72.5
      , titrPct: 45.1
      , tbrPct: 2.5
      , tarPct: 25
      , gmi: 6.86
      , hourly: hourly(FIXTURE_MEANS)
      , hourlyByDay: {}
      , readings: []
    }
    , insulin: {
      tddAvg: 36.4
      , tddMin: 30.2
      , tddMax: 44.9
      , tddCv: 12.3
      , tddWeekOverWeekPct: -4.2
      , basalTotal: 200
      , bolusTotal: 309
      , basalPct: 39.3
      , bolusPct: 60.7
      , correctionCount: 42
      , automaticCorrectionCount: 30
      , correctionsPerDay: 3
      , daily: []
      , boluses: []
      , suspensions: { events: 0, totalMinutes: 0, pctOfPeriod: 0, subBasalMinutes: 0, overcorrectionEvents: 0, byHour: [] }
      , source: 'reconstructed'
    }
    , carbs: {
      dailyAvg: 155.6
      , entryCount: 41
      , perMealAvg: 53.1
      , byHour: []
      , entries: []
    }
    , settings: {
      basal: [
        { startSeconds: 21600, value: 1.1 }
        , { startSeconds: 0, value: 0.85 }
        , { startSeconds: 45000, value: 0.95 }
      ]
      , carbratio: [{ startSeconds: 0, value: 10 }, { startSeconds: 43200, value: 12.5 }]
      , sens: [{ startSeconds: 0, value: 45 }, { startSeconds: 79200, value: 55.5 }]
      , dia: 6
      , insulinType: 'Fiasp'
      , profileName: 'Default'
      , profileId: 'p1'
      , profileUnits: 'mg/dl'
      , system: 'Loop'
      , timezone: 'UTC'
    }
    , devicestatus: []
  };
  return Object.assign(agg, overrides || {});
}

function baseInput (settingType, extra) {
  return Object.assign({
    settingType: settingType
    , agg: fixtureAgg()
    , pastOutcomes: []
    , recentChanges: []
    , supplementalContext: ''
    , biometricContext: ''
  }, extra || {});
}

function sectionOrder (text, headings) {
  let last = -1;
  headings.forEach(function eachHeading (h) {
    const idx = text.indexOf(h);
    idx.should.be.above(-1, 'missing heading ' + h);
    idx.should.be.above(last, 'heading out of order: ' + h);
    last = idx;
  });
}

describe('aiinsights prompts', function () {

  describe('format', function () {
    it('formats seconds since midnight as h:mm AM/PM', function () {
      format.fmtTime12(0).should.equal('12:00 AM');
      format.fmtTime12(21600).should.equal('6:00 AM');
      format.fmtTime12(45000).should.equal('12:30 PM');
      format.fmtTime12(79200).should.equal('10:00 PM');
      format.fmtTime12(86399).should.equal('11:59 PM');
    });

    it('formats hours as HH:00', function () {
      format.fmtHour24(0).should.equal('00:00');
      format.fmtHour24(9).should.equal('09:00');
      format.fmtHour24(23).should.equal('23:00');
    });

    it('formats numbers, signed numbers and percentages', function () {
      format.fmt(3.14159, 1).should.equal('3.1');
      format.fmt(3, 0).should.equal('3');
      format.fmt(null, 1).should.equal('n/a');
      format.fmtSigned(5, 0).should.equal('+5');
      format.fmtSigned(-3.2, 0).should.equal('-3');
      format.fmtSigned(0, 0).should.equal('+0');
      format.fmtSigned(-0.04, 1).should.equal('+0.0');
      format.pct(72.46, 1).should.equal('72.5%');
    });
  });

  describe('units', function () {
    it('always returns the mg/dL unit context, even when asked for mmol', function () {
      units.unitContext().should.equal(MGDL_UNIT_CONTEXT);
      units.unitContext('mmol').should.equal(MGDL_UNIT_CONTEXT);
      units.unitContext('mg/dl').should.equal(MGDL_UNIT_CONTEXT);
      units.unitContext('mmol').should.not.containEql('mmol/L');
      units.unitContext('mmol').should.not.containEql('Rule of 100');
    });

    it('exposes the four personalities with the spec text', function () {
      Object.keys(units.PERSONALITIES).sort().should.eql(types.PERSONALITIES.slice().sort());
      units.DEFAULT_PERSONALITY.should.equal('supportive_coach');
      units.personality('supportive_coach').should.startWith('PERSONALITY: You are a warm, encouraging diabetes coach. Celebrate what\'s going well before discussing changes.');
      units.personality('clinical_expert').should.startWith('PERSONALITY: You are a board-certified endocrinologist reviewing pump settings.');
      units.personality('dry_wit').should.containEql('"Your overnight basals are throwing a party your glucose wasn\'t invited to"');
      units.personality('tough_love').should.endWith('You\'re straightforward because clarity helps, not because you\'re trying to make anyone feel bad about their numbers.');
      units.personality().should.equal(units.PERSONALITIES.supportive_coach);
    });

    it('throws on an unknown personality key', function () {
      (function () { units.personality('sarcastic_robot'); }).should.throw(/Unknown AI personality/);
      (function () { units.personality('toString'); }).should.throw(/Unknown AI personality/);
    });
  });

  describe('settings.systemPrompt', function () {
    const prompt = settings.systemPrompt({ personality: 'clinical_expert' });

    it('starts with the mg/dL unit context', function () {
      prompt.should.startWith(MGDL_UNIT_CONTEXT + '\n\nJSON FIELD UNITS — IMPORTANT:');
    });

    it('substitutes the personality and leaves no placeholders', function () {
      prompt.should.containEql('\n\n' + units.PERSONALITIES.clinical_expert + '\n\nYOUR MANDATE:');
      prompt.should.not.containEql('{{');
      types.PERSONALITIES.forEach(function eachKey (key) {
        settings.systemPrompt({ personality: key }).should.containEql(units.PERSONALITIES[key]);
      });
      settings.systemPrompt({}).should.containEql(units.PERSONALITIES.supportive_coach);
    });

    it('contains the exact spec paragraphs', function () {
      prompt.should.containEql('You are Loopy, an expert-level automated insulin delivery (AID) therapy settings analyst. You think like a top board certified endocrinologist who specializes in insulin pump optimization. You analyze glucose, insulin, and carbohydrate data to determine whether therapy settings need adjustment.');
      prompt.should.containEql('YOUR MANDATE: Be analytically rigorous. You have this person\'s REAL data — their actual glucose readings, insulin delivery, carb logs, and pump settings. Every recommendation must cite specific numbers from THEIR data, not generic clinical wisdom. If the data does not justify a change, return zero suggestions — that is the correct response when settings are working. You are not here to impress or people-please. You are here to find real problems in THIS person\'s data and propose precise fixes grounded in THEIR numbers.');
      prompt.should.containEql('- BASAL RATE: Controls glucose during fasting periods. Analyze overnight (12AM-6AM) and   between-meal trends. In AID systems, the algorithm adjusts delivery around this baseline.   ⚠️ HIGHEST RISK SETTING — basal delivers insulin 24/7, including overnight when the user   is asleep.');
      prompt.should.containEql('SAFETY RULES:\n1. Never suggest CR or ISF changes larger than 20% from current values in a single step.    For BASAL RATE, never suggest changes larger than 10% — basal delivers insulin continuously    and small changes compound over hours, especially overnight.');
      prompt.should.containEql('   - Carb Ratio: 2.0–150.0 g/U (recommended 4.0–28.0)\n   - ISF: 10.0–500.0 mg/dL/U (recommended 16.0–400.0)\n   - Basal Rate: 0.05–30.0 U/hr (recommended 0.05–10.0)\n   Values outside the recommended range should only be proposed with LOW confidence and explicit justification.');
      prompt.should.containEql('IMPORTANT: If glucose outcomes are good (TIR >80%, time below range <4%, CV <36%), respect that the current settings are working for THIS person.');
      prompt.should.containEql('  On an empty stomach, drinking alcohol can also cause short term hypoglycemia. Alcohol is a toxin,   so the body \'spends\' extra glucose energy to process the toxin out. With no onboard glucose the user may go low. \nUSER ENGAGEMENT & ADHERENCE — When engagement metrics are provided:');
    });

    it('contains the RESPONSE FORMAT JSON skeleton', function () {
      prompt.should.containEql([
        'RESPONSE FORMAT:'
        , 'Respond with valid JSON in this exact structure:'
        , '{'
        , '    "past_suggestion_evaluations": {'
        , '        "record-uuid-here": {'
        , '            "criteria_met": 2,'
        , '            "criteria_total": 3,'
        , '            "verdict": "partial",'
        , '            "reasoning": "Overnight average dropped from 145 to 132 mg/dL (met), but time below range increased to 5% (not met)."'
        , '        }'
        , '    },'
        , '    "suggestions": ['
        , '        {'
        , '            "time_blocks": ['
        , '                {'
        , '                    "start_seconds": 0,'
        , '                    "end_seconds": 21600,'
        , '                    "current_value": 10.0,'
        , '                    "proposed_value": 11.0'
        , '                }'
        , '            ],'
      ].join('\n'));
      prompt.should.containEql('    "overall_assessment": "Factual summary including: time-of-day pattern summary, glucose outcome trends, and what the basal/bolus ratio tells us",\n    "next_recommended_focus": "carb_ratio|insulin_sensitivity|basal_rate|null"\n}');
      prompt.should.containEql('If NO changes are warranted, return: { "suggestions": [], "past_suggestion_evaluations": {}, "overall_assessment": "...", "next_recommended_focus": null }');
      prompt.should.endWith('Combine all time blocks for the same setting type into a single suggestion. Do NOT return separate suggestions for the same setting — use multiple time_blocks within one suggestion.');
    });
  });

  describe('settings.timeOfDayAnalysis', function () {
    const text = settings.timeOfDayAnalysis(hourly(FIXTURE_MEANS));
    const lines = text.split('\n');

    it('renders every period in order with avg, range and trend', function () {
      lines[0].should.equal('- Overnight (12AM-6AM): avg 161 mg/dL, range 140-185, trend +45 mg/dL');
      text.should.containEql('\n- Morning (6AM-10AM): avg 148 mg/dL, range 130-170, trend -40 mg/dL\n');
      text.should.containEql('\n- Midday (10AM-2PM): avg 162 mg/dL, range 160-165, trend +2 mg/dL\n');
      text.should.containEql('\n- Afternoon (2PM-6PM): avg 120 mg/dL, range 120-120, trend +0 mg/dL\n');
      text.should.containEql('\n- Evening (6PM-10PM): no data\n');
      lines[lines.length - 1].should.equal('- Late Night (10PM-12AM): avg 105 mg/dL, range 100-110, trend -10 mg/dL');
    });

    it('flags ELEVATED when avg > 150 and SIGNIFICANT DRIFT when |trend| > 30', function () {
      lines[1].should.equal('  ** ELEVATED: Average glucose in this period is above 150 mg/dL **');
      lines[2].should.equal('  ** SIGNIFICANT DRIFT: Rising 45 mg/dL across this period **');
      const morningIdx = lines.indexOf('- Morning (6AM-10AM): avg 148 mg/dL, range 130-170, trend -40 mg/dL');
      lines[morningIdx + 1].should.equal('  ** SIGNIFICANT DRIFT: Falling 40 mg/dL across this period **');
      lines[morningIdx + 2].should.startWith('- Midday');
      const middayIdx = morningIdx + 2;
      lines[middayIdx + 1].should.equal('  ** ELEVATED: Average glucose in this period is above 150 mg/dL **');
      lines[middayIdx + 2].should.startWith('- Afternoon');
      text.match(/ELEVATED/g).length.should.equal(2);
      text.match(/SIGNIFICANT DRIFT/g).length.should.equal(2);
    });

    it('renders no data for every period when there are no hourly means', function () {
      settings.timeOfDayAnalysis([]).split('\n').should.eql([
        '- Overnight (12AM-6AM): no data'
        , '- Morning (6AM-10AM): no data'
        , '- Midday (10AM-2PM): no data'
        , '- Afternoon (2PM-6PM): no data'
        , '- Evening (6PM-10PM): no data'
        , '- Late Night (10PM-12AM): no data'
      ]);
    });
  });

  describe('settings.userPrompt', function () {
    it('renders the sections in spec order', function () {
      const text = settings.userPrompt(baseInput('carb_ratio', {
        pastOutcomes: [{
          record_id: 'rec-1'
          , applied_days_ago: 4
          , change_description: '12:00 AM–6:00 AM: 10.0 → 9.5 g/U.'
          , evaluation_days: 5
          , expected_outcomes: ['Post-breakfast peak should drop below 180 mg/dL', 'TBR should stay under 3%']
          , revert_warnings: ['More than 2 lows below 60 mg/dL', 'TBR above 6%']
          , post_change_hourly: [{ hour: 0, mean: 131.4, count: 10 }, { hour: 1, mean: null, count: 0 }, { hour: 2, mean: 128, count: 8 }]
        }]
        , recentChanges: [{ applied_ago_text: '5 hours', change_description: '6:00 AM–12:00 PM: 12.0 → 11.0 g/U. ' }]
        , supplementalContext: '## Circadian Glucose Profile\n- Estimated bed time: 23:00, wake time: 7:00'
        , biometricContext: '### Heart Rate\n- Average Resting HR: 58 bpm'
      }));

      text.should.startWith('Evaluate whether my Carb Ratio settings need adjustment.\n\n## Previously Applied Suggestions — EVALUATE THESE FIRST\nBefore making new recommendations, evaluate each of these past changes against their success criteria.\n\n### Record ID: rec-1\n- Applied 4 day(s) ago\n- Change: 12:00 AM–6:00 AM: 10.0 → 9.5 g/U.\n- Evaluation window: 5 days\n- Success criteria:\n  1. Post-breakfast peak should drop below 180 mg/dL\n  2. TBR should stay under 3%\n- Revert warnings: More than 2 lows below 60 mg/dL; TBR above 6%\n- Post-change hourly glucose averages:\n  00:00: 131 mg/dL\n  02:00: 128 mg/dL\n\n## IMPORTANT: Recent Settings Changes\n');
      text.should.containEql('\n\n- Applied 5 hours ago: 6:00 AM–12:00 PM: 12.0 → 11.0 g/U. \n\n## AID System & Device Context\n');

      sectionOrder(text, [
        'Evaluate whether my Carb Ratio settings need adjustment.'
        , '## Previously Applied Suggestions — EVALUATE THESE FIRST'
        , '## IMPORTANT: Recent Settings Changes'
        , '## AID System & Device Context'
        , '## All Current Therapy Settings'
        , '### Basal Rate Schedule'
        , '### Insulin Sensitivity Factor Schedule'
        , '### Carb Ratio Schedule'
        , '## Glucose Statistics (14 Days)'
        , '### Hourly Average Glucose'
        , '## Insulin Statistics'
        , '## Carbohydrate Statistics'
        , '## Biometric Context'
        , '## Time-of-Day Analysis (computed from hourly averages)'
        , '## Supplemental Analysis Context'
        , 'Analyze this data focusing specifically on Carb Ratio.'
        , 'Respond with JSON only, no markdown formatting.'
      ]);
      text.should.containEql('## Biometric Context\n### Heart Rate\n- Average Resting HR: 58 bpm\n\n## Time-of-Day Analysis');
      text.should.containEql('## Supplemental Analysis Context\n## Circadian Glucose Profile\n- Estimated bed time: 23:00, wake time: 7:00\n\nAnalyze this data');
      text.should.endWith('Respond with JSON only, no markdown formatting.');
    });

    it('renders the AID system block from the snapshot', function () {
      const text = settings.userPrompt(baseInput('carb_ratio'));
      text.should.containEql('## AID System & Device Context\n- **System**: Loop (oref-based automated insulin delivery)\n- **Algorithm**: Loop\'s dosing algorithm uses DIA, ISF, CR, and basal schedules to calculate IOB and make automated delivery adjustments.\n- **Duration of Insulin Action (DIA): 6.0 hours** ← This is the user\'s ACTUAL configured DIA. Do NOT recommend a different DIA. The oref algorithm in Loop uses longer DIA values (typically 6-10 hours) than textbook insulin action curves. This is intentional and correct for this AID system.\n- **Insulin Type**: Fiasp\n- Use these current settings as your reference point. Any recommendations must be small adjustments FROM these values based on data patterns, not replacements based on clinical norms.\n\n## All Current Therapy Settings\nYou are analyzing **Carb Ratio** specifically, but consider how all three settings interact.\n');

      const agg = fixtureAgg();
      agg.settings = Object.assign({}, agg.settings, { system: 'Trio', dia: null });
      const other = settings.userPrompt(baseInput('carb_ratio', { agg: agg }));
      other.should.containEql('- **System**: Trio (oref-based automated insulin delivery)');
      other.should.containEql('- **Duration of Insulin Action (DIA): unknown hours**');
    });

    it('marks only the analyzed schedule and formats schedule values', function () {
      const schedules = '### Basal Rate Schedule\n- 12:00 AM: 0.85 U/hr\n- 6:00 AM: 1.10 U/hr\n- 12:30 PM: 0.95 U/hr\n\n### Insulin Sensitivity Factor Schedule\n- 12:00 AM: 45.0 mg/dL per U\n- 10:00 PM: 55.5 mg/dL per U\n\n### Carb Ratio Schedule\n- 12:00 AM: 10.0 g/U\n- 12:00 PM: 12.5 g/U\n\n\n## Glucose Statistics (14 Days)';

      const basal = settings.userPrompt(baseInput('basal_rate'));
      basal.should.containEql(schedules.replace('### Basal Rate Schedule', '### Basal Rate Schedule ← ANALYZING THIS'));
      basal.match(/← ANALYZING THIS/g).length.should.equal(1);

      const isf = settings.userPrompt(baseInput('insulin_sensitivity'));
      isf.should.containEql(schedules.replace('### Insulin Sensitivity Factor Schedule', '### Insulin Sensitivity Factor Schedule ← ANALYZING THIS'));
      isf.match(/← ANALYZING THIS/g).length.should.equal(1);

      const cr = settings.userPrompt(baseInput('carb_ratio'));
      cr.should.containEql(schedules.replace('### Carb Ratio Schedule', '### Carb Ratio Schedule ← ANALYZING THIS'));
      cr.match(/← ANALYZING THIS/g).length.should.equal(1);
    });

    it('renders glucose statistics and skips hourly rows without data', function () {
      const text = settings.userPrompt(baseInput('insulin_sensitivity'));
      text.should.containEql('## Glucose Statistics (14 Days)\n- Average Glucose: 148 mg/dL\n- Standard Deviation: 43 mg/dL\n- Coefficient of Variation: 28.7%\n- Time in Range (70-180): 72.5%\n- Time in Tight Range (70-140): 45.1%\n- Time Below Range (<70): 2.5%\n- Time Above Range (>180): 25.0%\n- GMI (est. A1C): 6.9%\n- Sample Count: 4032\n\n### Hourly Average Glucose\n- 00:00: 140 mg/dL\n- 01:00: 150 mg/dL\n- 02:00: 160 mg/dL\n- 04:00: 170 mg/dL\n');
      text.should.not.containEql('- 03:00:');
      text.should.not.containEql('- 15:00:');
      text.should.containEql('- 14:00: 120 mg/dL\n- 22:00: 110 mg/dL\n- 23:00: 100 mg/dL\n\n## Insulin Statistics');
      text.match(/^- \d\d:00: \d+ mg\/dL$/mg).length.should.equal(16);
    });

    it('renders insulin and carb statistics, with Week-over-Week only when available', function () {
      const text = settings.userPrompt(baseInput('carb_ratio'));
      text.should.containEql('## Insulin Statistics\n- TDI: 36.4 U/day (range: 30.2–44.9, CV: 12%)\n- TDI Week-over-Week: -4%\n- Basal: 39% / Bolus: 61%\n- Correction Boluses: 42 in period (30 automatic)\n- Corrections per Day: 3.0\n\n## Carbohydrate Statistics\n- Average Daily Carbs: 156 g/day\n- Meals Logged: 41\n- Average Carbs per Meal: 53 g\n\n');

      const agg = fixtureAgg();
      agg.period = Object.assign({}, agg.period, { days: 7 });
      agg.insulin = Object.assign({}, agg.insulin, { tddWeekOverWeekPct: null, automaticCorrectionCount: 0 });
      const short = settings.userPrompt(baseInput('carb_ratio', { agg: agg }));
      short.should.containEql('## Glucose Statistics (7 Days)');
      short.should.not.containEql('Week-over-Week');
      short.should.containEql('- TDI: 36.4 U/day (range: 30.2–44.9, CV: 12%)\n- Basal: 39% / Bolus: 61%\n- Correction Boluses: 42 in period\n- Corrections per Day: 3.0\n');
    });

    it('omits the conditional sections when their inputs are empty', function () {
      const text = settings.userPrompt(baseInput('carb_ratio'));
      text.should.startWith('Evaluate whether my Carb Ratio settings need adjustment.\n\n## AID System & Device Context\n');
      text.should.not.containEql('Previously Applied Suggestions');
      text.should.not.containEql('Recent Settings Changes');
      text.should.not.containEql('## Biometric Context');
      text.should.not.containEql('## Supplemental Analysis Context');
      text.should.not.containEql('BASAL RATE REMINDER');
      text.should.containEql('## Carbohydrate Statistics\n- Average Daily Carbs: 156 g/day\n- Meals Logged: 41\n- Average Carbs per Meal: 53 g\n\n## Time-of-Day Analysis (computed from hourly averages)\n- Overnight (12AM-6AM): avg 161 mg/dL, range 140-185, trend +45 mg/dL\n  ** ELEVATED: Average glucose in this period is above 150 mg/dL **\n  ** SIGNIFICANT DRIFT: Rising 45 mg/dL across this period **\n- Morning (6AM-10AM): avg 148 mg/dL, range 130-170, trend -40 mg/dL\n  ** SIGNIFICANT DRIFT: Falling 40 mg/dL across this period **\n- Midday (10AM-2PM): avg 162 mg/dL, range 160-165, trend +2 mg/dL\n  ** ELEVATED: Average glucose in this period is above 150 mg/dL **\n- Afternoon (2PM-6PM): avg 120 mg/dL, range 120-120, trend +0 mg/dL\n- Evening (6PM-10PM): no data\n- Late Night (10PM-12AM): avg 105 mg/dL, range 100-110, trend -10 mg/dL\n\nAnalyze this data focusing specifically on Carb Ratio. Use the time-of-day analysis and glucose outcome metrics to identify actionable patterns. If supplemental context is provided above, incorporate it into your reasoning. If the data clearly supports adjustments, propose them. If not, return empty suggestions. \n\nRespond with JSON only, no markdown formatting.');
      text.should.endWith('\n\nRespond with JSON only, no markdown formatting.');
    });

    it('appends the basal rate reminder only for basal_rate', function () {
      const reminder = '⚠️ BASAL RATE REMINDER: Basal rate is the highest-risk setting to change. It delivers insulin continuously, including overnight when the user is asleep. Limit all proposed changes to ≤10% per time block. For overnight blocks (10PM–6AM), prefer even smaller changes (5–7%). If suggesting any basal increase, you MUST include a warning about monitoring for nighttime lows in your reasoning. If time below range is >2%, strongly consider whether basal is already too high.';
      const basal = settings.userPrompt(baseInput('basal_rate'));
      basal.should.endWith('If not, return empty suggestions. \n\n' + reminder + '\n\nRespond with JSON only, no markdown formatting.');
      settings.userPrompt(baseInput('carb_ratio')).should.not.containEql(reminder);
      settings.userPrompt(baseInput('insulin_sensitivity')).should.not.containEql(reminder);
    });

    it('rejects unknown setting types', function () {
      (function () { settings.userPrompt(baseInput('target_range')); }).should.throw(/Unknown setting type/);
    });
  });

  describe('trends', function () {
    it('renders the system prompt with unit context and personality', function () {
      const text = trends.systemPrompt({ personality: 'dry_wit' });
      text.should.startWith(MGDL_UNIT_CONTEXT + '\n\nYou are an expert diabetes advisor providing a trends summary for a specific Loop AID user.');
      text.should.containEql('not hypothetical.\n' + units.PERSONALITIES.dry_wit + '\n\nYOUR #1 RULE — ALWAYS GROUND IN THEIR DATA:');
      text.should.containEql('RESPONSE FORMAT — you MUST use exactly this structure:\n\nSUMMARY:\n');
      text.should.endWith('HIGHLIGHTS:\n- First key observation citing their specific data (one sentence)\n- Second key observation citing their specific data (one sentence)\n- Third key observation citing their specific data (one sentence)\n\nKeep it concise and actionable. Every highlight must include at least one specific number from their data.');
      text.should.not.containEql('{{');
    });

    it('renders the user prompt per tab', function () {
      trends.userPrompt({ tab: 'daily', therapyContext: 'CTX' }).should.equal('Generate a Daily trends summary for this user\'s diabetes data:\n\nCTX');
      trends.userPrompt({ tab: 'weekly', therapyContext: 'CTX' }).should.startWith('Generate a Weekly trends summary');
      trends.userPrompt({ tab: 'monthly', therapyContext: 'CTX' }).should.startWith('Generate a Monthly trends summary');
      trends.userPrompt({ tab: 'monthly', therapyContext: '' }).should.endWith('\n\nNo therapy data currently available.');
      (function () { trends.userPrompt({ tab: 'yearly' }); }).should.throw(/Unknown trends tab/);
    });

    it('builds the therapy context block with Rule of 1800 / 500 values', function () {
      const text = trends.buildTherapyContext(fixtureAgg());
      text.should.startWith('CURRENT THERAPY SETTINGS:\nBasal Rates:\n  12:00 AM: 0.85 U/hr\n  6:00 AM: 1.10 U/hr\n  12:30 PM: 0.95 U/hr\nCarb Ratios:\n  12:00 AM: 10.0 g/U\n  12:00 PM: 12.5 g/U\nInsulin Sensitivity Factors:\n  12:00 AM: 45 mg/dL per U\n  10:00 PM: 56 mg/dL per U\nInsulin Type: Fiasp\nDuration of Insulin Action (DIA): 6.0 hours\n\nRECENT GLUCOSE STATISTICS (14 Days):\n  Average Glucose: 148 mg/dL\n  Time in Range (70-180): 72.5%\n  Time in Tight Range (70-140): 45.1%\n  Time Below Range (<70): 2.5%\n  Time Above Range (>180): 25.0%\n  GMI (est. A1C): 6.9%\n  Coefficient of Variation: 28.7%\n  Standard Deviation: 42.6 mg/dL\n\nINSULIN STATISTICS:\n  Total Daily Insulin (TDI): 36.4 U/day\n  TDI Range: 30.2–44.9 U/day\n  TDI Variability (CV): 12%\n  TDI Week-over-Week: -4%\n  Basal %: 39%\n  Bolus %: 61%\n  Correction Boluses: 42\n  TDI-Derived ISF (Rule of 1800): 49 mg/dL per U\n  TDI-Derived CR (Rule of 500): 14 g/U\n\nCARB STATISTICS:\n  Average Daily Carbs: 156 g/day\n  Average Carbs Per Meal: 53 g\n  Total Meals Logged: 41\n\nHOURLY GLUCOSE AVERAGES:\n  00:00 — 140 mg/dL\n  01:00 — 150 mg/dL\n  02:00 — 160 mg/dL\n  04:00 — 170 mg/dL\n');
      text.should.not.containEql('03:00');
      text.should.endWith('  22:00 — 110 mg/dL\n  23:00 — 100 mg/dL');
      text.should.not.containEql('BIOMETRIC DATA');
    });

    it('omits derived ISF/CR and Week-over-Week when unavailable, and appends biometrics when given', function () {
      const agg = fixtureAgg();
      agg.insulin = Object.assign({}, agg.insulin, { tddAvg: 0, tddWeekOverWeekPct: null });
      const text = trends.buildTherapyContext(agg, { biometricContext: '  Resting HR: 58 bpm\n  Avg Daily Steps: 8200\n' });
      text.should.not.containEql('TDI-Derived');
      text.should.not.containEql('Week-over-Week');
      text.should.containEql('  Correction Boluses: 42\n\nCARB STATISTICS:');
      text.should.endWith('  23:00 — 100 mg/dL\n\nBIOMETRIC DATA:\n  Resting HR: 58 bpm\n  Avg Daily Steps: 8200');
    });

    it('falls back when there is no data', function () {
      trends.buildTherapyContext(null).should.equal('No therapy data currently available.');
      const agg = fixtureAgg();
      agg.glucose = Object.assign({}, agg.glucose, { count: 0 });
      trends.buildTherapyContext(agg).should.equal('No therapy data currently available.');
    });
  });

  describe('chat', function () {
    it('renders the system prompt with personality, unit context and data', function () {
      const text = chat.systemPrompt({ personality: 'tough_love', context: 'CURRENT GLUCOSE (REAL-TIME):\n  Latest Reading: 132 mg/dL (3 min ago)' });
      text.should.startWith('You\'re a diabetes-savvy friend who can see this person\'s actual Loop data. They know how diabetes works — skip the textbook stuff.\n\n' + units.PERSONALITIES.tough_love + '\n\nRULES:\n- You are talking directly TO them. Address them as "you"/"your" — never "the user",   "this user", "this person", or any other third-person reference.\n');
      text.should.containEql('- NEVER give unsolicited praise, encouragement, or reassurance. No "Great job!",   "You\'re doing well!", "Keep it up!" or similar. Just answer the question.   If they ask how they\'re doing, then evaluate honestly. Otherwise, skip it entirely.\n' + MGDL_UNIT_CONTEXT + '\n\nDATA:\nCURRENT GLUCOSE (REAL-TIME):\n  Latest Reading: 132 mg/dL (3 min ago)');
      text.should.endWith('  Latest Reading: 132 mg/dL (3 min ago)');
      text.should.not.containEql('{{');
      text.should.not.containEql('{context}');
      chat.systemPrompt({}).should.endWith('DATA:\nNo therapy data currently available.');
    });

    it('keeps $ sequences in the data block intact', function () {
      chat.systemPrompt({ context: 'cost $& and $1' }).should.endWith('DATA:\ncost $& and $1');
    });

    it('renders the message alone without history', function () {
      chat.userPrompt({ message: 'Why am I high overnight?' }).should.equal('Why am I high overnight?');
      chat.userPrompt({ message: 'Why am I high overnight?', history: [] }).should.equal('Why am I high overnight?');
    });

    it('prepends the conversation history', function () {
      const text = chat.userPrompt({
        message: 'And my ISF?'
        , history: [
          { role: 'user', content: 'Why am I high overnight?' }
          , { role: 'assistant', content: 'Your overnight avg is 162 mg/dL.' }
        ]
      });
      text.should.equal('CONVERSATION HISTORY:\nUser: Why am I high overnight?\n\nAssistant: Your overnight avg is 162 mg/dL.\n\nUser: And my ISF?');
    });

    it('keeps only the last 10 history messages', function () {
      const history = [];
      for (let i = 0; i < 14; i++) {
        history.push({ role: i % 2 ? 'assistant' : 'user', content: 'msg' + i });
      }
      const text = chat.userPrompt({ message: 'latest', history: history });
      text.should.startWith('CONVERSATION HISTORY:\nUser: msg4\n\nAssistant: msg5\n\n');
      text.should.endWith('\n\nAssistant: msg13\n\nUser: latest');
      text.should.not.containEql('msg3');
      text.match(/\n\n/g).length.should.equal(10);
    });
  });

  describe('meal', function () {
    it('advice prompts', function () {
      meal.advice.system().should.equal('You are a diabetes meal advisor. Be concise and practical. You are speaking directly to the person eating: address them as "you"/"your", never "the user" or any third-person reference.\n' + MGDL_UNIT_CONTEXT);
      meal.advice.user({ foodType: 'pizza', avgCarbs: 62.4, peakRise: 78.6, timeToPeakMin: 95, post2h: 188, post4h: 141 }).should.equal([
        'Based on my glucose response pattern for pizza:'
        , '- Average carbs: 62g per meal'
        , '- Peak glucose rise: 79 mg/dL'
        , '- Time to peak: 95 minutes'
        , '- 2h post-meal average: 188 mg/dL'
        , '- 4h post-meal average: 141 mg/dL'
        , ''
        , 'Give me brief, practical advice for managing this food. Include: timing of pre-bolus, any carb ratio considerations, and alternative strategies. Keep it under 4 sentences.'
      ].join('\n'));
    });

    it('pre-meal prompts with conditionals', function () {
      meal.preMeal.system().should.equal('You are a diabetes pre-meal advisor. Give brief, actionable advice based on this person\'s own history. Keep it under 3 sentences. You are speaking directly to them: address them as "you"/"your", never "the user" or any third-person reference.');

      const full = meal.preMeal.user({
        foodType: 'sushi'
        , mealCount: 5
        , avgCarbs: 68
        , avgPeakRise: 54
        , avgTimeToPeakMin: 80
        , debriefs: [
          { effectiveCarbs: 75, learnings: ['Pre-bolus 20 min', 'Rice absorbs slowly'] }
          , { effectiveCarbs: null, learnings: ['Watch for a late rise'] }
        ]
      });
      full.should.equal([
        'I\'m about to eat sushi.'
        , 'My personal history with this food (5 meals):'
        , '- Average carbs: 68g'
        , '- Average peak glucose rise: +54 mg/dL'
        , '- Average time to peak: 80 min'
        , ''
        , 'Recent meal debriefs for this food:'
        , '- Effective carbs: ~75g'
        , '- Pre-bolus 20 min'
        , '- Rice absorbs slowly'
        , '- Watch for a late rise'
        , ''
        , 'What should I consider for bolusing this time? Be specific about timing and approach.'
      ].join('\n'));

      const minimal = meal.preMeal.user({ foodType: 'sushi', mealCount: 2, avgCarbs: 68, avgPeakRise: 0, avgTimeToPeakMin: 80, debriefs: [] });
      minimal.should.equal('I\'m about to eat sushi.\nMy personal history with this food (2 meals):\n- Average carbs: 68g\n- Average time to peak: 80 min\n\nWhat should I consider for bolusing this time? Be specific about timing and approach.');
      minimal.should.not.containEql('peak glucose rise');
      minimal.should.not.containEql('Recent meal debriefs');
    });

    it('pre-meal local and enriched summaries', function () {
      meal.localPreMealSummary({ foodType: 'sushi', mealCount: 5, avgCarbs: 68.2, avgAbsorptionHours: 3.25, lastDate: 'Mar 3' })
        .should.equal('You\'ve had sushi 5 times. Avg carbs: 68g. Avg absorption: 3.3h. Last: Mar 3.');
      meal.enrichedPreMealSummary({ foodType: 'sushi', mealCount: 5, avgPeakRise: 54.4, avgTimeToPeakMin: 80, avgCarbs: 68 })
        .should.equal('You\'ve had sushi 5 times. Avg peak: +54 mg/dL in 80 min. Avg carbs: 68g.');
    });

    it('debrief prompts with all optional data', function () {
      meal.debrief.system().should.equal('You are a diabetes meal analysis assistant. Analyze predicted vs actual glucose response. Be concise and practical. You are speaking directly to the person who ate the meal: address them as "you"/"your", never "the user" or any third-person reference.');

      const text = meal.debrief.user({
        name: 'Pepperoni pizza'
        , carbsEntered: 45
        , aiSuggested: { grams: 52, confidence: 78 }
        , nutrition: { fat: 22, protein: 18, fiber: 3, cal: 640 }
        , absorptionHours: 4
        , preMealGlucose: 112
        , predicted: [{ min: 0, value: 112 }, { min: 30, value: 128 }, { min: 60, value: 141 }]
        , actual: [{ min: 0, value: 112 }, { min: 30, value: 135 }, { min: 60, value: 170 }]
        , history: { foodType: 'pizza', mealCount: 7, avgPeakRise: 72, avgTimeToPeakMin: 110 }
        , correctionPatterns: ['AI under-estimates pizza by ~8g (15%) across 5 meals']
      });
      text.should.equal([
        'Meal: Pepperoni pizza, 45g carbs entered (AI suggested 52g, 78% confidence)'
        , 'Nutrition: 22g fat, 18g protein, 3g fiber, 640 cal'
        , 'Absorption time: 4.0h'
        , 'Pre-meal glucose: 112 mg/dL'
        , ''
        , 'Predicted glucose (from Loop at meal time):'
        , '  0min: 112'
        , '  30min: 128'
        , '  60min: 141'
        , ''
        , 'Actual glucose:'
        , '  0min: 112'
        , '  30min: 135'
        , '  60min: 170'
        , ''
        , 'Historical pattern for pizza (7 meals): avg peak +72 mg/dL in 110 min'
        , ''
        , 'Known correction patterns for this meal context:'
        , '  • AI under-estimates pizza by ~8g (15%) across 5 meals'
        , ''
        , 'Analyze: What happened vs what was predicted? What did the carbs effectively behave like? What should be learned for next time? Keep it under 5 sentences.'
        , ''
        , 'IMPORTANT: End your response with a line starting with \'LEARNINGS:\' followed by 2-3 short bullet points (one per line, each starting with \'- \'). These will be shown as takeaways.'
      ].join('\n'));
    });

    it('debrief prompt omits null data', function () {
      const text = meal.debrief.user({
        name: 'Toast'
        , carbsEntered: 30
        , aiSuggested: null
        , nutrition: null
        , absorptionHours: null
        , preMealGlucose: 98
        , predicted: [{ min: 0, value: 98 }]
        , actual: [{ min: 0, value: 98 }]
        , history: null
        , correctionPatterns: []
      });
      text.should.startWith('Meal: Toast, 30g carbs entered\nPre-meal glucose: 98 mg/dL\n\nPredicted glucose (from Loop at meal time):\n  0min: 98\n\nActual glucose:\n  0min: 98\n\nAnalyze: What happened');
      text.should.not.containEql('AI suggested');
      text.should.not.containEql('Nutrition:');
      text.should.not.containEql('Absorption time');
      text.should.not.containEql('Historical pattern');
      text.should.not.containEql('Known correction patterns');
    });
  });
});
