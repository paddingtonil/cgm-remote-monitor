'use strict';

require('should');

const provider = require('../lib/aiinsights/provider');

const API_KEY = 'sk-test-SECRET-KEY-123456';

function fakeResponse (status, body, statusText) {
  return {
    ok: status >= 200 && status < 300
    , status: status
    , statusText: statusText || ''
    , json: async function json () {
      if (typeof body === 'string') {
        throw new SyntaxError('not json');
      }
      return body;
    }
    , text: async function text () {
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
  };
}

function fetchReturning (status, body, capture, statusText) {
  return async function fakeFetch (url, init) {
    if (capture) {
      capture.url = url;
      capture.init = init;
    }
    return fakeResponse(status, body, statusText);
  };
}

describe('aiinsights provider', function () {

  describe('detectFormat', function () {
    it('detects anthropic', function () {
      provider.detectFormat('https://api.anthropic.com/v1').should.equal('anthropic');
    });
    it('detects gemini via googleapis.com', function () {
      provider.detectFormat('https://generativelanguage.googleapis.com/v1beta').should.equal('gemini');
    });
    it('detects gemini via generativelanguage', function () {
      provider.detectFormat('https://generativelanguage.example/v1').should.equal('gemini');
    });
    it('defaults to openai', function () {
      provider.detectFormat('https://api.openai.com/v1').should.equal('openai');
      provider.detectFormat('https://my-azure.openai.azure.com/openai/deployments/x').should.equal('openai');
      provider.detectFormat(undefined).should.equal('openai');
    });
  });

  describe('effectiveConfig', function () {
    it('uses defaults when nothing is provided', function () {
      const cfg = provider.effectiveConfig();
      cfg.baseUrl.should.equal('https://api.openai.com/v1');
      cfg.model.should.equal('gpt-4o');
      cfg.format.should.equal('openai');
      cfg.endpointPath.should.equal('/chat/completions');
      cfg.apiKeyHeader.should.equal('Authorization');
      cfg.apiKeyPrefix.should.equal('Bearer ');
      cfg.maxTokens.should.equal(8192);
      cfg.temperature.should.equal(0.0);
      cfg.requestTimeoutMs.should.equal(60000);
      cfg.resourceTimeoutMs.should.equal(120000);
    });

    it('forces maxTokens 8192 and temperature 0.0 regardless of input', function () {
      const cfg = provider.effectiveConfig({ maxTokens: 100, temperature: 0.7 });
      cfg.maxTokens.should.equal(8192);
      cfg.temperature.should.equal(0.0);
      const cfg2 = provider.effectiveConfig({ maxTokens: 999999, temperature: 1.5 });
      cfg2.maxTokens.should.equal(8192);
      cfg2.temperature.should.equal(0.0);
    });

    it('fills anthropic defaults', function () {
      const cfg = provider.effectiveConfig({ baseUrl: 'https://api.anthropic.com/v1/' });
      cfg.baseUrl.should.equal('https://api.anthropic.com/v1');
      cfg.format.should.equal('anthropic');
      cfg.endpointPath.should.equal('/messages');
      cfg.apiKeyHeader.should.equal('x-api-key');
      cfg.apiKeyPrefix.should.equal('');
    });

    it('fills gemini defaults', function () {
      const cfg = provider.effectiveConfig({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
      cfg.format.should.equal('gemini');
      cfg.endpointPath.should.equal('/models/{MODEL}:generateContent');
      cfg.apiKeyHeader.should.equal('x-goog-api-key');
      cfg.apiKeyPrefix.should.equal('');
    });

    it('honours an explicit requestFormat override', function () {
      const cfg = provider.effectiveConfig({ baseUrl: 'https://proxy.example.com/v1', requestFormat: 'anthropic' });
      cfg.format.should.equal('anthropic');
      cfg.endpointPath.should.equal('/messages');
    });

    it('passes through endpointPath, apiVersion, organizationId, geminiGenerationConfig', function () {
      const cfg = provider.effectiveConfig({
        endpointPath: '/custom'
        , apiVersion: '2024-02-01'
        , organizationId: 'org-1'
        , geminiGenerationConfig: { thinkingConfig: { thinkingBudget: 1024 } }
      });
      cfg.endpointPath.should.equal('/custom');
      cfg.apiVersion.should.equal('2024-02-01');
      cfg.organizationId.should.equal('org-1');
      cfg.geminiGenerationConfig.should.deepEqual({ thinkingConfig: { thinkingBudget: 1024 } });
    });
  });

  describe('buildRequest', function () {
    it('builds the OpenAI body exactly per spec 3.3', function () {
      const cfg = provider.effectiveConfig({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' });
      const req = provider.buildRequest(cfg, API_KEY, 'SYS', 'USER');
      req.url.should.equal('https://api.openai.com/v1/chat/completions');
      req.headers['Content-Type'].should.equal('application/json');
      req.headers.Authorization.should.equal('Bearer ' + API_KEY);
      req.headers.should.not.have.property('OpenAI-Organization');
      req.body.should.deepEqual({
        model: 'gpt-4o'
        , messages: [
          { role: 'system', content: 'SYS' }
          , { role: 'user', content: 'USER' }
        ]
        , temperature: 0.0
        , max_tokens: 8192
      });
    });

    it('adds OpenAI-Organization header when organizationId is set', function () {
      const cfg = provider.effectiveConfig({ organizationId: 'org-abc' });
      const req = provider.buildRequest(cfg, API_KEY, 'S', 'U');
      req.headers['OpenAI-Organization'].should.equal('org-abc');
    });

    it('builds the Anthropic body exactly per spec 3.3', function () {
      const cfg = provider.effectiveConfig({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' });
      const req = provider.buildRequest(cfg, API_KEY, 'SYS', 'USER');
      req.url.should.equal('https://api.anthropic.com/v1/messages');
      req.headers['x-api-key'].should.equal(API_KEY);
      req.headers['anthropic-version'].should.equal('2023-06-01');
      req.headers['Content-Type'].should.equal('application/json');
      req.body.should.deepEqual({
        model: 'claude-sonnet-4-5'
        , system: [
          { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }
        ]
        , messages: [{ role: 'user', content: 'USER' }]
        , temperature: 0.0
        , max_tokens: 8192
      });
    });

    it('builds the Gemini body exactly per spec 3.3 with ?key=, header and {MODEL} substitution', function () {
      const cfg = provider.effectiveConfig({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/', model: 'gemini-2.0-flash' });
      const req = provider.buildRequest(cfg, API_KEY, 'SYS', 'USER');
      req.url.should.equal('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + API_KEY);
      req.headers['x-goog-api-key'].should.equal(API_KEY);
      req.headers['Content-Type'].should.equal('application/json');
      req.body.should.deepEqual({
        system_instruction: { parts: [{ text: 'SYS' }] }
        , contents: [{ role: 'user', parts: [{ text: 'USER' }] }]
        , generationConfig: { temperature: 0.0, maxOutputTokens: 8192, topP: 0.95, topK: 8 }
      });
    });

    it('merges geminiGenerationConfig and widens maxOutputTokens by thinkingBudget', function () {
      const cfg = provider.effectiveConfig({
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta'
        , model: 'gemini-3-pro'
        , geminiGenerationConfig: { thinkingConfig: { thinkingBudget: 2048, includeThoughts: false }, topK: 40 }
      });
      const req = provider.buildRequest(cfg, API_KEY, 'S', 'U');
      req.body.generationConfig.should.deepEqual({
        temperature: 0.0
        , maxOutputTokens: 8192 + 2048
        , topP: 0.95
        , topK: 40
        , thinkingConfig: { thinkingBudget: 2048, includeThoughts: false }
      });
    });

    it('does not widen when thinkingBudget is not a positive number', function () {
      const cfg = provider.effectiveConfig({
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta'
        , geminiGenerationConfig: { thinkingConfig: { thinkingBudget: 0 } }
      });
      const req = provider.buildRequest(cfg, API_KEY, 'S', 'U');
      req.body.generationConfig.maxOutputTokens.should.equal(8192);
    });

    it('appends Azure api-version query (and uses & when a query already exists)', function () {
      const cfg = provider.effectiveConfig({
        baseUrl: 'https://my.openai.azure.com/openai/deployments/gpt4o'
        , apiVersion: '2024-02-01'
      });
      const req = provider.buildRequest(cfg, API_KEY, 'S', 'U');
      req.url.should.equal('https://my.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-02-01');

      const gcfg = provider.effectiveConfig({
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta'
        , model: 'm'
        , apiVersion: 'x'
      });
      const greq = provider.buildRequest(gcfg, API_KEY, 'S', 'U');
      greq.url.should.equal('https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?key=' + API_KEY + '&api-version=x');
    });

    it('clamps maxTokens to 8192 and honours smaller values', function () {
      const cfg = provider.effectiveConfig({});
      provider.buildRequest(cfg, API_KEY, 'S', 'U', 128).body.max_tokens.should.equal(128);
      provider.buildRequest(cfg, API_KEY, 'S', 'U', 50000).body.max_tokens.should.equal(8192);
      provider.buildRequest(cfg, API_KEY, 'S', 'U', undefined).body.max_tokens.should.equal(8192);
    });

    it('trims trailing slashes from baseUrl', function () {
      const cfg = provider.effectiveConfig({ baseUrl: 'https://api.openai.com/v1///' });
      provider.buildRequest(cfg, API_KEY, 'S', 'U').url.should.equal('https://api.openai.com/v1/chat/completions');
    });
  });

  describe('extractText', function () {
    it('stage 1: gemini picks the last non-thought part', function () {
      const json = {
        candidates: [{
          content: {
            parts: [
              { text: 'thinking...', thought: true }
              , { text: 'first visible' }
              , { text: 'final answer' }
              , { text: 'more thinking', thought: true }
            ]
          }
        }]
      };
      provider.extractText('gemini', json).should.equal('final answer');
    });

    it('stage 1: throws EmptyThinkingResponseError when only thoughts and thoughtsTokenCount > 0', function () {
      const json = {
        candidates: [{ content: { parts: [{ text: 'thinking', thought: true }] } }]
        , usageMetadata: { thoughtsTokenCount: 500 }
      };
      (function () { provider.extractText('gemini', json); }).should.throw(provider.EmptyThinkingResponseError);
    });

    it('stage 1: falls through when only thoughts but thoughtsTokenCount is 0', function () {
      const json = {
        candidates: [{ content: { parts: [{ text: 'thinking', thought: true }] } }]
        , usageMetadata: { thoughtsTokenCount: 0 }
        , other: { text: 'elsewhere' }
      };
      provider.extractText('gemini', json).should.equal('elsewhere');
    });

    it('stage 2: openai key path', function () {
      provider.extractText('openai', { choices: [{ message: { content: 'hello' } }] }).should.equal('hello');
    });

    it('stage 2: anthropic key path', function () {
      provider.extractText('anthropic', { content: [{ type: 'text', text: 'hi there' }] }).should.equal('hi there');
    });

    it('stage 2: gemini key path', function () {
      provider.extractText('gemini', { candidates: [{ content: { parts: [{ text: 'gem' }] } }] }).should.equal('gem');
    });

    it('stage 3: deep search prefers a text containing { or suggestions', function () {
      const json = {
        weird: { nested: [{ text: 'a much much much longer plain string without braces at all' }] }
        , other: { text: '{"suggestions":[]}' }
        , skipped: { text: '{ thought }', thought: true }
      };
      provider.extractText('openai', json).should.equal('{"suggestions":[]}');
    });

    it('stage 3: deep search falls back to the longest text', function () {
      const json = {
        a: { text: 'short' }
        , b: { text: 'the longest one here' }
        , c: { text: 'medium length' }
      };
      provider.extractText('anthropic', json).should.equal('the longest one here');
    });

    it('stage 4: falls back to JSON.stringify', function () {
      const json = { foo: 'bar', n: 1 };
      provider.extractText('openai', json).should.equal(JSON.stringify(json));
      provider.extractText('openai', null).should.equal('null');
      provider.extractText('openai', 'plain body').should.equal('"plain body"');
    });
  });

  describe('extractUsage', function () {
    it('openai', function () {
      provider.extractUsage('openai', { usage: { prompt_tokens: 10, completion_tokens: 20 } })
        .should.deepEqual({ inputTokens: 10, outputTokens: 20 });
    });
    it('anthropic', function () {
      provider.extractUsage('anthropic', { usage: { input_tokens: 11, output_tokens: 22 } })
        .should.deepEqual({ inputTokens: 11, outputTokens: 22 });
    });
    it('gemini', function () {
      provider.extractUsage('gemini', { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 24 } })
        .should.deepEqual({ inputTokens: 12, outputTokens: 24 });
    });
    it('returns nulls when missing', function () {
      provider.extractUsage('openai', {}).should.deepEqual({ inputTokens: null, outputTokens: null });
      provider.extractUsage('gemini', null).should.deepEqual({ inputTokens: null, outputTokens: null });
    });
  });

  describe('isPrivateAddress', function () {
    it('flags private IPv4 ranges', function () {
      ['127.0.0.1', '127.255.255.255', '10.0.0.1', '10.255.1.1', '172.16.0.1', '172.31.255.254'
        , '192.168.1.1', '169.254.169.254', '0.0.0.0', '0.1.2.3', 'localhost'].forEach(function check (ip) {
        provider.isPrivateAddress(ip).should.equal(true, ip + ' should be private');
      });
    });
    it('allows public IPv4', function () {
      ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.167.1.1', '1.1.1.1', '104.18.0.1'].forEach(function check (ip) {
        provider.isPrivateAddress(ip).should.equal(false, ip + ' should be public');
      });
    });
    it('flags private IPv6 ranges', function () {
      ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', '[::1]', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'fe80::1%lo0']
        .forEach(function check (ip) {
          provider.isPrivateAddress(ip).should.equal(true, ip + ' should be private');
        });
    });
    it('allows public IPv6', function () {
      ['2001:4860:4860::8888', '2606:4700::1111', '::ffff:8.8.8.8', 'fec0::1'].forEach(function check (ip) {
        provider.isPrivateAddress(ip).should.equal(false, ip + ' should be public');
      });
    });
    it('handles garbage', function () {
      provider.isPrivateAddress('').should.equal(false);
      provider.isPrivateAddress(null).should.equal(false);
      provider.isPrivateAddress('not-an-ip').should.equal(false);
    });
  });

  describe('assertUrlAllowed', function () {
    it('rejects http', async function () {
      await provider.assertUrlAllowed('http://1.1.1.1/v1', {}).should.be.rejectedWith(provider.UrlNotAllowedError);
    });
    it('rejects non-url strings', async function () {
      await provider.assertUrlAllowed('nonsense', {}).should.be.rejectedWith(provider.UrlNotAllowedError);
    });
    it('rejects 127.0.0.1 literal', async function () {
      await provider.assertUrlAllowed('https://127.0.0.1/v1', {}).should.be.rejectedWith(provider.UrlNotAllowedError);
    });
    it('rejects private literal IPs and localhost', async function () {
      await provider.assertUrlAllowed('https://10.1.2.3/v1', {}).should.be.rejectedWith(provider.UrlNotAllowedError);
      await provider.assertUrlAllowed('https://[::1]/v1', {}).should.be.rejectedWith(provider.UrlNotAllowedError);
      await provider.assertUrlAllowed('https://localhost/v1', {}).should.be.rejectedWith(provider.UrlNotAllowedError);
      await provider.assertUrlAllowed('https://169.254.169.254/latest', {}).should.be.rejectedWith(provider.UrlNotAllowedError);
    });
    it('allows a public literal IP over https', async function () {
      await provider.assertUrlAllowed('https://1.1.1.1/v1', {});
    });
    it('allows http and private IPs when allowPrivateUrl', async function () {
      await provider.assertUrlAllowed('http://127.0.0.1:11434/v1', { allowPrivateUrl: true });
      await provider.assertUrlAllowed('https://192.168.1.10/v1', { allowPrivateUrl: true });
      await provider.assertUrlAllowed('http://localhost:8080/v1', { allowPrivateUrl: true });
    });
    it('still rejects non-http(s) protocols with allowPrivateUrl', async function () {
      await provider.assertUrlAllowed('ftp://1.1.1.1/v1', { allowPrivateUrl: true }).should.be.rejectedWith(provider.UrlNotAllowedError);
    });
  });

  describe('sendPrompt', function () {
    const cfg = provider.effectiveConfig({ baseUrl: 'https://1.1.1.1/v1', model: 'gpt-4o' });

    it('happy path returns text, usage, status and latency', async function () {
      const capture = {};
      const result = await provider.sendPrompt(cfg, API_KEY, 'SYS', 'USER', {
        fetchImpl: fetchReturning(200, {
          choices: [{ message: { content: 'OK' } }]
          , usage: { prompt_tokens: 5, completion_tokens: 1 }
        }, capture)
      });
      result.text.should.equal('OK');
      result.usage.should.deepEqual({ inputTokens: 5, outputTokens: 1 });
      result.status.should.equal(200);
      result.latencyMs.should.be.a.Number();
      capture.url.should.equal('https://1.1.1.1/v1/chat/completions');
      capture.init.method.should.equal('POST');
      capture.init.redirect.should.equal('error');
      capture.init.headers.Authorization.should.equal('Bearer ' + API_KEY);
      capture.init.signal.should.be.ok();
      JSON.parse(capture.init.body).messages[1].content.should.equal('USER');
    });

    it('respects maxTokens option', async function () {
      const capture = {};
      await provider.sendPrompt(cfg, API_KEY, 'S', 'U', {
        maxTokens: 256
        , fetchImpl: fetchReturning(200, { choices: [{ message: { content: 'x' } }] }, capture)
      });
      JSON.parse(capture.init.body).max_tokens.should.equal(256);
    });

    it('throws ProviderError with status and message that never contains the key', async function () {
      const fetchImpl = fetchReturning(401, {
        error: { message: 'Incorrect API key provided: ' + API_KEY + '. You can find your key at ...', type: 'invalid_request_error' }
      }, null, 'Unauthorized');
      let caught = null;
      try {
        await provider.sendPrompt(cfg, API_KEY, 'S', 'U', { fetchImpl: fetchImpl });
      } catch (err) {
        caught = err;
      }
      (caught instanceof provider.ProviderError).should.equal(true);
      caught.name.should.equal('ProviderError');
      caught.status.should.equal(401);
      caught.message.indexOf(API_KEY).should.equal(-1);
      caught.message.should.containEql('Incorrect API key provided');
    });

    it('falls back to statusText when the body is not JSON', async function () {
      let caught = null;
      try {
        await provider.sendPrompt(cfg, API_KEY, 'S', 'U', {
          fetchImpl: fetchReturning(502, '<html>Bad Gateway</html>', null, 'Bad Gateway')
        });
      } catch (err) {
        caught = err;
      }
      caught.status.should.equal(502);
      caught.message.should.be.a.String();
      caught.message.length.should.be.above(0);
    });

    it('uses json.message when error object is absent', async function () {
      let caught = null;
      try {
        await provider.sendPrompt(cfg, API_KEY, 'S', 'U', {
          fetchImpl: fetchReturning(500, { message: 'boom' })
        });
      } catch (err) {
        caught = err;
      }
      caught.message.should.equal('boom');
    });

    it('rejects a private URL before calling fetch', async function () {
      let called = false;
      const privateCfg = provider.effectiveConfig({ baseUrl: 'https://127.0.0.1/v1' });
      await provider.sendPrompt(privateCfg, API_KEY, 'S', 'U', {
        fetchImpl: async function neverFetch () { called = true; return fakeResponse(200, {}); }
      }).should.be.rejectedWith(provider.UrlNotAllowedError);
      called.should.equal(false);
    });

    it('allows a private URL when allowPrivateUrl is set', async function () {
      const privateCfg = provider.effectiveConfig({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3' });
      const result = await provider.sendPrompt(privateCfg, '', 'S', 'U', {
        allowPrivateUrl: true
        , fetchImpl: fetchReturning(200, { choices: [{ message: { content: 'local' } }] })
      });
      result.text.should.equal('local');
    });

    it('wraps fetch failures in ProviderError without leaking the key', async function () {
      let caught = null;
      try {
        await provider.sendPrompt(cfg, API_KEY, 'S', 'U', {
          fetchImpl: async function failingFetch () { throw new Error('connect ECONNREFUSED ' + API_KEY); }
        });
      } catch (err) {
        caught = err;
      }
      (caught instanceof provider.ProviderError).should.equal(true);
      caught.status.should.equal(0);
      caught.message.indexOf(API_KEY).should.equal(-1);
    });

    it('aborts when the external signal is aborted', async function () {
      const controller = new AbortController();
      let caught = null;
      try {
        await provider.sendPrompt(cfg, API_KEY, 'S', 'U', {
          signal: controller.signal
          , fetchImpl: function abortableFetch (url, init) {
            return new Promise(function waitForAbort (resolve, reject) {
              init.signal.addEventListener('abort', function onAbort () {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              });
              controller.abort();
            });
          }
        });
      } catch (err) {
        caught = err;
      }
      (caught instanceof provider.ProviderError).should.equal(true);
    });

    it('propagates EmptyThinkingResponseError for gemini', async function () {
      const gcfg = provider.effectiveConfig({ baseUrl: 'https://1.1.1.1/v1beta', requestFormat: 'gemini', model: 'gemini-3-pro' });
      await provider.sendPrompt(gcfg, API_KEY, 'S', 'U', {
        fetchImpl: fetchReturning(200, {
          candidates: [{ content: { parts: [{ text: 't', thought: true }] } }]
          , usageMetadata: { thoughtsTokenCount: 8192 }
        })
      }).should.be.rejectedWith(provider.EmptyThinkingResponseError);
    });
  });

  describe('testConnection', function () {
    const cfg = provider.effectiveConfig({ baseUrl: 'https://1.1.1.1/v1' });

    it('sends the spec test prompts with maxTokens 128 and returns ok for 200', async function () {
      const capture = {};
      const result = await provider.testConnection(cfg, API_KEY, {
        fetchImpl: fetchReturning(200, { choices: [{ message: { content: 'OK' } }] }, capture)
      });
      result.ok.should.equal(true);
      result.status.should.equal(200);
      result.latencyMs.should.be.a.Number();
      result.message.should.be.a.String();
      const body = JSON.parse(capture.init.body);
      body.messages[0].content.should.equal('You are a test.');
      body.messages[1].content.should.equal('Reply with exactly: OK');
      body.max_tokens.should.equal(128);
    });

    it('treats 402 as ok (key valid, billing limited)', async function () {
      const result = await provider.testConnection(cfg, API_KEY, {
        fetchImpl: fetchReturning(402, { error: { message: 'Payment required' } })
      });
      result.ok.should.equal(true);
      result.status.should.equal(402);
      result.message.should.containEql('quota or billing');
    });

    it('treats 429 as ok (key valid, quota limited)', async function () {
      const result = await provider.testConnection(cfg, API_KEY, {
        fetchImpl: fetchReturning(429, { error: { message: 'Rate limit' } })
      });
      result.ok.should.equal(true);
      result.status.should.equal(429);
    });

    it('returns ok false for 401 without throwing and without the key', async function () {
      const result = await provider.testConnection(cfg, API_KEY, {
        fetchImpl: fetchReturning(401, { error: { message: 'bad key ' + API_KEY } })
      });
      result.ok.should.equal(false);
      result.status.should.equal(401);
      result.message.indexOf(API_KEY).should.equal(-1);
    });

    it('returns ok false for disallowed URLs', async function () {
      const result = await provider.testConnection(provider.effectiveConfig({ baseUrl: 'http://1.1.1.1/v1' }), API_KEY, {
        fetchImpl: fetchReturning(200, {})
      });
      result.ok.should.equal(false);
      result.status.should.equal(0);
    });
  });

  describe('redactKey', function () {
    it('replaces every occurrence of the key', function () {
      provider.redactKey('a ' + API_KEY + ' b ' + API_KEY, API_KEY).should.equal('a [REDACTED] b [REDACTED]');
    });
    it('is a no-op for empty keys and handles non-strings', function () {
      provider.redactKey('abc', '').should.equal('abc');
      provider.redactKey('abc', null).should.equal('abc');
      provider.redactKey(null, API_KEY).should.equal('');
    });
  });

  describe('errors', function () {
    it('exposes error classes with names', function () {
      new provider.ProviderError(500, 'x').name.should.equal('ProviderError');
      new provider.ProviderError(500, 'x').status.should.equal(500);
      new provider.EmptyThinkingResponseError().name.should.equal('EmptyThinkingResponseError');
      new provider.UrlNotAllowedError().name.should.equal('UrlNotAllowedError');
      (new provider.ProviderError(1) instanceof Error).should.equal(true);
    });
  });
});
