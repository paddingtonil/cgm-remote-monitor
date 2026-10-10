'use strict';

require('should');

describe('aiinsights infrastructure', function () {

  describe('config', function () {
    var config = require('../lib/aiinsights/config');

    it('merges spec defaults <- env defaults <- stored doc', function () {
      var envCfg = config.envConfig({ extendedSettings: { aiinsights: { analysisPeriod: 30, personality: 'tough_love' } } });
      var merged = config.mergeSettings({ tightRangeUpperBound: 150, features: { foodResponse: true, mealDebrief: true } }, envCfg);
      merged.analysisPeriod.should.equal(30);
      merged.aiPersonality.should.equal('tough_love');
      merged.tightRangeUpperBound.should.equal(150);
      merged.features.mealDebrief.should.equal(true);
      merged.features.circadian.should.equal(false);
      merged.budget.warnPercent.should.equal(80);
    });

    it('forces dependent meal features off without foodResponse', function () {
      var merged = config.mergeSettings({ features: { mealDebrief: true, preMealAdvisor: true } }, config.envConfig({ }));
      merged.features.mealDebrief.should.equal(false);
      merged.features.preMealAdvisor.should.equal(false);
    });

    it('defaults the provider to Gemini and parses the generation config JSON', function () {
      var envCfg = config.envConfig({ extendedSettings: { aiinsights: { geminiGenerationConfig: '{"thinkingConfig":{"thinkingBudget":1024}}' } } });
      envCfg.provider.model.should.equal('gemini-3.8-flash');
      envCfg.provider.baseUrl.should.containEql('generativelanguage.googleapis.com');
      envCfg.provider.geminiGenerationConfig.thinkingConfig.thinkingBudget.should.equal(1024);
      (config.envConfig({ extendedSettings: { aiinsights: { geminiGenerationConfig: 'not json' } } }).provider.geminiGenerationConfig === null).should.equal(true);
    });

    it('never exposes an apiKey through envConfig', function () {
      var envCfg = config.envConfig({ extendedSettings: { aiinsights: { apiKey: 'leaked' } } });
      JSON.stringify(envCfg).should.not.containEql('leaked');
    });

    it('validates patches field by field', function () {
      var ok = config.validatePatch({ analysisPeriod: 7, aiPersonality: 'dry_wit', tightRangeUpperBound: 145
        , features: { circadian: true }, monitor: { frequency: '12h', quietHours: { start: 23 } }
        , budget: { monthlyCapUsd: 5, warnPercent: 50 }, sleepSchedule: { bedHour: 23 }, privacyAcknowledged: true });
      ok.ok.should.equal(true);
      ok.value.tightRangeUpperBound.should.equal(145);
      ok.value.monitor.quietHours.start.should.equal(23);
      ok.value.privacyAcknowledgedAt.should.be.a.String();

      var bad = config.validatePatch({ analysisPeriod: 10, aiPersonality: 'rude', tightRangeUpperBound: 143
        , features: { circadian: 'yes' }, budget: { warnPercent: 150 }, sleepSchedule: { wakeHour: 25 } });
      bad.ok.should.equal(false);
      bad.errors.length.should.equal(6);
      Object.keys(bad.value.features).length.should.equal(0);
    });

    it('rejects a non-object body', function () {
      config.validatePatch('x').ok.should.equal(false);
    });
  });

  describe('jobs', function () {
    var createJobs = require('../lib/aiinsights/jobs');

    function wait (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

    it('runs one job at a time and exposes progress/result', async function () {
      var jobs = createJobs({ concurrency: 1, log: false });
      var order = [];
      var a = jobs.submit({ kind: 'a', run: async function (h) { h.progress('half'); await wait(20); order.push('a'); return 1; } });
      var b = jobs.submit({ kind: 'b', run: async function () { order.push('b'); return 2; } });
      jobs.get(a.jobId).status.should.equal('running');
      jobs.get(b.jobId).status.should.equal('queued');
      await wait(5);
      jobs.get(a.jobId).progress.should.equal('half');
      await wait(50);
      order.should.eql(['a', 'b']);
      jobs.get(a.jobId).status.should.equal('done');
      jobs.get(a.jobId).result.should.equal(1);
      jobs.get(b.jobId).result.should.equal(2);
    });

    it('records failures without leaking the stack and dedupes by key', async function () {
      var jobs = createJobs({ log: false });
      var first = jobs.submit({ kind: 'x', key: 'k', run: async function () { await wait(20); throw Object.assign(new Error('boom'), { status: 502 }); } });
      var dup = jobs.submit({ kind: 'x', key: 'k', run: async function () { return 'never'; } });
      dup.jobId.should.equal(first.jobId);
      dup.deduplicated.should.equal(true);
      await wait(40);
      var view = jobs.get(first.jobId);
      view.status.should.equal('failed');
      view.error.message.should.equal('boom');
      view.error.status.should.equal(502);
      (view.result === undefined).should.equal(true);
    });

    it('expires finished jobs after the TTL', async function () {
      var t = 1000;
      var jobs = createJobs({ ttlMs: 100, now: function () { return t; }, log: false });
      var j = jobs.submit({ kind: 'x', run: async function () { return 1; } });
      await wait(5);
      jobs.get(j.jobId).status.should.equal('done');
      t += 200;
      jobs.cleanup();
      (jobs.get(j.jobId) === null).should.equal(true);
    });
  });

  describe('ratelimit', function () {
    var createRateLimiter = require('../lib/aiinsights/ratelimit');

    it('allows max calls per window then answers 429 with Retry-After', function () {
      var t = 0;
      var limiter = createRateLimiter({ now: function () { return t; } });
      var limit = { max: 2, windowMs: 1000 };
      limiter.check('a', 'ip1', limit).allowed.should.equal(true);
      limiter.check('a', 'ip1', limit).allowed.should.equal(true);
      var third = limiter.check('a', 'ip1', limit);
      third.allowed.should.equal(false);
      third.retryAfterSeconds.should.equal(1);
      limiter.check('a', 'ip2', limit).allowed.should.equal(true);
      limiter.check('b', 'ip1', limit).allowed.should.equal(true);
      t = 1001;
      limiter.check('a', 'ip1', limit).allowed.should.equal(true);
    });

    it('works as express middleware', function (done) {
      var limiter = createRateLimiter();
      var mw = limiter.middleware('m', { max: 1, windowMs: 60000 });
      var req = { ip: '1.2.3.4' };
      var headers = { };
      var res = { set: function (k, v) { headers[k] = v; }, status: function (s) { this.code = s; return this; }, json: function (body) { this.body = body; } };
      mw(req, res, function () {
        mw(req, res, function () { done(new Error('second call should be limited')); });
        res.code.should.equal(429);
        headers['Retry-After'].should.equal('60');
        done();
      });
    });
  });

  describe('store', function () {
    var createStore = require('../lib/server/aiinsights-store');

    function fakeCollections () {
      var calls = [];
      function col (name) {
        return {
          findOne: async function (q) { calls.push([name, 'findOne', q]); return null; }
          , replaceOne: async function (q, doc, opts) { calls.push([name, 'replaceOne', q, doc, opts]); return { }; }
          , insertOne: async function (doc) { calls.push([name, 'insertOne', doc]); return { insertedId: 'id1' }; }
          , insertMany: async function (docs) { calls.push([name, 'insertMany', docs]); return { }; }
          , updateMany: async function (q, u) { calls.push([name, 'updateMany', q, u]); return { modifiedCount: 2 }; }
          , findOneAndUpdate: async function (q, u, o) { calls.push([name, 'findOneAndUpdate', q, u, o]); return { value: { record_id: 'r', status: u.$set.status } }; }
          , find: function (q) { calls.push([name, 'find', q]); return { sort: function () { return { limit: function () { return { toArray: async function () { return []; } }; } }; } }; }
          , aggregate: function () { return { toArray: async function () { return [{ total: 1.5, count: 3 }]; } }; }
          , createIndex: async function (spec, opts) { calls.push([name, 'createIndex', spec, opts]); }
        };
      }
      return { col: col, calls: calls };
    }

    function makeStore (fake) {
      var env = { ai_suggestions_collection: 's', ai_analyses_collection: 'a', ai_usage_collection: 'u', ai_settings_collection: 'c' };
      var ctx = { store: { collection: fake.col, ensureIndexes: function () { fake.calls.push(['ensureIndexes']); } }, purifier: { purifyObject: function (d) { d.__purified = true; } } };
      return createStore(env, ctx);
    }

    it('saves settings as the single default document', async function () {
      var fake = fakeCollections();
      var store = makeStore(fake);
      var saved = await store.saveSettings({ analysisPeriod: 7 });
      saved._id.should.equal('default');
      saved.modified_at.should.be.a.String();
      saved.__purified.should.equal(true);
      var call = fake.calls.find(function (c) { return c[1] === 'replaceOne'; });
      call[0].should.equal('c');
      call[4].upsert.should.equal(true);
    });

    it('adds expires_at only to cache-like analyses', async function () {
      var fake = fakeCollections();
      var store = makeStore(fake);
      var chat = await store.insertAnalysis({ kind: 'chat' });
      chat.expires_at.should.be.instanceOf(Date);
      var settings = await store.insertAnalysis({ kind: 'settings' });
      (settings.expires_at === undefined).should.equal(true);
      String(settings._id).should.equal('id1');
    });

    it('stamps suggestions and supersedes pending ones', async function () {
      var fake = fakeCollections();
      var store = makeStore(fake);
      var docs = await store.insertSuggestions([{ record_id: 'r1', setting_type: 'basal_rate' }]);
      docs[0].status.should.equal('pending');
      docs[0].created_at.should.be.a.String();
      var n = await store.supersedePending('basal_rate', ['keep']);
      n.should.equal(2);
      var upd = fake.calls.find(function (c) { return c[1] === 'updateMany'; });
      upd[2].should.eql({ setting_type: 'basal_rate', status: 'pending', record_id: { $nin: ['keep'] } });
      upd[3].$set.status.should.equal('superseded');
    });

    it('never lets a patch change _id or record_id and sums monthly spend', async function () {
      var fake = fakeCollections();
      var store = makeStore(fake);
      var updated = await store.updateSuggestion('r', { status: 'applied', _id: 'evil', record_id: 'evil' });
      updated.status.should.equal('applied');
      var call = fake.calls.find(function (c) { return c[1] === 'findOneAndUpdate'; });
      (call[3].$set._id === undefined).should.equal(true);
      (call[3].$set.record_id === undefined).should.equal(true);
      var spent = await store.monthSpent('2026-10');
      spent.totalUsd.should.equal(1.5);
      spent.count.should.equal(3);
    });

    it('creates the unique record_id and TTL indexes', function () {
      var fake = fakeCollections();
      var store = makeStore(fake);
      store.ensureIndexes();
      var unique = fake.calls.find(function (c) { return c[1] === 'createIndex' && c[2].record_id === 1; });
      unique[3].unique.should.equal(true);
      var ttl = fake.calls.find(function (c) { return c[1] === 'createIndex' && c[2].expires_at === 1; });
      ttl[3].expireAfterSeconds.should.equal(0);
    });
  });

  describe('env / enclave', function () {
    it('keeps the AI key in the enclave and out of the environment', function () {
      var enclave = require('../lib/server/enclave')();
      enclave.isAiApiKeySet().should.equal(false);
      enclave.setAiApiKey('sk-test');
      enclave.isAiApiKeySet().should.equal(true);
      enclave.withAiApiKey(function (k) { return k; }).should.equal('sk-test');
      JSON.stringify(enclave).should.not.containEql('sk-test');
    });

    it('removes AIINSIGHTS_API_KEY from process.env and extended settings', function () {
      var saved = Object.assign({ }, process.env);
      process.env.ENABLE = 'aiinsights';
      process.env.AIINSIGHTS_API_KEY = 'sk-secret-value';
      process.env.AIINSIGHTS_MODEL = 'gemini-3.8-flash';
      process.env.AIINSIGHTS_PRIVACY_ACK = 'true';
      process.env.API_SECRET = 'abcdefghij123';
      delete require.cache[require.resolve('../lib/server/env')];
      var env = require('../lib/server/env')();
      (process.env.AIINSIGHTS_API_KEY === undefined).should.equal(true);
      env.enclave.isAiApiKeySet().should.equal(true);
      env.extendedSettings.aiinsights.model.should.equal('gemini-3.8-flash');
      env.extendedSettings.aiinsights.privacyAck.should.equal(true);
      (env.extendedSettings.aiinsights.apiKey === undefined).should.equal(true);
      JSON.stringify(env.extendedSettings).should.not.containEql('sk-secret-value');
      env.ai_suggestions_collection.should.equal('ai_suggestions');
      // restore
      Object.keys(process.env).forEach(function (k) { if (!(k in saved)) { delete process.env[k]; } });
      Object.assign(process.env, saved);
      delete require.cache[require.resolve('../lib/server/env')];
    });

    it('strips apiKey from filtered settings as defence in depth', function () {
      var settings = require('../lib/settings')();
      var filtered = settings.filteredSettings({ enable: [], extendedSettings: { aiinsights: { apiKey: 'x', model: 'm' } } });
      (filtered.extendedSettings.aiinsights.apiKey === undefined).should.equal(true);
      filtered.extendedSettings.aiinsights.model.should.equal('m');
    });
  });
});
