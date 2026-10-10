'use strict';

// Router tests with a fake ctx: real authorization semantics (shiro-trie),
// real service, fake Mongo collections, fake provider fetch. No database.

require('should');
var request = require('supertest');
var express = require('express');
var shiroTrie = require('shiro-trie');
var moment = require('moment-timezone');

var types = require('../lib/aiinsights/types');

function fakeMongo () {
  var data = { ai_suggestions: [], ai_analyses: [], ai_usage: [], ai_settings: [] };
  function matches (doc, q) {
    return Object.keys(q || { }).every(function (k) {
      var want = q[k];
      var have = k.indexOf('.') > -1 ? k.split('.').reduce(function (o, p) { return o ? o[p] : undefined; }, doc) : doc[k];
      if (want && typeof want === 'object' && !Array.isArray(want) && !(want instanceof Date)) {
        if ('$in' in want) { return want.$in.indexOf(have) > -1; }
        if ('$nin' in want) { return want.$nin.indexOf(have) === -1; }
        if ('$ne' in want) { return have !== want.$ne; }
        if ('$gte' in want) { return have >= want.$gte; }
      }
      return have === want || (want === null && (have === null || have === undefined));
    });
  }
  function col (name) {
    var rows = data[name];
    return {
      findOne: async function (q) { return rows.find(function (d) { return matches(d, q); }) || null; }
      , replaceOne: async function (q, doc) { var i = rows.findIndex(function (d) { return matches(d, q); }); if (i > -1) { rows[i] = doc; } else { rows.push(doc); } return { }; }
      , insertOne: async function (doc) { doc._id = doc._id || 'id' + (rows.length + 1); rows.push(doc); return { insertedId: doc._id }; }
      , insertMany: async function (docs) { docs.forEach(function (d) { d._id = d._id || 'id' + (rows.length + 1); rows.push(d); }); return { }; }
      , updateMany: async function (q, u) { var n = 0; rows.forEach(function (d) { if (matches(d, q)) { Object.assign(d, u.$set); n++; } }); return { modifiedCount: n }; }
      , findOneAndUpdate: async function (q, u) { var d = rows.find(function (x) { return matches(x, q); }); if (d) { Object.assign(d, u.$set); } return { value: d || null }; }
      , find: function (q) {
        var found = rows.filter(function (d) { return matches(d, q); });
        return { sort: function (s) { var k = Object.keys(s)[0]; found.sort(function (a, b) { return a[k] < b[k] ? s[k] : a[k] > b[k] ? -s[k] : 0; }); return { limit: function (n) { return { toArray: async function () { return found.slice(0, n); } }; } }; } };
      }
      , aggregate: function () { return { toArray: async function () { var total = rows.reduce(function (a, r) { return a + (r.estimated_cost_usd || 0); }, 0); return rows.length ? [{ total: total, count: rows.length }] : []; } }; }
      , createIndex: async function () { }
    };
  }
  return { data: data, collection: col, ensureIndexes: function () { } };
}

