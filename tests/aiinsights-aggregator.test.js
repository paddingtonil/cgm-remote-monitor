'use strict';

const should = require('should');
const moment = require('moment-timezone');

const createAggregator = require('../lib/aiinsights/aggregator');
const integrator = require('../lib/aiinsights/basal-integrator');
const profilefunctions = require('../lib/profilefunctions');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// 2024-03-04T00:00:00Z — a Monday, no DST transitions nearby in Jerusalem or UTC.
const T0 = Date.UTC(2024, 2, 4, 0, 0, 0);

function flatProfile (overrides) {
  const store = Object.assign({
    dia: 5
    , units: 'mg/dl'
    , timezone: 'UTC'
    , basal: [{ time: '00:00', value: 1.0 }]
    , sens: [{ time: '00:00', value: 50 }, { time: '12:00', value: 40 }]
    , carbratio: [{ time: '00:00', value: 10 }]
    , target_low: [{ time: '00:00', value: 90 }]
    , target_high: [{ time: '00:00', value: 120 }]
  }, overrides || {});
  return {
    _id: 'profile1'
    , defaultProfile: 'Default'
    , startDate: '2020-01-01T00:00:00.000Z'
    , store: { Default: store }
  };
}

function makeProfile (profileDoc, tempBasals) {
  const profile = profilefunctions(null, { moment: moment });
  profile.loadData([profileDoc]);
  const temps = (tempBasals || []).map(function withMills (t) {
    return Object.assign({ eventType: 'Temp Basal', mills: Date.parse(t.created_at) }, t);
  });
  profile.updateTreatments([], temps, []);
  return profile;
}

function iso (mills) { return new Date(mills).toISOString(); }

