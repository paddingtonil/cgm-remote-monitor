'use strict';

// AI provider adapter for the AI Insights plugin.
// Implements spec sections 3.1-3.5 (provider configuration, request shapes,
// response text extraction, connection test) and design doc 8 / 11.2 (SSRF).
//
// The API key must never be logged, stored, or echoed in error messages.
// Prompt bodies are never logged by this module.

const dns = require('dns');
const net = require('net');

const FORMATS = {
  OPENAI: 'openai'
  , ANTHROPIC: 'anthropic'
  , GEMINI: 'gemini'
};

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1'
  , model: 'gpt-4o'
  , maxTokens: 8192
  , temperature: 0.0
  , requestTimeoutMs: 60000
  , resourceTimeoutMs: 120000
};

const MAX_TOKENS_HARD_CAP = 8192;
const ANTHROPIC_VERSION = '2023-06-01';
const TEST_SYSTEM_PROMPT = 'You are a test.';
const TEST_USER_PROMPT = 'Reply with exactly: OK';
const TEST_MAX_TOKENS = 128;

const DEFAULT_PATH = {
  openai: '/chat/completions'
  , anthropic: '/messages'
  , gemini: '/models/{MODEL}:generateContent'
};

const DEFAULT_KEY_HEADER = {
  openai: 'Authorization'
  , anthropic: 'x-api-key'
  , gemini: 'x-goog-api-key'
};

