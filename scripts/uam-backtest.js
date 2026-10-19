#!/usr/bin/env node
'use strict';

// Read-only backtest of the AI Insights UAM carbohydrate-equivalent estimate.
//
//   1. load a real window through lib/aiinsights/aggregator.js
//   2. uam.analyze() on the data as logged
//   3. uam.analyze() again with every carb entry masked (agg.carbs.entries = [])
//   4. match masked-run episodes to the logged meals by onset time and report
//      accuracy of estimatedCho against the logged grams
//
// Sources (pick one):
//   --fixture file.json   { entries, treatments, devicestatus, profiles } as stored in Mongo
//   --mongo <uri>         read-only find() queries against the Nightscout database
// Window: --from <ISO> --to <ISO>, or --days N ending at the newest SGV (default 30)
// Other:  --export out.json   save the raw window (Mongo mode) as a fixture for offline reruns
//         --json              machine-readable output
//         --details           print one line per logged meal
//
// Nothing is written to the database and lib/aiinsights/uam.js is not modified.
// The figures are a validation of a glucose-equivalent estimate, never a dosing rule.

const fs = require('fs');
const path = require('path');

const createAggregator = require('../lib/aiinsights/aggregator');
const uam = require('../lib/aiinsights/uam');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// Same window uam.js uses to call an episode announced.
const MATCH_BEFORE_MS = 15 * MINUTE;
const MATCH_AFTER_MS = 45 * MINUTE;

const BUCKETS = [
  { label: '<20 g', test: function (g) { return g < 20; } }
  , { label: '20-50 g', test: function (g) { return g >= 20 && g <= 50; } }
  , { label: '>50 g', test: function (g) { return g > 50; } }
];

function parseArgs (argv) {
  const opts = { days: 30 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; }
    else if (a === '--details') { opts.details = true; }
    else if (a.indexOf('--') === 0) { opts[a.slice(2)] = argv[++i]; }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function fromFixture (file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    entries: raw.entries || []
    , treatments: raw.treatments || []
    , devicestatus: raw.devicestatus || []
    , profiles: raw.profiles || raw.profile || []
  };
}

async function fromMongo (uri, fromMs, toMs, days) {
  const MongoClient = require('mongodb').MongoClient;
  const client = new MongoClient(uri, { readPreference: 'secondaryPreferred' });
  await client.connect();
  try {
    const db = client.db();
    const names = {
      entries: process.env.ENTRIES_COLLECTION || 'entries'
      , treatments: process.env.TREATMENTS_COLLECTION || 'treatments'
      , devicestatus: process.env.DEVICESTATUS_COLLECTION || 'devicestatus'
      , profile: process.env.PROFILE_COLLECTION || 'profile'
    };
    let to = toMs;
    if (!to) {
      const newest = await db.collection(names.entries).find({ type: 'sgv' }).sort({ date: -1 }).limit(1).toArray();
      to = newest.length ? Number(newest[0].date) : Date.now();
    }
    const from = fromMs || to - days * DAY;
    const lookback = new Date(from - DAY).toISOString();
    const toISO = new Date(to).toISOString();
    return {
      fromMs: from
      , toMs: to
      , entries: await db.collection(names.entries).find({ type: 'sgv', date: { $gte: from, $lte: to } }).sort({ date: 1 }).toArray()
      , treatments: await db.collection(names.treatments).find({ created_at: { $gte: lookback, $lte: toISO } }).sort({ created_at: 1 }).toArray()
      , devicestatus: await db.collection(names.devicestatus).find({ created_at: { $gte: new Date(from).toISOString(), $lte: toISO } }).sort({ created_at: 1 }).toArray()
      , profiles: await db.collection(names.profile).find({}).sort({ startDate: -1 }).limit(10).toArray()
    };
  } finally {
    await client.close();
  }
}

// aggregator only needs list()-style callbacks; serve them from the loaded arrays
function fakeCtx (raw) {
  function inRange (value, cond) {
    return (cond.$gte === undefined || value >= cond.$gte) && (cond.$lte === undefined || value <= cond.$lte);
  }
  return {
    entries: { list: function (opts, done) {
      const c = opts.find.date;
      done(null, raw.entries.filter(function (e) { return inRange(Number(e.date !== undefined ? e.date : e.mills), c) && e.type === 'sgv'; }));
    } }
    , treatments: { list: function (opts, done) {
      const c = opts.find.created_at;
      done(null, raw.treatments.filter(function (t) {
        const ms = Date.parse(t.created_at);
        return Number.isFinite(ms) && inRange(ms, { $gte: Date.parse(c.$gte), $lte: Date.parse(c.$lte) });
      }));
    } }
    , devicestatus: { list: function (opts, done) {
      const c = opts.find.created_at;
      done(null, raw.devicestatus.filter(function (d) {
        const ms = Date.parse(d.created_at);
        return Number.isFinite(ms) && inRange(ms, { $gte: Date.parse(c.$gte), $lte: Date.parse(c.$lte) });
      }));
    } }
    , profile: { list: function (done) { done(null, raw.profiles); } }
  };
}