describe('aiinsights aggregator', function () {

  describe('computeGlucoseStats', function () {
    const values = [50, 60, 100, 150, 200, 260];
    const readings = values.map(function toReading (v, i) {
      return { mills: T0 + i * 5 * MINUTE, mgdl: v };
    });

    it('computes mean, population SD, CV and GMI', function () {
      const stats = createAggregator.computeGlucoseStats(readings, 'UTC', 140);
      stats.count.should.equal(6);
      stats.mean.should.be.approximately(136.6667, 0.001);
      // population SD of the values above: sqrt(sum((v - mean)^2) / 6)
      stats.sd.should.be.approximately(75.4247, 0.001);
      stats.cv.should.be.approximately(75.4247 / 136.6667 * 100, 0.001);
      stats.gmi.should.be.approximately(3.31 + 0.02392 * 136.6667, 0.001);
    });

    it('splits the five buckets and TITR / TBR / TAR', function () {
      const stats = createAggregator.computeGlucoseStats(readings, 'UTC', 140);
      stats.veryLowPct.should.be.approximately(100 / 6, 0.001);      // 50
      stats.lowPct.should.be.approximately(100 / 6, 0.001);          // 60
      stats.inRangePct.should.be.approximately(200 / 6, 0.001);      // 100, 150
      stats.highPct.should.be.approximately(100 / 6, 0.001);         // 200
      stats.veryHighPct.should.be.approximately(100 / 6, 0.001);     // 260
      stats.tirPct.should.equal(stats.inRangePct);
      stats.titrPct.should.be.approximately(100 / 6, 0.001);         // only 100 <= 140
      stats.tbrPct.should.be.approximately(200 / 6, 0.001);
      stats.tarPct.should.be.approximately(200 / 6, 0.001);
      stats.readings.should.have.length(6);
    });

    it('buckets hourly by local hour in the requested timezone', function () {
      const utc = createAggregator.computeGlucoseStats(readings, 'UTC', 140);
      const il = createAggregator.computeGlucoseStats(readings, 'Asia/Jerusalem', 140);
      utc.hourly.should.have.length(24);
      utc.hourly[0].count.should.equal(6);
      utc.hourly[0].mean.should.be.approximately(136.6667, 0.001);
      utc.hourly[1].count.should.equal(0);
      should(utc.hourly[1].mean).be.null();
      // 00:00 UTC is 02:00 in Jerusalem in March (UTC+2)
      il.hourly[0].count.should.equal(0);
      il.hourly[2].count.should.equal(6);
      Object.keys(utc.hourlyByDay).should.eql(['2024-03-04']);
      utc.hourlyByDay['2024-03-04'].should.have.length(24);
      should(utc.hourlyByDay['2024-03-04'][5]).be.null();
    });

    it('handles an empty list', function () {
      const stats = createAggregator.computeGlucoseStats([], 'UTC', 140);
      stats.count.should.equal(0);
      should(stats.mean).be.null();
      should(stats.sd).be.null();
      should(stats.gmi).be.null();
      stats.inRangePct.should.equal(0);
      stats.hourly.should.have.length(24);
    });
  });

  describe('dedupeCarbs', function () {
    it('drops a near-duplicate within 5 minutes and <20% difference, keeping the first', function () {
      const entries = [
        { mills: T0, grams: 50, foodType: null, id: 'a' }
        , { mills: T0 + 3 * MINUTE, grams: 45, foodType: null, id: 'b' }   // dup of a
        , { mills: T0 + 4 * MINUTE, grams: 20, foodType: null, id: 'c' }   // 20 vs 50: > 20%, kept
        , { mills: T0 + 30 * MINUTE, grams: 50, foodType: null, id: 'd' }  // far in time, kept
      ];
      const out = createAggregator.dedupeCarbs(entries);
      out.map(function id (e) { return e.id; }).should.eql(['a', 'c', 'd']);
    });
  });

  describe('classifyBoluses', function () {
    const carbEntries = [{ mills: T0 + 2 * HOUR, grams: 40 }];
    const treatments = [
      { _id: '1', eventType: 'Correction Bolus', insulin: 1, carbs: 30, created_at: iso(T0) }
      , { _id: '2', eventType: 'Bolus', insulin: 2, created_at: iso(T0 + HOUR) }
      , { _id: '3', eventType: 'Meal Bolus', insulin: 3, carbs: 40, created_at: iso(T0 + 2 * HOUR) }
      , { _id: '4', eventType: 'Bolus', insulin: 0.5, automatic: true, created_at: iso(T0 + 2 * HOUR + 10 * MINUTE) }
      , { _id: '5', eventType: 'Carb Correction', carbs: 15, created_at: iso(T0 + 3 * HOUR) }
    ];

    it('flags corrections and automatic boluses', function () {
      const boluses = createAggregator.classifyBoluses(treatments, carbEntries);
      boluses.should.have.length(4);
      boluses[0].isCorrection.should.be.true();          // eventType Correction Bolus
      boluses[1].isCorrection.should.be.true();          // no carbs, nothing nearby
      boluses[2].isCorrection.should.be.false();         // carbs on the treatment
      boluses[3].isCorrection.should.be.false();         // carb entry 10 min earlier
      boluses[3].automatic.should.be.true();
      boluses[0].automatic.should.be.false();
      boluses[1].units.should.equal(2);
      should(boluses[1].carbs).be.null();
      boluses[2].id.should.equal('3');
    });
  });

  describe('buildTherapySnapshot', function () {
    it('reads schedules from the active store and converts mmol sens', function () {
      const profile = makeProfile(flatProfile({
        units: 'mmol'
        , sens: [{ time: '00:00', value: 2.8 }, { time: '06:00', value: 2.2 }]
        , insulinType: 'Fiasp'
      }));
      const snap = createAggregator.buildTherapySnapshot(profile, T0 + DAY, { timezone: 'UTC' });
      snap.sens.should.eql([
        { startSeconds: 0, value: Math.round(2.8 * 18.018) }
        , { startSeconds: 6 * 3600, value: Math.round(2.2 * 18.018) }
      ]);
      snap.basal.should.eql([{ startSeconds: 0, value: 1 }]);
      snap.carbratio.should.eql([{ startSeconds: 0, value: 10 }]);
      snap.dia.should.equal(5);
      snap.profileUnits.should.equal('mmol');
      snap.insulinType.should.equal('Fiasp');
      snap.profileName.should.equal('Default');
      snap.profileId.should.equal('profile1');
      snap.system.should.equal('Unknown');
      snap.timezone.should.equal('UTC');
    });

    it('keeps mg/dl sens unchanged and prefers the bolus insulinType', function () {
      const profile = makeProfile(flatProfile());
      const treatments = [
        { eventType: 'Bolus', insulin: 1, insulinType: 'Novolog', created_at: iso(T0 + DAY - HOUR) }
        , { eventType: 'Bolus', insulin: 1, insulinType: 'Novolog', created_at: iso(T0 + DAY - 2 * HOUR) }
        , { eventType: 'Bolus', insulin: 1, insulinType: 'Lyumjev', created_at: iso(T0 + DAY - 3 * HOUR) }
      ];
      const snap = createAggregator.buildTherapySnapshot(profile, T0 + DAY, { treatments: treatments, timezone: 'UTC' });
      snap.sens[0].value.should.equal(50);
      snap.sens[1].startSeconds.should.equal(12 * 3600);
      snap.insulinType.should.equal('Novolog');
      snap.profileUnits.should.equal('mg/dl');
    });
  });

  describe('detectSystem', function () {
    it('detects Loop, AAPS, oref0, Trio and none', function () {
      createAggregator.detectSystem([{ loop: { name: 'Loop' } }]).should.equal('Loop');
      createAggregator.detectSystem([{ device: 'openaps://Samsung', openaps: { suggested: { reason: 'AAPS 3.2' } } }]).should.equal('AAPS');
      createAggregator.detectSystem([{ device: 'openaps://edison', openaps: { suggested: { reason: 'COB: 0' } } }]).should.equal('oref0');
      createAggregator.detectSystem([{ device: 'Trio', openaps: { iob: { iob: 1 } } }]).should.equal('Trio');
      createAggregator.detectSystem([]).should.equal('Unknown');
      createAggregator.detectSystem([{ uploader: { battery: 50 } }]).should.equal('Unknown');
    });
  });

  describe('aggregate() with a fake ctx', function () {
    const fromMs = T0;
    const toMs = T0 + DAY;

    const entries = [];
    for (let t = fromMs; t < toMs; t += 5 * MINUTE) {
      const hour = Math.floor((t - fromMs) / HOUR);
      entries.push({ date: t, sgv: 100 + hour * 2, type: 'sgv' });
    }
    entries.push({ date: fromMs + HOUR, sgv: 12, type: 'sgv' }); // error code, dropped

    const treatments = [
      { _id: 't1', eventType: 'Temp Basal', absolute: 0, duration: 60, created_at: iso(fromMs + 2 * HOUR) }
      , { _id: 't2', eventType: 'Meal Bolus', insulin: 4, carbs: 40, foodType: 'Pizza', created_at: iso(fromMs + 12 * HOUR) }
      , { _id: 't3', eventType: 'Correction Bolus', insulin: 1, created_at: iso(fromMs + 15 * HOUR) }
      , { _id: 't4', eventType: 'Bolus', insulin: 0.5, automatic: true, created_at: iso(fromMs + 16 * HOUR) }
      , { _id: 't5', eventType: 'Carb Correction', carbs: 20, created_at: iso(fromMs + 18 * HOUR) }
      // outside the window (lookback), ignored for boluses
      , { _id: 't0', eventType: 'Bolus', insulin: 9, created_at: iso(fromMs - 2 * HOUR) }
    ];

    const devicestatus = [
      { _id: 'd1', device: 'loop://iPhone', created_at: iso(fromMs + HOUR), loop: { name: 'Loop', iob: { iob: 1 } } }
      , { _id: 'd2', device: 'uploader', created_at: iso(fromMs + 2 * HOUR), uploader: { battery: 80 } }
    ];

    function respondWith (docs) {
      return function list (opts, fn) {
        should.exist(opts.find);
        setImmediate(function later () { fn(null, docs); });
      };
    }

    const ctx = {
      moment: moment
      , entries: { list: respondWith(entries) }
      , treatments: { list: respondWith(treatments) }
      , devicestatus: { list: respondWith(devicestatus) }
      , profile: {
        list: function list (fn, count) {
          count.should.equal(10);
          setImmediate(function later () { fn(null, [flatProfile()]); });
        }
      }
    };

    it('returns every AggregatedData key with plausible numbers', async function () {
      const agg = await createAggregator({}, ctx).aggregate({ fromMs: fromMs, toMs: toMs });

      agg.should.have.keys('period', 'glucose', 'insulin', 'carbs', 'settings', 'tightRangeUpperBound', 'devicestatus');
      agg.period.should.eql({ days: 1, fromMs: fromMs, toMs: toMs, timezone: 'UTC' });
      agg.tightRangeUpperBound.should.equal(140);

      agg.glucose.count.should.equal(288);
      agg.glucose.mean.should.be.approximately(123, 0.01);
      agg.glucose.hourly[0].mean.should.equal(100);
      agg.glucose.hourly[23].mean.should.equal(146);
      agg.glucose.should.have.keys('count', 'mean', 'sd', 'cv', 'veryHighPct', 'highPct', 'inRangePct', 'lowPct'
        , 'veryLowPct', 'tirPct', 'titrPct', 'tbrPct', 'tarPct', 'gmi', 'hourly', 'hourlyByDay', 'readings');

      agg.insulin.should.have.keys('tddAvg', 'tddMin', 'tddMax', 'tddCv', 'tddWeekOverWeekPct', 'basalTotal', 'bolusTotal'
        , 'basalPct', 'bolusPct', 'correctionCount', 'automaticCorrectionCount', 'correctionsPerDay', 'daily', 'boluses'
        , 'suspensions', 'source');
      agg.insulin.basalTotal.should.be.approximately(23, 0.001);
      agg.insulin.bolusTotal.should.be.approximately(5.5, 0.001);
      agg.insulin.boluses.should.have.length(3);
      agg.insulin.correctionCount.should.equal(2);
      agg.insulin.automaticCorrectionCount.should.equal(1);
      agg.insulin.correctionsPerDay.should.equal(2);
      agg.insulin.suspensions.events.should.equal(1);
      agg.insulin.suspensions.totalMinutes.should.equal(60);
      agg.insulin.source.should.equal('reconstructed');
      agg.insulin.daily.should.have.length(1);
      agg.insulin.daily[0].date.should.equal('2024-03-04');
      agg.insulin.tddAvg.should.be.approximately(28.5, 0.001);
      should(agg.insulin.tddWeekOverWeekPct).be.null();

      agg.carbs.should.have.keys('dailyAvg', 'entryCount', 'perMealAvg', 'byHour', 'entries');
      agg.carbs.entryCount.should.equal(2);
      agg.carbs.dailyAvg.should.equal(60);
      agg.carbs.perMealAvg.should.equal(30);
      agg.carbs.byHour[12].should.equal(1);
      agg.carbs.entries[0].foodType.should.equal('Pizza');
      agg.carbs.entries[0].should.have.keys('mills', 'grams', 'foodType', 'protein', 'fat', 'fiber', 'absorptionTime', 'id');

      agg.settings.should.have.keys('basal', 'carbratio', 'sens', 'dia', 'insulinType', 'profileName', 'profileId'
        , 'profileUnits', 'system', 'timezone');
      agg.settings.system.should.equal('Loop');
      agg.settings.basal.should.eql([{ startSeconds: 0, value: 1 }]);

      agg.devicestatus.should.have.length(1);
      agg.devicestatus[0]._id.should.equal('d1');
    });

    it('rejects an empty window', async function () {
      let failed = false;
      try {
        await createAggregator({}, ctx).aggregate({ fromMs: toMs, toMs: fromMs });
      } catch (err) {
        failed = true;
      }
      failed.should.be.true();
    });
  });
});