function build (opts) {
  opts = opts || { };
  var env = {
    enclave: require('../lib/server/enclave')()
    , extendedSettings: { aiinsights: { privacyAck: opts.privacyAck !== false, model: 'gemini-3.8-flash' } }
    , ai_suggestions_collection: 'ai_suggestions', ai_analyses_collection: 'ai_analyses', ai_usage_collection: 'ai_usage', ai_settings_collection: 'ai_settings'
    , settings: { isEnabled: function () { return true; } }
  };
  if (opts.key !== false) { env.enclave.setAiApiKey('sk-test-key'); }

  var roles = { readable: ['*:*:read'], 'ai-insights': ['api:aiinsights:suggestions:read', 'api:aiinsights:suggestions:update'
    , 'api:aiinsights:analyze:create', 'api:aiinsights:chat:create', 'api:aiinsights:careportal:create', 'api:aiinsights:settings:read'], admin: ['*'] };
  function shirosFor (names) { return names.map(function (n) { var s = shiroTrie.new(); s.add(roles[n] || []); return s; }); }
  var defaultRoles = opts.defaultRoles || ['readable'];
  var tokens = { 'tok-insights': ['readable', 'ai-insights'], 'tok-admin': ['admin'] };

  var mongo = fakeMongo();
  var now = Date.now();
  var readings = [];
  for (var i = 0; i < 14 * 288; i++) { readings.push({ sgv: 120 + Math.round(30 * Math.sin(i / 20)), date: now - i * 5 * 60000, type: 'sgv' }); }
  var ctx = {
    moment: moment
    , store: mongo
    , purifier: { purifyObject: function () { } }
    , authorization: {
      resolveAnonymous: function () { return { shiros: shirosFor(defaultRoles) }; }
      , checkMultiple: function (perm, shiros) { return shiros.some(function (s) { return s.check(perm); }); }
      , isPermitted: function (perm) {
        return function (req, res, next) {
          var auth = req.headers.authorization || '';
          var token = auth.replace('Bearer ', '');
          var names = tokens[token] ? tokens[token].concat(defaultRoles) : defaultRoles;
          if (ctx.authorization.checkMultiple(perm, shirosFor(names))) { return next(); }
          res.status(401).json({ status: 401, message: 'Unauthorized' });
        };
      }
    }
    , entries: { list: function (q, cb) { cb(null, readings); } }
    , treatments: { list: function (q, cb) { cb(null, [{ eventType: 'Meal Bolus', created_at: new Date(now - 3600000).toISOString(), carbs: 40, insulin: 4 }]); }
      , create: function (docs, cb) { mongo.data.treatments = docs; cb(null, docs); } }
    , devicestatus: { list: function (q, cb) { cb(null, []); } }
    , profile: { list: function (cb) { cb(null, [{ _id: 'p1', defaultProfile: 'Default', startDate: '2020-01-01T00:00:00.000Z', store: { Default: { units: 'mg/dl', dia: 6, timezone: 'UTC'
      , basal: [{ time: '00:00', timeAsSeconds: 0, value: 0.8 }], sens: [{ time: '00:00', timeAsSeconds: 0, value: 50 }], carbratio: [{ time: '00:00', timeAsSeconds: 0, value: 10 }]
      , target_low: [{ time: '00:00', timeAsSeconds: 0, value: 100 }], target_high: [{ time: '00:00', timeAsSeconds: 0, value: 120 }] } } }]); } }
    , ddata: { sgvs: [], devicestatus: [] }
  };

  var service = require('../lib/aiinsights')(env, ctx);
  ctx.aiinsights = service;
  // fake provider: swap sendPrompt on the module instance used by the service
  service.provider = Object.assign({ }, service.provider, {
    sendPrompt: async function (cfg, key, system, user) {
      key.should.equal('sk-test-key');
      build.lastPrompt = { system: system, user: user };
      if (opts.delayMs) { await new Promise(function (resolve) { setTimeout(resolve, opts.delayMs); }); }
      return { text: opts.responseText || JSON.stringify({ suggestions: [{ time_blocks: [{ start_seconds: 0, end_seconds: 21600, current_value: 0.8, proposed_value: 0.85 }]
        , plain_summary: 'A bit more overnight basal.', reasoning: 'Overnight average 150 mg/dL drifting up.', confidence: 'medium'
        , success_criteria: { expected_outcomes: ['Overnight avg below 130 mg/dL'], evaluation_days: 5, revert_warnings: [], metric_targets: { } } }]
        , past_suggestion_evaluations: { }, overall_assessment: 'Overnight runs high.', next_recommended_focus: 'carb_ratio' }), usage: { inputTokens: 100, outputTokens: 50 }, status: 200, latencyMs: 5 };
    }
    , testConnection: async function () { return { ok: true, status: 200, latencyMs: 3, message: 'OK' }; }
  });
  // re-bind: service functions captured `provider` by closure, so patch through the exported object
  service.testConnection = async function () { return service.provider.testConnection(); };
  var origSend = service.sendPrompt;
  service.sendPrompt = async function (o) {
    var cfg = service.providerConfig();
    var r = await env.enclave.withAiApiKey(function (k) { return service.provider.sendPrompt(cfg, k, o.systemPrompt, o.userPrompt); });
    var record = service.usage.buildUsageRecord({ kind: o.kind, model: cfg.model, systemPrompt: o.systemPrompt, userPrompt: o.userPrompt, responseText: r.text, reportedUsage: r.usage });
    await service.store.insertUsage(record);
    return { text: r.text, usage: r.usage, status: r.status, latencyMs: r.latencyMs, usageRecord: record, model: cfg.model, format: cfg.format };
  };
  service.sendPrompt.orig = origSend;

  var app = express();
  app.enable('api');
  var wares = require('../lib/middleware')(env);
  app.all('/aiinsights*', require('../lib/api/aiinsights')(app, wares, ctx));
  return { app: app, mongo: mongo, service: service, env: env };
}