// ---------------------------------------------------------------------------
// Matching and metrics
// ---------------------------------------------------------------------------

/**
 * Assign each logged meal to the masked-run episode whose onset lies in the
 * uam announce window around the entry (nearest onset wins). Meals sharing an
 * episode are summed, the same way uam.js sums loggedCarbs.
 */
function matchMeals (meals, episodes) {
  const matched = new Map();
  const undetected = [];
  meals.forEach(function (meal) {
    let best = null;
    episodes.forEach(function (ep) {
      const dt = ep.onsetMills - meal.mills;
      if (dt < -MATCH_BEFORE_MS || dt > MATCH_AFTER_MS) { return; }
      if (best === null || Math.abs(dt) < Math.abs(best.dt)) { best = { ep: ep, dt: dt }; }
    });
    if (!best) { undetected.push(meal); return; }
    if (!matched.has(best.ep)) { matched.set(best.ep, { episode: best.ep, meals: [] }); }
    matched.get(best.ep).meals.push(meal);
  });
  return { groups: Array.from(matched.values()), undetected: undetected };
}

function stats (values) {
  if (!values.length) { return null; }
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(sorted.length / 2);
  return {
    n: values.length
    , mean: values.reduce(function (s, v) { return s + v; }, 0) / values.length
    , median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  };
}

function summarize (rows) {
  const withFigure = rows.filter(function (r) { return r.mid !== null; });
  const err = withFigure.map(function (r) { return r.mid - r.logged; });
  const abs = err.map(Math.abs);
  const inside = withFigure.filter(function (r) { return r.logged >= r.low && r.logged <= r.high; }).length;
  return {
    episodes: rows.length
    , withFigure: withFigure.length
    , noPreciseFigure: rows.length - withFigure.length
    , maeG: abs.length ? stats(abs).mean : null
    , medianAbsErrG: abs.length ? stats(abs).median : null
    , biasG: err.length ? stats(err).mean : null
    , insideRangePct: withFigure.length ? inside / withFigure.length * 100 : null
  };
}