const DEFAULT_KEY_PREFIX = {
  openai: 'Bearer '
  , anthropic: ''
  , gemini: ''
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class ProviderError extends Error {
  constructor (status, message) {
    super(message || ('Provider request failed with status ' + status));
    this.name = 'ProviderError';
    this.status = status;
  }
}

class EmptyThinkingResponseError extends Error {
  constructor (message) {
    super(message || 'Model returned only thinking tokens and no visible answer; increase maxOutputTokens or reduce thinkingBudget');
    this.name = 'EmptyThinkingResponseError';
  }
}

class UrlNotAllowedError extends Error {
  constructor (message) {
    super(message || 'Provider URL is not allowed');
    this.name = 'UrlNotAllowedError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function redactKey (str, apiKey) {
  const text = (str === undefined || str === null) ? '' : String(str);
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length === 0) {
    return text;
  }
  return text.split(apiKey).join('[REDACTED]');
}

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trimTrailingSlash (url) {
  let out = String(url || '');
  while (out.length > 1 && out.endsWith('/')) {
    out = out.slice(0, -1);
  }
  return out;
}

function appendQuery (url, key, value) {
  const separator = url.indexOf('?') >= 0 ? '&' : '?';
  return url + separator + key + '=' + encodeURIComponent(value);
}

// ---------------------------------------------------------------------------
// Configuration (spec 3.1 / 3.2)
// ---------------------------------------------------------------------------

function detectFormat (baseUrl) {
  const url = String(baseUrl || '').toLowerCase();
  if (url.indexOf('anthropic.com') >= 0) {
    return FORMATS.ANTHROPIC;
  }
  if (url.indexOf('googleapis.com') >= 0 || url.indexOf('generativelanguage') >= 0) {
    return FORMATS.GEMINI;
  }
  return FORMATS.OPENAI;
}

function normalizeFormat (requested, baseUrl) {
  const value = String(requested || '').toLowerCase();
  if (value === FORMATS.ANTHROPIC || value === FORMATS.GEMINI || value === FORMATS.OPENAI) {
    return value;
  }
  return detectFormat(baseUrl);
}

function effectiveConfig (overrides) {
  const input = isObject(overrides) ? overrides : {};
  const baseUrl = trimTrailingSlash(input.baseUrl || DEFAULTS.baseUrl);
  const format = normalizeFormat(input.requestFormat || input.format, baseUrl);

  return {
    baseUrl: baseUrl
    , format: format
    , model: input.model || DEFAULTS.model
    , endpointPath: input.endpointPath || DEFAULT_PATH[format]
    , apiKeyHeader: input.apiKeyHeader || DEFAULT_KEY_HEADER[format]
    , apiKeyPrefix: (typeof input.apiKeyPrefix === 'string') ? input.apiKeyPrefix : DEFAULT_KEY_PREFIX[format]
    , maxTokens: MAX_TOKENS_HARD_CAP // always enforced, spec 3.1
    , temperature: 0.0 // always enforced, spec 3.1
    , apiVersion: input.apiVersion || null
    , organizationId: input.organizationId || null
    , geminiGenerationConfig: isObject(input.geminiGenerationConfig) ? input.geminiGenerationConfig : null
    , requestTimeoutMs: Number(input.requestTimeoutMs) > 0 ? Number(input.requestTimeoutMs) : DEFAULTS.requestTimeoutMs
    , resourceTimeoutMs: Number(input.resourceTimeoutMs) > 0 ? Number(input.resourceTimeoutMs) : DEFAULTS.resourceTimeoutMs
  };
}

// ---------------------------------------------------------------------------
// Request building (spec 3.3)
// ---------------------------------------------------------------------------

function clampMaxTokens (requested, cfg) {
  const wanted = Number(requested) > 0 ? Number(requested) : (cfg && cfg.maxTokens) || MAX_TOKENS_HARD_CAP;
  return Math.min(Math.floor(wanted), MAX_TOKENS_HARD_CAP);
}

function buildRequest (cfg, apiKey, systemPrompt, userPrompt, maxTokens) {
  const config = effectiveConfig(cfg);
  const format = config.format;
  const tokens = clampMaxTokens(maxTokens, config);
  const key = apiKey === undefined || apiKey === null ? '' : String(apiKey);
  const system = systemPrompt === undefined || systemPrompt === null ? '' : String(systemPrompt);
  const user = userPrompt === undefined || userPrompt === null ? '' : String(userPrompt);

  const headers = {
    'Content-Type': 'application/json'
  };
  headers[config.apiKeyHeader] = config.apiKeyPrefix + key;

  let path = String(config.endpointPath || '');
  if (path && path[0] !== '/') {
    path = '/' + path;
  }
  let url = config.baseUrl + path;
  let body;

  if (format === FORMATS.ANTHROPIC) {
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    body = {
      model: config.model
      , system: [
        { type: 'text', text: system, cache_control: { type: 'ephemeral' } }
      ]
      , messages: [{ role: 'user', content: user }]
      , temperature: 0.0
      , max_tokens: tokens
    };
  } else if (format === FORMATS.GEMINI) {
    url = config.baseUrl + path.replace('{MODEL}', config.model);
    url = appendQuery(url, 'key', key);

    let maxOutputTokens = tokens;
    const extra = config.geminiGenerationConfig;
    if (extra && isObject(extra.thinkingConfig)) {
      const budget = Number(extra.thinkingConfig.thinkingBudget);
      if (budget > 0) {
        maxOutputTokens = tokens + Math.floor(budget);
      }
    }

    const generationConfig = Object.assign({
      temperature: 0.0
      , maxOutputTokens: maxOutputTokens
      , topP: 0.95
      , topK: 8
    }, extra || {});
    // The widened token budget wins over any maxOutputTokens the operator put
    // in geminiGenerationConfig; the hard cap stays on the visible answer.
    generationConfig.maxOutputTokens = maxOutputTokens;
    generationConfig.temperature = 0.0;

    body = {
      system_instruction: { parts: [{ text: system }] }
      , contents: [{ role: 'user', parts: [{ text: user }] }]
      , generationConfig: generationConfig
    };
  } else {
    if (config.organizationId) {
      headers['OpenAI-Organization'] = String(config.organizationId);
    }
    body = {
      model: config.model
      , messages: [
        { role: 'system', content: system }
        , { role: 'user', content: user }
      ]
      , temperature: 0.0
      , max_tokens: tokens
    };
  }

  if (config.apiVersion) {
    url = appendQuery(url, 'api-version', String(config.apiVersion));
  }

  return { url: url, headers: headers, body: body };
}

// ---------------------------------------------------------------------------
// Response handling (spec 3.4)
// ---------------------------------------------------------------------------

function getPath (obj, path) {
  let cur = obj;
  for (let i = 0; i < path.length; i++) {
    if (cur === null || cur === undefined) {
      return undefined;
    }
    cur = cur[path[i]];
  }
  return cur;
}

const FORMAT_TEXT_PATH = {
  openai: ['choices', 0, 'message', 'content']
  , anthropic: ['content', 0, 'text']
  , gemini: ['candidates', 0, 'content', 'parts', 0, 'text']
};

function collectTextStrings (node, out, depth) {
  if (depth > 50 || node === null || node === undefined) {
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      collectTextStrings(node[i], out, depth + 1);
    }
    return;
  }
  if (typeof node !== 'object') {
    return;
  }
  if (typeof node.text === 'string' && node.thought !== true) {
    out.push(node.text);
  }
  const keys = Object.keys(node);
  for (let k = 0; k < keys.length; k++) {
    const value = node[keys[k]];
    if (value !== null && typeof value === 'object') {
      collectTextStrings(value, out, depth + 1);
    }
  }
}