describe('aiinsights basal-integrator', function () {
  const fromMs = T0;
  const toMs = T0 + DAY;

  function run (tempBasals, extra) {
    const profile = makeProfile(flatProfile(), tempBasals);
    return integrator.reconstructInsulin(Object.assign({
      profile: profile
      , treatments: []
      , boluses: []
      , readings: []
      , fromMs: fromMs
      , toMs: toMs
      , timezone: 'UTC'
    }, extra || {}));
  }

  it('integrates a flat 1.0 U/hr basal over 24h to 24 U', function () {
    const stats = run([]);
    stats.basalTotal.should.be.approximately(24, 0.001);
    stats.bolusTotal.should.equal(0);
    stats.basalPct.should.equal(100);
    stats.suspensions.events.should.equal(0);
    stats.suspensions.subBasalMinutes.should.equal(0);
    stats.daily.should.have.length(1);
    stats.daily[0].total.should.be.approximately(24, 0.001);
    stats.tddAvg.should.be.approximately(24, 0.001);
    stats.tddCv.should.equal(0);
  });

  it('counts a 60 minute zero temp as one suspension event', function () {
    const stats = run([{ absolute: 0, duration: 60, created_at: iso(fromMs + 3 * HOUR) }]);
    stats.basalTotal.should.be.approximately(23, 0.001);
    stats.suspensions.events.should.equal(1);
    stats.suspensions.totalMinutes.should.equal(60);
    stats.suspensions.pctOfPeriod.should.be.approximately(60 / 1440 * 100, 0.001);
    stats.suspensions.byHour[3].minutes.should.equal(60);
    stats.suspensions.byHour[4].minutes.should.equal(0);
  });

  it('counts a 120 minute absolute 0.5 temp as sub-basal time', function () {
    const stats = run([{ absolute: 0.5, duration: 120, created_at: iso(fromMs + 6 * HOUR) }]);
    stats.suspensions.subBasalMinutes.should.equal(120);
    stats.suspensions.events.should.equal(0);
    stats.basalTotal.should.be.approximately(23, 0.001);
  });

  it('detects overcorrection when glucose exceeds 180 within 2h of resume', function () {
    const readings = [{ mills: fromMs + 4 * HOUR + 30 * MINUTE, mgdl: 190 }];
    const stats = run([{ absolute: 0, duration: 60, created_at: iso(fromMs + 3 * HOUR) }], { readings: readings });
    stats.suspensions.overcorrectionEvents.should.equal(1);
  });

  it('honours explicit Suspend Pump treatments and devicestatus suspended flags', function () {
    const treatments = [{ eventType: 'Suspend Pump', created_at: iso(fromMs + 10 * HOUR), mills: fromMs + 10 * HOUR }];
    const devicestatus = [{ created_at: iso(fromMs + 20 * HOUR), mills: fromMs + 20 * HOUR, loop: {}, pump: { status: { suspended: true } } }];
    const stats = run([], { treatments: treatments, devicestatus: devicestatus });
    stats.suspensions.events.should.equal(2);
    // 30 min default suspend + the single status within +/-5 min of two cells
    stats.suspensions.totalMinutes.should.equal(40);
  });

  it('adds boluses to the daily totals and splits basal/bolus percentages', function () {
    const boluses = [
      { mills: fromMs + 8 * HOUR, units: 4, isCorrection: false, automatic: false }
      , { mills: fromMs + 20 * HOUR, units: 2, isCorrection: true, automatic: true }
    ];
    const stats = run([], { boluses: boluses });
    stats.bolusTotal.should.equal(6);
    stats.basalPct.should.be.approximately(80, 0.001);
    stats.bolusPct.should.be.approximately(20, 0.001);
    stats.correctionCount.should.equal(1);
    stats.automaticCorrectionCount.should.equal(1);
    stats.daily[0].bolus.should.equal(6);
    stats.daily[0].total.should.be.approximately(30, 0.001);
  });

  it('prefers a pump-reported TDD when devicestatus carries one', function () {
    const devicestatus = [
      { created_at: iso(fromMs + 23 * HOUR), mills: fromMs + 23 * HOUR, openaps: { iob: { TDD: 31.5 } } }
    ];
    const stats = run([], { devicestatus: devicestatus });
    stats.source.should.equal('reported');
    stats.tddAvg.should.equal(31.5);
    stats.basalTotal.should.be.approximately(24, 0.001);
  });

  describe('weekOverWeek', function () {
    it('is null below 14 days and a rounded percent otherwise', function () {
      const short = [];
      for (let i = 0; i < 13; i++) { short.push({ date: 'd' + i, basal: 10, bolus: 10, total: 20 }); }
      should(integrator.weekOverWeek(short)).be.null();

      const daily = [];
      for (let i = 0; i < 7; i++) { daily.push({ date: 'a' + i, basal: 10, bolus: 10, total: 20 }); }
      for (let i = 0; i < 7; i++) { daily.push({ date: 'b' + i, basal: 12, bolus: 10, total: 22 }); }
      integrator.weekOverWeek(daily).should.equal(10);
    });
  });

  describe('localDayKey', function () {
    it('keys by the local day of the given zone', function () {
      integrator.localDayKey(T0 - HOUR, 'UTC').should.equal('2024-03-03');
      integrator.localDayKey(T0 - HOUR, 'Asia/Jerusalem').should.equal('2024-03-04');
      integrator.localDayKey(T0 - HOUR, '+02:00').should.equal('2024-03-04');
    });
  });
});