function backtest (raw, fromMs, toMs) {
  const aggregator = createAggregator(null, fakeCtx(raw));
  return aggregator.aggregate({ fromMs: fromMs, toMs: toMs }).then(function (agg) {
    const original = uam.analyze(agg);

    // deep-ish copy so the masked run cannot touch the original aggregate
    const masked = Object.assign({}, agg, { carbs: Object.assign({}, agg.carbs, { entries: [] }) });
    const maskedResult = uam.analyze(masked);

    const meals = agg.carbs.entries.filter(function (c) { return c.grams > 0; });
    const m = matchMeals(meals, maskedResult.episodes);

    const rows = m.groups.map(function (g) {
      const logged = g.meals.reduce(function (s, x) { return s + x.grams; }, 0);
      const est = g.episode.estimatedCho;
      return {
        onsetMills: g.episode.onsetMills
        , logged: logged
        , meals: g.meals.length
        , low: est ? est.low : null
        , mid: est ? est.mid : null
        , high: est ? est.high : null
        , confidence: g.episode.confidence
        , type: g.episode.type
        , notes: g.episode.notes
      };
    });

    const buckets = BUCKETS.map(function (b) {
      return Object.assign({ bucket: b.label }, summarize(rows.filter(function (r) { return b.test(r.logged); })));
    });
    const confidences = ['high', 'medium', 'low'].map(function (c) {
      return Object.assign({ confidence: c }, summarize(rows.filter(function (r) { return r.confidence === c; })));
    });

    const matchedEpisodes = new Set(m.groups.map(function (g) { return g.episode; }));
    const origAnnounced = original.episodes.filter(function (e) { return e.announced; });

    return {
      period: agg.period
      , days: agg.period.days
      , settings: { dia: agg.settings.dia, insulinType: agg.settings.insulinType, system: agg.settings.system }
      , loggedMeals: meals.length
      , detectedMeals: meals.length - m.undetected.length
      , detectedSharePct: meals.length ? (meals.length - m.undetected.length) / meals.length * 100 : null
      , undetectedMeals: m.undetected.map(function (x) { return { mills: x.mills, grams: x.grams }; })
      , originalEpisodes: original.episodes.length
      , originalAnnounced: origAnnounced.length
      , maskedEpisodes: maskedResult.episodes.length
      , maskedEpisodesWithoutLoggedMeal: maskedResult.episodes.length - matchedEpisodes.size
      , overall: summarize(rows)
      , byBucket: buckets
      , byConfidence: confidences
      , rows: rows
    };
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function f (v, d) { return v === null || v === undefined ? 'n/a' : v.toFixed(d === undefined ? 1 : d); }

function printReport (r, opts) {
  const tz = r.period.timezone;
  const out = [];
  out.push('UAM backtest (carb entries masked, estimatedCho.mid vs logged grams)');
  out.push('Window: ' + new Date(r.period.fromMs).toISOString() + ' .. ' + new Date(r.period.toMs).toISOString()
    + ' (' + f(r.days, 1) + ' days, ' + tz + '); system ' + r.settings.system + ', insulin ' + r.settings.insulinType + ', DIA ' + r.settings.dia);
  out.push('');
  out.push('Logged meals ' + r.loggedMeals + ' | detected ' + r.detectedMeals + ' (' + f(r.detectedSharePct) + '%)');
  out.push('Episodes: original ' + r.originalEpisodes + ' (' + r.originalAnnounced + ' announced), masked ' + r.maskedEpisodes
    + ', masked episodes with no logged meal ' + r.maskedEpisodesWithoutLoggedMeal);
  out.push('');
  const o = r.overall;
  out.push('Matched episodes ' + o.episodes + ': with figure ' + o.withFigure + ', noPreciseFigure ' + o.noPreciseFigure);
  out.push('MAE ' + f(o.maeG) + ' g | median abs err ' + f(o.medianAbsErrG) + ' g | bias ' + f(o.biasG) + ' g | inside low-high ' + f(o.insideRangePct) + '%');
  out.push('');
  out.push('By logged meal size (bias = mid - logged; positive means over-estimate):');
  r.byBucket.forEach(function (b) {
    out.push('  ' + b.bucket.padEnd(8) + ' n=' + String(b.episodes).padEnd(4) + ' figure=' + String(b.withFigure).padEnd(4)
      + ' noFigure=' + String(b.noPreciseFigure).padEnd(4) + ' MAE=' + f(b.maeG).padEnd(6) + ' bias=' + f(b.biasG).padEnd(7) + ' inRange=' + f(b.insideRangePct) + '%');
  });
  out.push('By confidence:');
  r.byConfidence.forEach(function (b) {
    out.push('  ' + b.confidence.padEnd(8) + ' n=' + String(b.episodes).padEnd(4) + ' figure=' + String(b.withFigure).padEnd(4)
      + ' MAE=' + f(b.maeG).padEnd(6) + ' bias=' + f(b.biasG).padEnd(7) + ' inRange=' + f(b.insideRangePct) + '%');
  });
  if (opts.details) {
    out.push('');
    out.push('Per meal:');
    r.rows.forEach(function (x) {
      out.push('  ' + new Date(x.onsetMills).toISOString() + ' logged ' + x.logged + ' g'
        + (x.mid === null ? ' -> noPreciseFigure' : ' -> ' + x.low + '/' + x.mid + '/' + x.high) + ' [' + x.confidence + ', ' + x.type + ']');
    });
  }
  out.push('');
  out.push('Glucose-equivalent estimate for validation only; not a dosing rule.');
  console.log(out.join('\n'));
}

async function main () {
  const opts = parseArgs(process.argv);
  let raw;
  let fromMs = opts.from ? Date.parse(opts.from) : null;
  let toMs = opts.to ? Date.parse(opts.to) : null;
  const days = Number(opts.days) || 30;

  if (opts.fixture) {
    raw = fromFixture(path.resolve(opts.fixture));
  } else if (opts.mongo) {
    raw = await fromMongo(opts.mongo, fromMs, toMs, days);
    if (opts.export) {
      fs.writeFileSync(path.resolve(opts.export), JSON.stringify(raw));
      console.error('exported raw window to ' + opts.export);
    }
  } else {
    console.error('usage: node scripts/uam-backtest.js (--fixture file.json | --mongo <uri>) [--from ISO --to ISO | --days N] [--details] [--json] [--export out.json]');
    process.exit(2);
  }

  if (!toMs) {
    toMs = raw.toMs || raw.entries.reduce(function (mx, e) { return Math.max(mx, Number(e.date !== undefined ? e.date : e.mills) || 0); }, 0);
  }
  if (!fromMs) { fromMs = raw.fromMs || toMs - days * DAY; }

  const result = await backtest(raw, fromMs, toMs);
  if (opts.json) { console.log(JSON.stringify(result, null, 2)); } else { printReport(result, opts); }
}

if (require.main === module) {
  main().catch(function (err) { console.error(err); process.exit(1); });
}

module.exports = { backtest: backtest, matchMeals: matchMeals, summarize: summarize };