function extractText (format, json) {
  const fmt = normalizeFormat(format, '');

  // Stage 1: Gemini thinking models — last non-thought part
  if (fmt === FORMATS.GEMINI) {
    const parts = getPath(json, ['candidates', 0, 'content', 'parts']);
    if (Array.isArray(parts)) {
      let visible = null;
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i];
        if (part && part.thought !== true && typeof part.text === 'string') {
          visible = part.text;
          break;
        }
      }
      if (visible !== null) {
        return visible;
      }
      const thoughtTokens = getPath(json, ['usageMetadata', 'thoughtsTokenCount']);
      if (Number(thoughtTokens) > 0) {
        throw new EmptyThinkingResponseError();
      }
    }
  }

  // Stage 2: format key path (for Gemini, never return a thought part that
  // stage 1 already rejected)
  const direct = getPath(json, FORMAT_TEXT_PATH[fmt]);
  const directIsThought = fmt === FORMATS.GEMINI && getPath(json, ['candidates', 0, 'content', 'parts', 0, 'thought']) === true;
  if (typeof direct === 'string' && !directIsThought) {
    return direct;
  }

  // Stage 3: deep search for text values
  const candidates = [];
  collectTextStrings(json, candidates, 0);
  if (candidates.length > 0) {
    let preferred = null;
    let longest = candidates[0];
    for (let i = 0; i < candidates.length; i++) {
      const value = candidates[i];
      if (preferred === null && (value.indexOf('suggestions') >= 0 || value.indexOf('{') >= 0)) {
        preferred = value;
      }
      if (value.length > longest.length) {
        longest = value;
      }
    }
    return preferred !== null ? preferred : longest;
  }

  // Stage 4: whole response as string
  if (json === undefined) {
    return '';
  }
  const serialized = JSON.stringify(json);
  return serialized === undefined ? '' : serialized;
}

function toTokenCount (value) {
  const n = Number(value);
  return (value !== null && value !== undefined && Number.isFinite(n)) ? n : null;
}

function extractUsage (format, json) {
  const fmt = normalizeFormat(format, '');
  if (fmt === FORMATS.ANTHROPIC) {
    return {
      inputTokens: toTokenCount(getPath(json, ['usage', 'input_tokens']))
      , outputTokens: toTokenCount(getPath(json, ['usage', 'output_tokens']))
    };
  }
  if (fmt === FORMATS.GEMINI) {
    return {
      inputTokens: toTokenCount(getPath(json, ['usageMetadata', 'promptTokenCount']))
      , outputTokens: toTokenCount(getPath(json, ['usageMetadata', 'candidatesTokenCount']))
    };
  }
  return {
    inputTokens: toTokenCount(getPath(json, ['usage', 'prompt_tokens']))
    , outputTokens: toTokenCount(getPath(json, ['usage', 'completion_tokens']))
  };
}

// ---------------------------------------------------------------------------
// SSRF guard (design doc 11.2)
// ---------------------------------------------------------------------------

function parseIpv4 (ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets = [];
  for (let i = 0; i < parts.length; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) {
      return null;
    }
    const n = Number(parts[i]);
    if (n > 255) {
      return null;
    }
    octets.push(n);
  }
  return octets;
}

function isPrivateIpv4 (octets) {
  const a = octets[0];
  const b = octets[1];
  if (a === 127) { return true; } // 127.0.0.0/8
  if (a === 10) { return true; } // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) { return true; } // 172.16.0.0/12
  if (a === 192 && b === 168) { return true; } // 192.168.0.0/16
  if (a === 169 && b === 254) { return true; } // 169.254.0.0/16
  if (a === 0) { return true; } // 0.0.0.0/8
  return false;
}

