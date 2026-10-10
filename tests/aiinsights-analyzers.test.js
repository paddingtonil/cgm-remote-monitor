'use strict';

const should = require('should');
const analyzers = require('../lib/aiinsights/analyzers');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2024, 2, 4, 0, 0, 0);

function hourly (means) {
  return means.map(function toHour (m, hour) {
    return { hour: hour, mean: m, count: m === null ? 0 : 12 };
  });
}

function flatHours (value) {
  return new Array(24).fill(value);
}

// Minimal AggregatedData with a flat 120 mg/dL profile and clean stats.
function cleanAgg (overrides) {
  const glucose = Object.assign({
    count: 2016
    , mean: 120
    , sd: 30
    , cv: 25
    , veryHighPct: 0
    , highPct: 5
    , inRangePct: 95
    , lowPct: 0
    , veryLowPct: 0
    , tirPct: 95
    , titrPct: 70
    , tbrPct: 0
    , tarPct: 5
    , gmi: 6.18
    , hourly: hourly(flatHours(120))
    , hourlyByDay: {}
    , readings: []
  }, overrides && overrides.glucose || {});
  return {
    period: { days: 7, fromMs: T0, toMs: T0 + 7 * DAY, timezone: 'UTC' }
    , glucose: glucose
    , insulin: Object.assign({
      boluses: []
      , suspensions: { events: 0, totalMinutes: 0, pctOfPeriod: 0, subBasalMinutes: 0, overcorrectionEvents: 0, byHour: [] }
    }, overrides && overrides.insulin || {})
    , carbs: Object.assign({ dailyAvg: 0, entryCount: 0, perMealAvg: null, byHour: [], entries: [] }, overrides && overrides.carbs || {})
    , settings: {}
    , tightRangeUpperBound: 140
    , devicestatus: []
  };
}

function patternIds (agg) {
  return analyzers.detectPatterns(agg).map(function id (p) { return p.id + ':' + p.severity; });
}

