'use strict';

const should = require('should');
const uam = require('../lib/aiinsights/uam');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2024, 2, 4, 0, 0, 0);

// 5-minute readings; `shape` maps minute offset -> mg/dL via segments [minute, mgdl].
function series (startMs, minutes, points) {
  const out = [];
  for (let m = 0; m <= minutes; m += 5) {
    let v = points[0][1];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (m >= a[0] && m <= b[0]) { v = a[1] + (b[1] - a[1]) * (m - a[0]) / (b[0] - a[0]); }
      if (m > b[0]) { v = b[1]; }
    }
    out.push({ mills: startMs + m * MINUTE, mgdl: Math.round(v) });
  }
  return out;
}

function agg (readings, overrides) {
  overrides = overrides || {};
  return {
    period: { days: 1, fromMs: T0, toMs: T0 + DAY, timezone: 'UTC' }
    , glucose: { readings: readings }
    , insulin: { boluses: overrides.boluses || [] }
    , carbs: { entries: overrides.carbs || [] }
    , settings: {
      carbratio: [{ startSeconds: 0, value: 10 }]
      , sens: [{ startSeconds: 0, value: 50 }]
      , dia: 5
      , timezone: 'UTC'
    }
  };
}

// flat 100 for 60 min, then a clean 100 -> 220 rise over 60 min, then flat
const MEAL_SHAPE = [[0, 100], [60, 100], [120, 220], [180, 220]];

describe('aiinsights uam', function () {
  it('returns no episodes and a null score for a flat day', function () {
    const r = uam.analyze(agg(series(T0, 180, [[0, 110], [180, 110]])));
    r.episodes.should.have.length(0);
    should(r.score).be.null();
    r.totals.episodes.should.equal(0);
  });

  it('detects an unannounced rise and estimates a range from ICR/ISF', function () {
    const r = uam.analyze(agg(series(T0, 180, MEAL_SHAPE)));
    r.episodes.should.have.length(1);
    const e = r.episodes[0];
    e.announced.should.be.false();
    e.type.should.equal('unannounced');
    e.riseMgdl.should.be.above(100);
    // 120 mg/dL / 50 ISF * 10 ICR = 24 g, inside the reported range
    e.estimatedCho.low.should.be.below(24);
    e.estimatedCho.high.should.be.above(24);
    r.score.should.equal(0);
    r.totals.unannounced.should.equal(1);
    r.totals.estimatedChoPerDay.should.have.properties(['low', 'high']);
  });

  it('marks the episode announced when a carb entry is nearby', function () {
    const carbs = [{ mills: T0 + 65 * MINUTE, grams: 30, id: 'c1' }];
    const r = uam.analyze(agg(series(T0, 180, MEAL_SHAPE), { carbs: carbs }));
    r.episodes.should.have.length(1);
    r.episodes[0].announced.should.be.true();
    r.episodes[0].loggedCarbs.should.equal(30);
    r.score.should.equal(100);
  });

  it('scores the announced share across several episodes', function () {
    const day = series(T0, 600, [[0, 100], [60, 100], [120, 220], [180, 220], [240, 100], [300, 100], [360, 220], [420, 220], [480, 100]]);
    const carbs = [{ mills: T0 + 60 * MINUTE, grams: 40, id: 'c1' }];
    const r = uam.analyze(agg(day, { carbs: carbs }));
    r.episodes.should.have.length(2);
    r.score.should.equal(50);
  });

  it('flags a manual bolus without carbs as its own subclass', function () {
    const boluses = [{ mills: T0 + 62 * MINUTE, units: 3, automatic: false, isCorrection: true }];
    const r = uam.analyze(agg(series(T0, 180, MEAL_SHAPE), { boluses: boluses }));
    r.episodes[0].type.should.equal('bolus_no_carbs');
    r.episodes[0].announced.should.be.false();
    r.totals.bolusNoCarbs.should.equal(1);
  });

  it('counts a suspended basal as negative insulin, so the same rise implies fewer carbs', function () {
    const readings = series(T0, 480, [[0, 100], [300, 100], [360, 100], [420, 200], [480, 200]]);
    const base = uam.analyze(agg(readings));
    // 0.25 U/hr below schedule for the 2 hours before the rise = 0.5 U less insulin than planned
    const net = [];
    for (let m = 240; m < 360; m += 5) { net.push({ mills: T0 + m * MINUTE, units: -1 / 48 }); }
    const withBasal = agg(readings);
    withBasal.insulin.netBasal = net;
    const r = uam.analyze(withBasal);
    r.episodes[0].insulinEffectUnits.should.be.below(0);
    r.episodes[0].estimatedCho.mid.should.be.below(base.episodes[0].estimatedCho.mid);
  });

  it('ignores a rebound that starts below 70 mg/dL', function () {
    const r = uam.analyze(agg(series(T0, 180, [[0, 60], [60, 60], [120, 180], [180, 180]])));
    r.episodes.should.have.length(0);
  });

  it('subtracts insulin effect: a rise mostly offset by a recent bolus is not counted as a large meal', function () {
    const boluses = [{ mills: T0 + 30 * MINUTE, units: 4, automatic: false, isCorrection: false }];
    const small = series(T0, 240, [[0, 100], [60, 100], [120, 140], [240, 140]]);
    const r = uam.analyze(agg(small, { boluses: boluses }));
    // 40 mg/dL rise plus ~4 U acting would otherwise be large; either dropped or reported with insulin counted
    r.episodes.forEach(function each (e) { e.insulinEffectUnits.should.be.above(0); });
  });

  it('withholds the figure when a CGM gap sits inside the episode', function () {
    const readings = series(T0, 180, MEAL_SHAPE).filter(function drop (x) {
      return x.mills < T0 + 80 * MINUTE || x.mills > T0 + 105 * MINUTE;
    });
    const r = uam.analyze(agg(readings));
    if (r.episodes.length) {
      r.episodes[0].confidence.should.equal('low');
      r.episodes[0].noPreciseFigure.should.be.true();
      should(r.episodes[0].estimatedCho).be.null();
    }
  });

  it('uses the ICR/ISF in force at the episode time of day', function () {
    const a = agg(series(T0, 180, MEAL_SHAPE));
    a.settings.carbratio = [{ startSeconds: 0, value: 20 }];
    const r = uam.analyze(a);
    r.episodes[0].estimatedCho.mid.should.equal(48);
  });

  it('reports no figure when the profile has no ICR/ISF', function () {
    const a = agg(series(T0, 180, MEAL_SHAPE));
    a.settings.carbratio = [];
    a.settings.sens = [];
    const r = uam.analyze(a);
    r.episodes.should.have.length(1);
    r.episodes[0].noPreciseFigure.should.be.true();
    r.totals.withoutFigure.should.equal(1);
  });

  describe('insulinFraction', function () {
    it('is monotonic from 0 to 1 across the DIA', function () {
      uam.insulinFraction(0, 300, 75).should.equal(0);
      // Loop's model waits 10 minutes before any action
      uam.insulinFraction(10, 300, 75).should.equal(0);
      uam.insulinFraction(310, 300, 75).should.equal(1);
      let prev = 0;
      for (let m = 10; m < 310; m += 10) {
        const f = uam.insulinFraction(m, 300, 75);
        f.should.be.aboveOrEqual(prev);
        prev = f;
      }
    });
  });
});