function expandIpv6 (ip) {
  // Returns an array of 8 16-bit groups, or null when unparsable.
  let addr = ip;
  const zoneIndex = addr.indexOf('%');
  if (zoneIndex >= 0) {
    addr = addr.slice(0, zoneIndex);
  }
  // Embedded IPv4 (e.g. ::ffff:127.0.0.1)
  const lastColon = addr.lastIndexOf(':');
  if (lastColon >= 0 && addr.indexOf('.', lastColon) >= 0) {
    const v4 = parseIpv4(addr.slice(lastColon + 1));
    if (!v4) {
      return null;
    }
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    addr = addr.slice(0, lastColon + 1) + hi + ':' + lo;
  }
  const halves = addr.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    return null;
  }
  const groups = head.concat(new Array(missing).fill('0'), tail);
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) {
      return null;
    }
    out.push(parseInt(groups[i], 16));
  }
  return out;
}

function isPrivateIpv6 (groups) {
  const isZeroThrough = function isZeroThrough (count) {
    for (let i = 0; i < count; i++) {
      if (groups[i] !== 0) { return false; }
    }
    return true;
  };
  // ::1 loopback and :: unspecified
  if (isZeroThrough(7) && (groups[7] === 1 || groups[7] === 0)) {
    return true;
  }
  // fc00::/7 unique local
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return true;
  }
  // fe80::/10 link local
  if ((groups[0] & 0xffc0) === 0xfe80) {
    return true;
  }
  // IPv4-mapped ::ffff:a.b.c.d -> defer to IPv4 rules
  if (isZeroThrough(5) && groups[5] === 0xffff) {
    return isPrivateIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  return false;
}

function isPrivateAddress (ip) {
  if (typeof ip !== 'string' || ip.length === 0) {
    return false;
  }
  let addr = ip.trim().toLowerCase();
  if (addr[0] === '[' && addr[addr.length - 1] === ']') {
    addr = addr.slice(1, -1);
  }
  if (addr === 'localhost') {
    return true;
  }
  const v4 = parseIpv4(addr);
  if (v4) {
    return isPrivateIpv4(v4);
  }
  const v6 = expandIpv6(addr);
  if (v6) {
    return isPrivateIpv6(v6);
  }
  return false;
}