describe('aiinsights analyzers', function () {

  describe('detectPatterns', function () {
    it('returns [] for a clean dataset', function () {
      analyzers.detectPatterns(cleanAgg()).should.eql([]);
    });

    it('overnight lows at both thresholds', function () {
      // hour 7 is kept close to hour 3 so the dawn pattern stays quiet
      const means = flatHours(120);
      for (let h = 0; h < 6; h++) { means[h] = 75; }
      means[7] = 90;
      patternIds(cleanAgg({ glucose: { hourly: hourly(means) } })).should.eql(['overnight_lows:medium']);
      for (let h = 0; h < 6; h++) { means[h] = 65; }
      means[7] = 80;
      patternIds(cleanAgg({ glucose: { hourly: hourly(means) } })).should.eql(['overnight_lows:high']);
    });

    it('frequent lows at both thresholds', function () {
      patternIds(cleanAgg({ glucose: { tbrPct: 5 } })).should.eql(['frequent_lows:medium']);
      patternIds(cleanAgg({ glucose: { tbrPct: 9 } })).should.eql(['frequent_lows:high']);
    });

    it('overnight highs at both thresholds', function () {
      const means = flatHours(120);
      for (let h = 0; h < 6; h++) { means[h] = 190; }
      patternIds(cleanAgg({ glucose: { hourly: hourly(means) } })).should.eql(['overnight_highs:medium']);
      for (let h = 0; h < 6; h++) { means[h] = 210; }
      patternIds(cleanAgg({ glucose: { hourly: hourly(means) } })).should.eql(['overnight_highs:high']);
    });

    it('dawn phenomenon at both thresholds, falling back to hours 4 and 6', function () {
      let means = flatHours(120);
      means[3] = 100; means[7] = 125;
      patternIds(cleanAgg({ glucose: { hourly: hourly(means) } })).should.eql(['dawn_phenomenon:medium']);
      means[7] = 145;
      patternIds(cleanAgg({ glucose: { hourly: hourly(means) } })).should.eql(['dawn_phenomenon:high']);
      means = flatHours(120);
      means[3] = null; means[7] = null; means[4] = 100; means[6] = 165;
      patternIds(cleanAgg({ glucose: { hourly: hourly(means) } })).should.eql(['dawn_phenomenon:high']);
    });

    it('post-meal spikes need 2 of 3 windows for medium and 3 for high', function () {
      const means = flatHours(120);
      means[6] = 100; means[8] = 160;
      means[11] = 100; means[13] = 160;
      patternIds(cleanAgg({ glucose: { hourly: hourly(means) } })).should.eql(['post_meal_spikes:medium']);
      means[17] = 100; means[19] = 160;
      patternIds(cleanAgg({ glucose: { hourly: hourly(means) } })).should.eql(['post_meal_spikes:high']);
    });

    it('high variability at both thresholds', function () {
      patternIds(cleanAgg({ glucose: { cv: 40 } })).should.eql(['high_variability:medium']);
      patternIds(cleanAgg({ glucose: { cv: 50 } })).should.eql(['high_variability:high']);
    });

    it('consistent highs at both thresholds', function () {
      patternIds(cleanAgg({ glucose: { tarPct: 30 } })).should.eql(['consistent_highs:medium']);
      patternIds(cleanAgg({ glucose: { tarPct: 45 } })).should.eql(['consistent_highs:high']);
    });

    it('consistent lows at both thresholds', function () {
      patternIds(cleanAgg({ glucose: { mean: 95, tbrPct: 3 } })).should.eql(['consistent_lows:medium']);
      patternIds(cleanAgg({ glucose: { mean: 85, tbrPct: 3 } })).should.eql(['consistent_lows:high']);
      patternIds(cleanAgg({ glucose: { mean: 95, tbrPct: 1 } })).should.eql([]);
    });

    it('carries title and description on each pattern', function () {
      const patterns = analyzers.detectPatterns(cleanAgg({ glucose: { cv: 50 } }));
      patterns[0].should.have.keys('id', 'title', 'severity', 'description');
      patterns[0].title.should.equal('High Variability');
      patterns[0].description.should.match(/50/);
    });
  });

  describe('settingsScore', function () {
    function score (g) { return analyzers.settingsScore(cleanAgg({ glucose: g })); }

    it('awards TIR points per the spec bands', function () {
      score({ inRangePct: 90 }).components.tir.should.equal(40);
      score({ inRangePct: 80 }).components.tir.should.equal(30);
      score({ inRangePct: 70 }).components.tir.should.equal(20);
      score({ inRangePct: 60 }).components.tir.should.equal(8);
      score({ inRangePct: 40 }).components.tir.should.equal(0);
    });

    it('awards TBR points per the spec bands', function () {
      score({ tbrPct: 0.5 }).components.tbr.should.equal(25);
      score({ tbrPct: 2 }).components.tbr.should.equal(20);
      score({ tbrPct: 6 }).components.tbr.should.equal(10);
      score({ tbrPct: 8 }).components.tbr.should.equal(0);
    });

    it('awards CV and GMI points per the spec bands', function () {
      score({ cv: 29 }).components.cv.should.equal(20);
      score({ cv: 30 }).components.cv.should.equal(15);
      score({ cv: 40 }).components.cv.should.equal(8);
      score({ cv: 45 }).components.cv.should.equal(0);
      score({ gmi: 6.4 }).components.gmi.should.equal(15);
      score({ gmi: 6.9 }).components.gmi.should.equal(12);
      score({ gmi: 7.4 }).components.gmi.should.equal(8);
      score({ gmi: 7.9 }).components.gmi.should.equal(4);
      score({ gmi: 8.0 }).components.gmi.should.equal(0);
    });

    it('rounds the total, assigns grades and the optimal flag', function () {
      const a = score({ inRangePct: 95, tbrPct: 0.5, cv: 25, gmi: 6.1 });
      a.total.should.equal(100);
      a.grade.should.equal('A');
      a.settingsAlreadyOptimal.should.be.true();

      const b = score({ inRangePct: 80, tbrPct: 2, cv: 33, gmi: 6.9 });
      b.total.should.equal(77);
      b.grade.should.equal('C');
      b.settingsAlreadyOptimal.should.be.false();

      score({ inRangePct: 86, tbrPct: 3.9, cv: 40, gmi: 7.2 }).settingsAlreadyOptimal.should.be.true();
      score({ inRangePct: 86, tbrPct: 4, cv: 40, gmi: 7.2 }).settingsAlreadyOptimal.should.be.false();
      score({ inRangePct: 72, tbrPct: 6, cv: 44, gmi: 7.9 }).grade.should.equal('F');
      score({ inRangePct: 80, tbrPct: 3, cv: 33, gmi: 6.8 }).grade.should.equal('C');
      score({ inRangePct: 85, tbrPct: 3, cv: 29, gmi: 6.8 }).grade.should.equal('B');
      score({ inRangePct: 75, tbrPct: 5, cv: 33, gmi: 7.2 }).grade.should.equal('D');
    });
  });

  describe('circadianProfile', function () {
    it('detects dawn rise and computes the sleep-related averages', function () {
      const means = flatHours(120);
      means[21] = 140;                        // pre-sleep hour (bed 22)
      means[22] = 130; means[23] = 125;
      for (let h = 0; h < 4; h++) { means[h] = 100; }
      means[4] = 100; means[5] = 110; means[6] = 120;   // 3h before wake avg 110
      means[7] = 135;                         // wake → rise 25 > 15
      means[9] = 160;                         // wake + 2h
      const c = analyzers.circadianProfile(cleanAgg({ glucose: { hourly: hourly(means) } }));
      c.bedHour.should.equal(22);
      c.wakeHour.should.equal(7);
      c.preSleepAvg.should.equal(140);
      c.wakeGlucose.should.equal(135);
      c.dawnRise.should.be.approximately(25, 0.001);
      c.dawnDetected.should.be.true();
      c.riseAfterWake2h.should.equal(25);
      // overnight = hours 22,23,0,1,2,3,4,5,6
      c.overnightAvg.should.be.approximately((130 + 125 + 100 * 5 + 110 + 120) / 9, 0.001);
    });

    it('does not flag dawn under 15 and honours custom hours', function () {
      const means = flatHours(120);
      means[8] = 130;
      const c = analyzers.circadianProfile(cleanAgg({ glucose: { hourly: hourly(means) } }), { bedHour: 23, wakeHour: 8 });
      c.dawnRise.should.equal(10);
      c.dawnDetected.should.be.false();
      c.preSleepAvg.should.equal(120);
    });
  });

  describe('negativeBasal', function () {
    it('flags high suspension rate and overcorrection, ranks heaviest hours', function () {
      const byHour = [];
      for (let h = 0; h < 24; h++) { byHour.push({ hour: h, minutes: 0 }); }
      byHour[2].minutes = 120; byHour[3].minutes = 60; byHour[14].minutes = 90; byHour[20].minutes = 10;
      const agg = cleanAgg({ insulin: { suspensions: {
        events: 9, totalMinutes: 280, pctOfPeriod: 12.5, subBasalMinutes: 300, overcorrectionEvents: 4, byHour: byHour
      } } });
      const nb = analyzers.negativeBasal(agg);
      nb.highSuspensionRate.should.be.true();
      nb.overcorrectionPattern.should.be.true();
      nb.heaviestHours.should.eql([{ hour: 2, minutes: 120 }, { hour: 14, minutes: 90 }, { hour: 3, minutes: 60 }]);
      nb.events.should.equal(9);
    });

    it('is quiet below thresholds', function () {
      const nb = analyzers.negativeBasal(cleanAgg());
      nb.highSuspensionRate.should.be.false();
      nb.overcorrectionPattern.should.be.false();
      nb.heaviestHours.should.eql([]);
    });
  });

  describe('cgmSignalQuality', function () {
    it('finds gaps longer than 10 minutes and estimates missed readings', function () {
      const readings = [];
      let t = T0;
      for (let i = 0; i < 10; i++) { readings.push({ mills: t, mgdl: 100 }); t += 5 * MINUTE; }
      t += 30 * MINUTE;                       // 35 min gap → 6 missed readings
      for (let i = 0; i < 10; i++) { readings.push({ mills: t, mgdl: 100 }); t += 5 * MINUTE; }
      t += 10 * MINUTE;                       // 15 min gap → 2 missed readings
      readings.push({ mills: t, mgdl: 100 });
      const agg = cleanAgg({ glucose: { readings: readings } });
      agg.period = { days: 1, fromMs: T0, toMs: T0 + DAY, timezone: 'UTC' };
      const q = analyzers.cgmSignalQuality(agg);
      q.gaps.should.equal(2);
      q.longestGapMin.should.equal(35);
      q.avgGapMin.should.equal(25);
      q.estimatedReadings.should.equal(8);
      q.coveragePct.should.be.approximately(21 / 288 * 100, 0.001);
      q.recentGaps.should.have.length(2);
      q.recentGaps[0].should.eql({ startMills: T0 + 45 * MINUTE, minutes: 35, estimatedReadings: 6 });
    });

    it('caps coverage at 100 and reports zero gaps for dense data', function () {
      const readings = [];
      for (let i = 0; i < 300; i++) { readings.push({ mills: T0 + i * 4 * MINUTE, mgdl: 100 }); }
      const agg = cleanAgg({ glucose: { readings: readings } });
      agg.period = { days: 1, fromMs: T0, toMs: T0 + DAY, timezone: 'UTC' };
      const q = analyzers.cgmSignalQuality(agg);
      q.gaps.should.equal(0);
      q.coveragePct.should.equal(100);
      q.recentGaps.should.eql([]);
    });
  });

  describe('foodResponsePatterns', function () {
    // readings: baseline 100, then a spike after each meal, peak at +60 min
    function mealReadings (mealMills, peakRise) {
      const out = [];
      for (let m = -30; m <= 240; m += 5) {
        let v = 100;
        if (m > 0 && m <= 60) { v = 100 + peakRise * m / 60; }
        else if (m > 60 && m <= 180) { v = 100 + peakRise * (180 - m) / 120; }
        out.push({ mills: mealMills + m * MINUTE, mgdl: v });
      }
      return out;
    }

    it('groups by food type, needs two meals, sorts by peak rise and flags high impact', function () {
      const meals = [
        { mills: T0 + 8 * HOUR, grams: 60, foodType: 'Pizza', id: 'p1' }
        , { mills: T0 + DAY + 8 * HOUR, grams: 80, foodType: 'Pizza', id: 'p2' }
        , { mills: T0 + 2 * DAY + 8 * HOUR, grams: 30, foodType: 'Salad', id: 's1' }
        , { mills: T0 + 3 * DAY + 8 * HOUR, grams: 30, foodType: 'Salad', id: 's2' }
        , { mills: T0 + 4 * DAY + 8 * HOUR, grams: 30, foodType: 'Once', id: 'o1' }
        , { mills: T0 + 5 * DAY + 8 * HOUR, grams: 30, foodType: null, id: 'n1' }
      ];
      const rises = { p1: 90, p2: 70, s1: 30, s2: 20, o1: 100, n1: 100 };
      let readings = [];
      meals.forEach(function each (m) { readings = readings.concat(mealReadings(m.mills, rises[m.id])); });
      const agg = cleanAgg({ glucose: { readings: readings }, carbs: { entries: meals } });

      const out = analyzers.foodResponsePatterns(agg);
      out.should.have.length(2);
      out[0].foodType.should.equal('Pizza');
      out[0].mealCount.should.equal(2);
      out[0].avgCarbs.should.equal(70);
      out[0].peakRise.should.be.approximately(80, 0.001);
      out[0].timeToPeakMin.should.equal(60);
      out[0].highImpact.should.be.true();
      out[0].auc.should.be.greaterThan(0);
      // 2h post (1.5-2.5h) sits on the falling edge, 4h post is back at baseline
      out[0].post2h.should.be.greaterThan(100);
      out[0].post4h.should.be.approximately(100, 0.001);
      out[1].foodType.should.equal('Salad');
      out[1].peakRise.should.be.approximately(25, 0.001);
      out[1].highImpact.should.be.false();
    });

    it('skips meals without enough post-meal readings', function () {
      const meals = [
        { mills: T0 + 8 * HOUR, grams: 60, foodType: 'Pizza', id: 'p1' }
        , { mills: T0 + DAY + 8 * HOUR, grams: 80, foodType: 'Pizza', id: 'p2' }
      ];
      const readings = [
        { mills: T0 + 8 * HOUR - 10 * MINUTE, mgdl: 100 }
        , { mills: T0 + 8 * HOUR + 5 * MINUTE, mgdl: 110 }
        , { mills: T0 + 8 * HOUR + 10 * MINUTE, mgdl: 120 }
      ].concat(mealReadings(T0 + DAY + 8 * HOUR, 50));
      analyzers.foodResponsePatterns(cleanAgg({ glucose: { readings: readings }, carbs: { entries: meals } })).should.eql([]);
    });
  });

  describe('mealEvents', function () {
    it('matches boluses in the -5..+15 min window and computes effective CR', function () {
      const mealMills = T0 + 12 * HOUR;
      const readings = [
        { mills: mealMills - 20 * MINUTE, mgdl: 95 }
        , { mills: mealMills - 5 * MINUTE, mgdl: 100 }
        , { mills: mealMills + 30 * MINUTE, mgdl: 140 }
        , { mills: mealMills + 4 * HOUR, mgdl: 110 }
        , { mills: mealMills + 4 * HOUR + 5 * MINUTE, mgdl: 105 }   // outside 4h
      ];
      const boluses = [
        { mills: mealMills - 10 * MINUTE, units: 9, isCorrection: true, automatic: false }   // too early
        , { mills: mealMills - 2 * MINUTE, units: 4, isCorrection: false, automatic: false }
        , { mills: mealMills + 10 * MINUTE, units: 1, isCorrection: false, automatic: true }
        , { mills: mealMills + 20 * MINUTE, units: 9, isCorrection: true, automatic: true }  // too late
      ];
      const meals = [
        { mills: mealMills - 2 * DAY, grams: 20, foodType: null, id: 'old' }
        , { mills: mealMills, grams: 50, foodType: 'Pasta', id: 'm1' }
      ];
      const agg = cleanAgg({ glucose: { readings: readings }, carbs: { entries: meals }, insulin: { boluses: boluses } });

      const events = analyzers.mealEvents(agg, { limit: 1 });
      events.should.have.length(1);
      const ev = events[0];
      ev.id.should.equal('m1');
      ev.grams.should.equal(50);
      ev.foodType.should.equal('Pasta');
      ev.glucose.should.eql([
        { minutesAfter: -5, mgdl: 100 }
        , { minutesAfter: 30, mgdl: 140 }
        , { minutesAfter: 240, mgdl: 110 }
      ]);
      ev.bolus.should.eql({ totalUnits: 5, manualUnits: 4, automaticUnits: 1, largestMills: mealMills - 2 * MINUTE });
      ev.effectiveCR.should.equal(10);

      const all = analyzers.mealEvents(agg);
      all.should.have.length(2);
      all[0].id.should.equal('old');
      should(all[0].bolus).be.null();
      should(all[0].effectiveCR).be.null();
    });
  });

  describe('caffeineModel', function () {
    it('decays with a 5.7h half-life', function () {
      const entries = [{ mills: T0, mg: 142, source: 'Coffee (med)' }];
      const c = analyzers.caffeineModel(entries, T0 + 5.7 * HOUR, { timezone: 'UTC' });
      c.currentMg.should.be.approximately(71, 0.001);
      c.total24hMg.should.equal(142);
      c.intakeCount.should.equal(1);
      c.lastIntakeMinutesAgo.should.equal(342);
      c.peakTodayMg.should.be.approximately(142, 0.001);
      c.level.should.equal('none');
      c.recent.should.eql([{ mills: T0, mg: 142, source: 'Coffee (med)' }]);
    });

    it('grades moderate and high levels and ignores future entries', function () {
      const now = T0 + 10 * HOUR;
      const moderate = analyzers.caffeineModel([{ mills: now - 30 * MINUTE, mg: 142 }], now);
      moderate.level.should.equal('moderate');
      const high = analyzers.caffeineModel([
        { mills: now - 30 * MINUTE, mg: 190 }
        , { mills: now - 2 * HOUR, mg: 95 }
        , { mills: now + HOUR, mg: 500 }
      ], now);
      high.level.should.equal('high');
      high.intakeCount.should.equal(2);
      high.currentMg.should.be.greaterThan(200);
      const none = analyzers.caffeineModel([], now);
      none.level.should.equal('none');
      none.currentMg.should.equal(0);
      should(none.lastIntakeMinutesAgo).be.null();
    });

    it('exposes the spec presets', function () {
      analyzers.CAFFEINE_PRESETS.should.have.length(8);
      analyzers.CAFFEINE_PRESETS[1].should.eql({ name: 'Coffee (med)', mg: 142 });
      analyzers.ALCOHOL_PRESETS.should.have.length(7);
      analyzers.ALCOHOL_PRESETS[6].should.eql({ name: 'Cocktail', drinks: 2.0 });
    });
  });

  describe('alcoholModel', function () {
    it('clears one drink per hour, independently per intake', function () {
      const now = T0 + 20 * HOUR;
      const entries = [
        { mills: now - 30 * MINUTE, drinks: 2, source: 'Cocktail' }
        , { mills: now - 3 * HOUR, drinks: 1.5, source: 'Beer (Craft/IPA)' }   // cleared
      ];
      const a = analyzers.alcoholModel(entries, now, { timezone: 'UTC' });
      a.currentDrinks.should.be.approximately(1.5, 0.001);
      a.total24hDrinks.should.equal(3.5);
      a.intakeCount.should.equal(2);
      a.lastDrinkMinutesAgo.should.equal(30);
      a.clearanceMills.should.equal(now + 1.5 * HOUR);
      a.riskWindowEndMills.should.equal(now - 30 * MINUTE + DAY);
      a.risk.should.equal('LOW');
      a.recent[0].source.should.equal('Cocktail');
    });

    it('bases risk on max(current, peak today) and escalates in the 8-12h window', function () {
      const now = T0 + 20 * HOUR;
      // three drinks at once 2h ago → peak today 3 → MODERATE
      analyzers.alcoholModel([{ mills: now - 2 * HOUR, drinks: 3 }], now).risk.should.equal('MODERATE');
      // same drinks 10h ago: level 0, but peak today 3 → MODERATE, then +1 in the peak window → HIGH
      analyzers.alcoholModel([{ mills: now - 10 * HOUR, drinks: 3 }], now).risk.should.equal('HIGH');
      // single drink 9h ago: LOW → MODERATE in the peak window
      analyzers.alcoholModel([{ mills: now - 9 * HOUR, drinks: 1 }], now).risk.should.equal('MODERATE');
      // single drink 13h ago: outside the peak window → LOW
      analyzers.alcoholModel([{ mills: now - 13 * HOUR, drinks: 1 }], now).risk.should.equal('LOW');
      // five drinks → HIGH regardless
      analyzers.alcoholModel([{ mills: now - HOUR, drinks: 5 }], now).risk.should.equal('HIGH');
      // nothing in 24h → NONE
      const none = analyzers.alcoholModel([{ mills: now - 30 * HOUR, drinks: 5 }], now);
      none.risk.should.equal('NONE');
      none.currentDrinks.should.equal(0);
      should(none.clearanceMills).be.null();
      should(none.riskWindowEndMills).be.null();
    });
  });

  describe('extractCaffeineEntries / extractAlcoholEntries', function () {
    it('reads the design 5.8 treatment shapes', function () {
      const treatments = [
        { eventType: 'Caffeine', created_at: new Date(T0).toISOString(), caffeineMg: 142, notes: 'Coffee (med)' }
        , { eventType: 'Alcohol', created_at: new Date(T0 + HOUR).toISOString(), drinks: 1.5, notes: 'Beer (Craft/IPA)' }
        , { eventType: 'Caffeine', mills: T0 + 2 * HOUR, caffeineMg: 0 }
        , { eventType: 'Bolus', insulin: 1, created_at: new Date(T0).toISOString() }
      ];
      analyzers.extractCaffeineEntries(treatments).should.eql([{ mills: T0, mg: 142, source: 'Coffee (med)' }]);
      analyzers.extractAlcoholEntries(treatments).should.eql([{ mills: T0 + HOUR, drinks: 1.5, source: 'Beer (Craft/IPA)' }]);
    });
  });
});
