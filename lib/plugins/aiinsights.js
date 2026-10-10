'use strict';

// AI Insights plugin (docs/proposals/ai-insights-design.md 9.6).
//
// Enabled with ENABLE=... aiinsights. On the dashboard it shows a status pill
// with the number of pending suggestions (or the latest settings grade) and
// links to /insights. All provider work happens server-side in
// lib/aiinsights/; this plugin never sees the API key and its extended
// settings sent to the browser contain only non-secret provider metadata.

var REFRESH_MS = 60 * 1000;

function init (ctx) {
  var translate = ctx.language.translate;

  var aiinsights = {
    name: 'aiinsights'
    , label: 'AI Insights'
    , pluginType: 'pill-status'
  };

  var cache = { summary: null, fetchedAt: 0, inflight: false, unauthorized: false };

  function isBrowser () {
    return typeof window !== 'undefined' && window.$ && window.Nightscout && window.Nightscout.client;
  }

  function refreshSummary () {
    if (!isBrowser() || cache.inflight) { return; }
    if (Date.now() - cache.fetchedAt < REFRESH_MS) { return; }
    var client = window.Nightscout.client;
    cache.inflight = true;
    window.$.ajax({
      method: 'GET'
      , url: '/api/v1/aiinsights/summary'
      , headers: client.headers()
    }).done(function done (summary) {
      cache.summary = summary;
      cache.unauthorized = false;
    }).fail(function fail (jqXHR) {
      cache.unauthorized = jqXHR && (jqXHR.status === 401 || jqXHR.status === 403);
    }).always(function always () {
      cache.inflight = false;
      cache.fetchedAt = Date.now();
    });
  }

  aiinsights.setProperties = function setProperties (sbx) {
    sbx.offerProperty('aiinsights', function setProp () {
      return cache.summary;
    });
  };

  aiinsights.updateVisualisation = function updateVisualisation (sbx) {
    refreshSummary();
    var summary = cache.summary;
    var value;
    var info = [];
    var pillClass = '';

    if (cache.unauthorized) {
      value = translate('Sign in');
      info.push({ label: translate('AI Insights'), value: translate('Authenticate to see suggestions') });
    } else if (!summary) {
      value = '…';
    } else if (summary.pending > 0) {
      value = summary.pending + ' ' + translate('new');
      pillClass = summary.highestConfidence === 'high' ? 'warn' : '';
      Object.keys(summary.pendingBySetting || { }).forEach(function each (type) {
        info.push({ label: type.replace(/_/g, ' '), value: summary.pendingBySetting[type] + ' ' + translate('pending') });
      });
    } else if (summary.score && summary.score.grade) {
      value = summary.score.grade + ' ' + summary.score.total;
      info.push({ label: translate('Settings score'), value: summary.score.total + '/100' });
    } else {
      value = translate('ready');
    }

    if (summary && summary.lastAnalysisAt) {
      info.push({ label: translate('Last analysis'), value: new Date(summary.lastAnalysisAt).toLocaleString() });
    }
    info.push({ label: translate('Open'), value: '/insights' });

    sbx.pluginBase.updatePillText(aiinsights, {
      value: value
      , label: 'AI'
      , info: info
      , pillClass: pillClass
    });

    if (isBrowser()) {
      var pill = window.$('span.pill.aiinsights');
      if (pill.length && !pill.data('aiinsights-link')) {
        pill.data('aiinsights-link', true).css('cursor', 'pointer').on('click', function open () {
          window.location.href = '/insights';
        });
      }
    }
  };

  return aiinsights;
}

module.exports = init;