async function assertUrlAllowed (urlString, opts) {
  const options = isObject(opts) ? opts : {};
  const allowPrivate = options.allowPrivateUrl === true;
  let parsed;
  try {
    parsed = new URL(String(urlString));
  } catch (err) {
    throw new UrlNotAllowedError('Provider URL is not a valid URL');
  }

  if (parsed.protocol !== 'https:' && !(allowPrivate && parsed.protocol === 'http:')) {
    throw new UrlNotAllowedError('Provider URL must use https');
  }

  if (allowPrivate) {
    return parsed;
  }

  let hostname = parsed.hostname;
  if (hostname[0] === '[' && hostname[hostname.length - 1] === ']') {
    hostname = hostname.slice(1, -1);
  }

  if (hostname.toLowerCase() === 'localhost' || hostname.toLowerCase().endsWith('.localhost')) {
    throw new UrlNotAllowedError('Provider URL host is not allowed');
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new UrlNotAllowedError('Provider URL resolves to a private address');
    }
    return parsed;
  }

  let addresses;
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch (err) {
    throw new UrlNotAllowedError('Provider URL host could not be resolved');
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new UrlNotAllowedError('Provider URL host could not be resolved');
  }
  for (let i = 0; i < addresses.length; i++) {
    if (isPrivateAddress(addresses[i].address)) {
      throw new UrlNotAllowedError('Provider URL resolves to a private address');
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Sending (design doc 8.3)
// ---------------------------------------------------------------------------

function combineSignals (timeoutMs, external) {
  const controller = new AbortController();
  const timer = setTimeout(function onTimeout () {
    controller.abort(new Error('Provider request timed out after ' + timeoutMs + 'ms'));
  }, timeoutMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  let signal = controller.signal;
  let cleanupExternal = function noop () {};

  if (external && typeof external === 'object') {
    if (typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([controller.signal, external]);
    } else {
      const onAbort = function onExternalAbort () {
        controller.abort(external.reason);
      };
      if (external.aborted) {
        onAbort();
      } else {
        external.addEventListener('abort', onAbort, { once: true });
        cleanupExternal = function removeAbortListener () {
          external.removeEventListener('abort', onAbort);
        };
      }
    }
  }

  return {
    signal: signal
    , cleanup: function cleanup () {
      clearTimeout(timer);
      cleanupExternal();
    }
  };
}

function summarizeError (json, res) {
  let message = null;
  if (json && typeof json === 'object') {
    if (json.error && typeof json.error === 'object' && typeof json.error.message === 'string') {
      message = json.error.message;
    } else if (typeof json.error === 'string') {
      message = json.error;
    } else if (typeof json.message === 'string') {
      message = json.message;
    }
  } else if (typeof json === 'string' && json.length > 0) {
    message = json;
  }
  if (!message) {
    message = (res && res.statusText) || ('HTTP ' + (res && res.status));
  }
  if (message.length > 300) {
    message = message.slice(0, 300) + '...';
  }
  return message;
}

async function parseResponseBody (res) {
  if (typeof res.json === 'function') {
    try {
      return await res.json();
    } catch (err) {
      // fall through to text
    }
  }
  if (typeof res.text === 'function') {
    try {
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        return text;
      }
    } catch (err) {
      return null;
    }
  }
  return null;
}

async function sendPrompt (cfg, apiKey, systemPrompt, userPrompt, opts) {
  const options = isObject(opts) ? opts : {};
  const config = effectiveConfig(cfg);
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new ProviderError(0, 'fetch is not available in this runtime');
  }

  const request = buildRequest(config, apiKey, systemPrompt, userPrompt, options.maxTokens);
  await assertUrlAllowed(request.url, { allowPrivateUrl: options.allowPrivateUrl === true });

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : config.requestTimeoutMs;
  const combined = combineSignals(timeoutMs, options.signal);
  const started = Date.now();

  let res;
  try {
    res = await fetchImpl(request.url, {
      method: 'POST'
      , headers: request.headers
      , body: JSON.stringify(request.body)
      , redirect: 'error'
      , signal: combined.signal
    });
  } catch (err) {
    combined.cleanup();
    const reason = err && err.name === 'AbortError' && combined.signal.reason && combined.signal.reason.message
      ? combined.signal.reason.message
      : (err && err.message) || 'request failed';
    throw new ProviderError(0, redactKey(reason, apiKey));
  }
  combined.cleanup();

  const latencyMs = Date.now() - started;
  const json = await parseResponseBody(res);

  if (options.log === true) {
    console.log('[aiinsights] provider=' + config.format + ' status=' + res.status + ' latency=' + latencyMs + 'ms');
  }

  if (!res.ok) {
    throw new ProviderError(res.status, redactKey(summarizeError(json, res), apiKey));
  }

  let text;
  try {
    text = extractText(config.format, json);
  } catch (err) {
    if (err instanceof EmptyThinkingResponseError) {
      throw err;
    }
    throw new ProviderError(res.status, redactKey(err && err.message, apiKey));
  }

  return {
    text: text
    , usage: extractUsage(config.format, json)
    , status: res.status
    , latencyMs: latencyMs
  };
}

// ---------------------------------------------------------------------------
// Connection test (spec 3.5)
// ---------------------------------------------------------------------------

async function testConnection (cfg, apiKey, opts) {
  const options = Object.assign({}, isObject(opts) ? opts : {}, { maxTokens: TEST_MAX_TOKENS });
  const started = Date.now();
  try {
    const result = await sendPrompt(cfg, apiKey, TEST_SYSTEM_PROMPT, TEST_USER_PROMPT, options);
    return {
      ok: true
      , status: result.status
      , latencyMs: result.latencyMs
      , message: 'Connection succeeded'
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const status = (err && typeof err.status === 'number') ? err.status : 0;
    if (status === 402 || status === 429) {
      return {
        ok: true
        , status: status
        , latencyMs: latencyMs
        , message: 'API key is valid but the provider reported a quota or billing limit (HTTP ' + status + ')'
      };
    }
    return {
      ok: false
      , status: status
      , latencyMs: latencyMs
      , message: redactKey((err && err.message) || 'Connection failed', apiKey)
    };
  }
}

module.exports = {
  FORMATS
  , DEFAULTS
  , DEFAULT_PATH
  , DEFAULT_KEY_HEADER
  , DEFAULT_KEY_PREFIX
  , detectFormat
  , effectiveConfig
  , buildRequest
  , extractText
  , extractUsage
  , isPrivateAddress
  , assertUrlAllowed
  , sendPrompt
  , testConnection
  , redactKey
  , ProviderError
  , EmptyThinkingResponseError
  , UrlNotAllowedError
};