function waitJob (app, jobId, token) {
  return new Promise(function (resolve, reject) {
    var tries = 0;
    (function poll () {
      request(app).get('/aiinsights/jobs/' + jobId).set('Authorization', 'Bearer ' + token).end(function (err, res) {
        if (err) { return reject(err); }
        if (res.body.status === 'done' || res.body.status === 'failed') { return resolve(res.body); }
        if (++tries > 50) { return reject(new Error('job timeout')); }
        setTimeout(poll, 10);
      });
    })();
  });
}

describe('aiinsights API', function () {
  this.timeout(10000);

  it('answers 401 to the readable role on every endpoint (AI-API-003)', async function () {
    var t = build();
    var calls = [
      ['get', '/aiinsights/settings'], ['put', '/aiinsights/settings'], ['post', '/aiinsights/settings/test-connection'], ['get', '/aiinsights/usage']
      , ['get', '/aiinsights/aggregate'], ['get', '/aiinsights/summary'], ['post', '/aiinsights/analyze'], ['post', '/aiinsights/trends'], ['post', '/aiinsights/chat']
      , ['get', '/aiinsights/jobs/x'], ['get', '/aiinsights/suggestions'], ['patch', '/aiinsights/suggestions/x'], ['get', '/aiinsights/analyses'], ['post', '/aiinsights/careportal']
    ];
    for (var i = 0; i < calls.length; i++) {
      var res = await request(t.app)[calls[i][0]](calls[i][1]).send({ });
      res.status.should.equal(401, calls[i].join(' '));
    }
  });

  it('locks the feature when default roles would permit anonymous use (AI-API-004)', async function () {
    var t = build({ defaultRoles: ['admin'] });
    var settings = await request(t.app).get('/aiinsights/settings');
    settings.status.should.equal(200);
    settings.body.locked.should.equal(true);
    var res = await request(t.app).post('/aiinsights/analyze').send({ settingType: 'basal_rate' });
    res.status.should.equal(403);
    res.body.message.should.equal('AI Insights is locked');
  });

  it('exposes provider metadata without the key and reports readiness', async function () {
    var t = build();
    var res = await request(t.app).get('/aiinsights/settings').set('Authorization', 'Bearer tok-insights');
    res.status.should.equal(200);
    res.body.provider.configured.should.equal(true);
    res.body.provider.model.should.equal('gemini-3.8-flash');
    res.body.provider.format.should.equal('gemini');
    JSON.stringify(res.body).should.not.containEql('sk-test-key');
    res.body.readiness.reason.should.equal('privacy_ack_required');
    res.body.units.should.equal('mg/dl');
  });

  it('requires settings:update for PUT and validates the body', async function () {
    var t = build();
    (await request(t.app).put('/aiinsights/settings').set('Authorization', 'Bearer tok-insights').send({ analysisPeriod: 7 })).status.should.equal(401);
    var bad = await request(t.app).put('/aiinsights/settings').set('Authorization', 'Bearer tok-admin').send({ analysisPeriod: 11 });
    bad.status.should.equal(400);
    var ok = await request(t.app).put('/aiinsights/settings').set('Authorization', 'Bearer tok-admin').send({ analysisPeriod: 7, privacyAcknowledged: true });
    ok.status.should.equal(200);
    ok.body.settings.analysisPeriod.should.equal(7);
    ok.body.readiness.ok.should.equal(true);
  });

  it('refuses billable calls until both privacy acknowledgements exist and the key is set', async function () {
    var noKey = build({ key: false });
    await request(noKey.app).put('/aiinsights/settings').set('Authorization', 'Bearer tok-admin').send({ privacyAcknowledged: true });
    (await request(noKey.app).post('/aiinsights/analyze').set('Authorization', 'Bearer tok-insights').send({ })).status.should.equal(503);

    var noEnvAck = build({ privacyAck: false });
    await request(noEnvAck.app).put('/aiinsights/settings').set('Authorization', 'Bearer tok-admin').send({ privacyAcknowledged: true });
    var r = await request(noEnvAck.app).post('/aiinsights/chat').set('Authorization', 'Bearer tok-insights').send({ message: 'hi' });
    r.status.should.equal(403);
    r.body.message.should.equal('privacy_ack_required');
  });

  it('runs a settings analysis as a job, stores suggestions and lets them be applied', async function () {
    var t = build();
    await request(t.app).put('/aiinsights/settings').set('Authorization', 'Bearer tok-admin').send({ privacyAcknowledged: true });
    var start = await request(t.app).post('/aiinsights/analyze').set('Authorization', 'Bearer tok-insights').send({ settingType: 'basal_rate', period: 14 });
    start.status.should.equal(202);
    start.body.jobId.should.be.a.String();
    start.body.estimatedCostUsd.should.equal(0.07);

    var job = await waitJob(t.app, start.body.jobId, 'tok-insights');
    job.status.should.equal('done', JSON.stringify(job.error));
    job.result.suggestions.length.should.equal(1);
    job.result.suggestions[0].setting_type.should.equal('basal_rate');
    job.result.suggestions[0].time_blocks[0].proposed_value.should.equal(0.85);
    build.lastPrompt.user.should.containEql('### Basal Rate Schedule ← ANALYZING THIS');
    build.lastPrompt.user.should.containEql('USER ENGAGEMENT & ADHERENCE');
    build.lastPrompt.system.should.startWith('UNIT CONTEXT');

    var list = await request(t.app).get('/aiinsights/suggestions?status=pending').set('Authorization', 'Bearer tok-insights');
    list.body.length.should.equal(1);
    var recordId = list.body[0].record_id;

    var usage = await request(t.app).get('/aiinsights/usage').set('Authorization', 'Bearer tok-insights');
    usage.body.callCount.should.equal(1);
    usage.body.estimatedCostUsd.should.be.above(0);

    var patched = await request(t.app).patch('/aiinsights/suggestions/' + recordId).set('Authorization', 'Bearer tok-insights').send({ status: 'applied' });
    patched.status.should.equal(200);
    patched.body.status.should.equal('applied');
    patched.body.applied_at.should.be.a.String();

    var analyses = await request(t.app).get('/aiinsights/analyses?kind=settings').set('Authorization', 'Bearer tok-insights');
    analyses.body.length.should.equal(1);
    (analyses.body[0].response_text === undefined).should.equal(true);

    var summary = await request(t.app).get('/aiinsights/summary').set('Authorization', 'Bearer tok-insights');
    summary.body.pending.should.equal(0);
    summary.body.lastAnalysisAt.should.be.a.String();
  });

  it('returns a second analysis as the same job while one is active and 400 on a bad settingType', async function () {
    var t = build({ delayMs: 150 });
    await request(t.app).put('/aiinsights/settings').set('Authorization', 'Bearer tok-admin').send({ privacyAcknowledged: true });
    var a = await request(t.app).post('/aiinsights/analyze').set('Authorization', 'Bearer tok-insights').send({ settingType: 'all' });
    var b = await request(t.app).post('/aiinsights/analyze').set('Authorization', 'Bearer tok-insights').send({ settingType: 'all' });
    b.body.jobId.should.equal(a.body.jobId);
    b.body.deduplicated.should.equal(true);
    a.body.estimatedCostUsd.should.equal(0.21);
    (await request(t.app).post('/aiinsights/analyze').set('Authorization', 'Bearer tok-insights').send({ settingType: 'dia' })).status.should.equal(400);
    await waitJob(t.app, a.body.jobId, 'tok-insights');
  });

  it('enforces the budget: 409 confirmation and 402 hard block', async function () {
    var t = build();
    await request(t.app).put('/aiinsights/settings').set('Authorization', 'Bearer tok-admin').send({ privacyAcknowledged: true, budget: { confirmBeforeCall: true } });
    var r = await request(t.app).post('/aiinsights/analyze').set('Authorization', 'Bearer tok-insights').send({ settingType: 'basal_rate' });
    r.status.should.equal(409);
    r.body.requiresConfirmation.should.equal(true);
    var ok = await request(t.app).post('/aiinsights/analyze').set('Authorization', 'Bearer tok-insights').send({ settingType: 'basal_rate', confirmCost: true });
    ok.status.should.equal(202);
    await waitJob(t.app, ok.body.jobId, 'tok-insights');

    await request(t.app).put('/aiinsights/settings').set('Authorization', 'Bearer tok-admin').send({ budget: { confirmBeforeCall: false, monthlyCapUsd: 0.5, hardBlock: true } });
    t.mongo.data.ai_usage.push({ month: t.service.usage.monthKey(new Date()), estimated_cost_usd: 0.6 });
    var blocked = await request(t.app).post('/aiinsights/trends').set('Authorization', 'Bearer tok-insights').send({ tab: 'weekly' });
    blocked.status.should.equal(402);
    blocked.body.message.should.equal('budget_exceeded');
  });

  it('serves trends from the daily cache and chat as a job', async function () {
    var t = build({ responseText: 'SUMMARY:\nYour TIR is **78%**.\nHIGHLIGHTS:\n- Overnight average **150 mg/dL**\n- Lows under **2%**' });
    await request(t.app).put('/aiinsights/settings').set('Authorization', 'Bearer tok-admin').send({ privacyAcknowledged: true });
    var first = await request(t.app).post('/aiinsights/trends').set('Authorization', 'Bearer tok-insights').send({ tab: 'weekly' });
    first.status.should.equal(202);
    var job = await waitJob(t.app, first.body.jobId, 'tok-insights');
    job.status.should.equal('done', JSON.stringify(job.error));
    job.result.summary.should.containEql('**78%**');
    job.result.highlights.length.should.equal(2);
    var cached = await request(t.app).post('/aiinsights/trends').set('Authorization', 'Bearer tok-insights').send({ tab: 'weekly' });
    cached.status.should.equal(200);
    cached.body.cached.should.equal(true);
    (await request(t.app).post('/aiinsights/trends').set('Authorization', 'Bearer tok-insights').send({ tab: 'stats' })).status.should.equal(400);

    var chat = await request(t.app).post('/aiinsights/chat').set('Authorization', 'Bearer tok-insights').send({ message: 'why am I high overnight?', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] });
    chat.status.should.equal(202);
    var cj = await waitJob(t.app, chat.body.jobId, 'tok-insights');
    cj.status.should.equal('done', JSON.stringify(cj.error));
    cj.result.reply.should.be.a.String();
    build.lastPrompt.user.should.containEql('CONVERSATION HISTORY:');
    build.lastPrompt.system.should.containEql('DATA:');
    build.lastPrompt.system.should.containEql('CURRENT THERAPY SETTINGS:');
    (await request(t.app).post('/aiinsights/chat').set('Authorization', 'Bearer tok-insights').send({ message: '' })).status.should.equal(400);
  });

  it('aggregates without a provider call and records caffeine/alcohol treatments', async function () {
    var t = build();
    var agg = await request(t.app).get('/aiinsights/aggregate?period=7').set('Authorization', 'Bearer tok-insights');
    agg.status.should.equal(200);
    agg.body.glucose.count.should.be.above(0);
    (agg.body.glucose.readings === undefined).should.equal(true);
    agg.body.score.grade.should.be.a.String();
    agg.body.settings.basal[0].value.should.equal(0.8);
    agg.body.period.timezone.should.equal('UTC');

    var caf = await request(t.app).post('/aiinsights/careportal').set('Authorization', 'Bearer tok-insights').send({ kind: 'caffeine', preset: 'Coffee (med)' });
    caf.status.should.equal(201);
    caf.body.eventType.should.equal('Caffeine');
    caf.body.caffeineMg.should.equal(142);
    var alc = await request(t.app).post('/aiinsights/careportal').set('Authorization', 'Bearer tok-insights').send({ kind: 'alcohol', amount: 2 });
    alc.body.drinks.should.equal(2);
    (await request(t.app).post('/aiinsights/careportal').set('Authorization', 'Bearer tok-insights').send({ kind: 'tea' })).status.should.equal(400);
  });

  it('rate limits the connection test', async function () {
    var t = build();
    var last;
    for (var i = 0; i < 11; i++) {
      last = await request(t.app).post('/aiinsights/settings/test-connection').set('Authorization', 'Bearer tok-admin').send({ });
    }
    last.status.should.equal(429);
    last.headers['retry-after'].should.be.a.String();
  });

  it('keeps the setting type list and labels in sync with the spec', function () {
    types.SETTING_TYPES.should.eql(['basal_rate', 'carb_ratio', 'insulin_sensitivity']);
  });
});
