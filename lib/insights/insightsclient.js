'use strict';

// Browser client for the /insights page (docs/proposals/ai-insights-design.md 12).
// jQuery + plain DOM, same bootstrap as the food and profile editors. Every
// piece of model output is inserted with .text() (never .html()), and the
// only markup we build from it is **bold** → <strong> via element creation.

var types = require('../aiinsights/types');

var SETTING_LABELS = types.SETTING_LABELS;
var SETTING_UNITS = types.SETTING_UNITS;
var POLL_MS = 2000;
var API = '/api/v1/aiinsights';

var init = function init () {
  var $ = window.$;
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;

  var state = {
    settings: null
    , meta: null
    , period: 14
    , aggregate: null
    , pollTimer: null
    , confirmAll: window.sessionStorage.getItem('aiinsights-confirm-all') === 'true'
    , chat: loadChat()
  };

  client.init(function loaded () {
    var translate = client.translate;

    // ---------------------------------------------------------------- utils --

    function ajax (method, path, body) {
      var opts = {
        method: method
        , url: API + path
        , headers: client.headers()
        , dataType: 'json'
      };
      if (body !== undefined) {
        opts.contentType = 'application/json';
        opts.data = JSON.stringify(body);
      }
      return $.ajax(opts);
    }

    function errorText (jqXHR, fallback) {
      if (jqXHR && jqXHR.responseJSON) {
        var j = jqXHR.responseJSON;
        return (j.message || '') + (j.description ? ': ' + j.description : '');
      }
      if (jqXHR && jqXHR.status === 401) { return translate('Not authorized. Use the lock icon to authenticate.'); }
      return fallback || translate('Request failed');
    }

    function banner (text, cls) {
      var el = $('#ai_status');
      if (!text) { return el.hide().empty(); }
      el.attr('class', 'ai-banner' + (cls ? ' ' + cls : '')).empty().append($('<span>').text(text)).show();
      return el;
    }

    function fmt (n, d) {
      if (n === null || n === undefined || !isFinite(n)) { return '–'; }
      return Number(n).toFixed(d === undefined ? 0 : d);
    }

    function fmtTime (seconds) {
      var h = Math.floor(seconds / 3600) % 24;
      var m = Math.floor((seconds % 3600) / 60);
      var suffix = h >= 12 ? 'PM' : 'AM';
      var h12 = h % 12 === 0 ? 12 : h % 12;
      return h12 + ':' + (m < 10 ? '0' + m : m) + ' ' + suffix;
    }

    // "**bold**" markdown → <strong>, everything else as text nodes
    function richText (text) {
      var span = $('<span>');
      String(text || '').split('**').forEach(function each (part, i) {
        if (!part) { return; }
        span.append(i % 2 === 1 ? $('<strong>').text(part) : document.createTextNode(part));
      });
      return span;
    }

    function chip (label, value, cls) {
      return $('<div>').addClass('ai-chip ' + (cls || '')).append(
        $('<span>').addClass('ai-chip-label').text(label)
        , $('<span>').addClass('ai-chip-value').text(value)
      );
    }

    function tirClass (v) { return v >= 70 ? 'green' : v >= 50 ? 'yellow' : 'red'; }
    function avgClass (v) { return v >= 70 && v <= 180 ? 'green' : v >= 60 && v <= 200 ? 'yellow' : 'red'; }
    function cvClass (v) { return v <= 36 ? 'green' : 'orange'; }

    function metricsChips (g, score) {
      var row = $('<div>');
      if (!g) { return row; }
      row.append(chip('TIR', fmt(g.tirPct, 1) + '%', tirClass(g.tirPct)));
      row.append(chip('TBR', fmt(g.tbrPct, 1) + '%', g.tbrPct < 4 ? 'green' : 'red'));
      row.append(chip('TAR', fmt(g.tarPct, 1) + '%', g.tarPct <= 25 ? 'green' : 'orange'));
      row.append(chip('Avg', fmt(g.mean, 0) + ' mg/dL', avgClass(g.mean)));
      row.append(chip('CV', fmt(g.cv, 1) + '%', cvClass(g.cv)));
      row.append(chip('GMI', fmt(g.gmi, 1) + '%'));
      if (score) { row.append(chip(translate('Score'), score.grade + ' ' + score.total)); }
      return row.children();
    }

    // ---------------------------------------------------------------- tabs --

    $('#ai_tabs li').on('click', function switchTab () {
      var tab = $(this).data('tab');
      $('#ai_tabs li').removeClass('active');
      $(this).addClass('active');
      $('.ai-tab').hide();
      $('#ai_tab_' + tab).show();
      if (tab === 'trends' && !$('#ai_trend_result').children().length) { loadTrend('weekly', false); }
      if (tab === 'ask') { renderChat(); }
    });

    // ------------------------------------------------------------ settings --

    function loadSettings () {
      return ajax('GET', '/settings').done(function done (meta) {
        state.meta = meta;
        state.settings = meta.settings;
        state.period = meta.settings.analysisPeriod;
        renderReadiness();
        renderConfig();
        renderPeriods();
      }).fail(function fail (jqXHR) {
        banner(errorText(jqXHR, translate('Unable to load AI Insights settings')), 'ai-error');
        $('.ai-analyze, #ai_chat_send, .ai-trend').prop('disabled', true);
      });
    }

    function renderReadiness () {
      var meta = state.meta;
      var ready = meta.readiness;
      $('.ai-analyze, #ai_chat_send, .ai-trend').prop('disabled', !ready.ok);
      if (ready.ok) {
        banner('');
        return;
      }
      var el = banner(ready.message, ready.reason === 'locked' ? 'ai-error' : '');
      if (ready.reason === 'privacy_ack_required' && meta.privacyAck) {
        el.append($('<button>').text(translate('Review privacy settings')).on('click', function go () {
          $('#ai_tabs li[data-tab="config"]').trigger('click');
        }));
      }
    }

    function renderPeriods () {
      var box = $('#ai_periods').empty();
      state.meta.periods.forEach(function each (p) {
        box.append($('<button>').text(p + 'd').toggleClass('active', p === state.period).on('click', function pick () {
          state.period = p;
          renderPeriods();
          loadAggregate();
        }));
      });
      $('#ai_cost_hint').text(translate('Estimated cost') + ': ~$0.07 / setting, ~$0.21 for all');
    }

    function renderConfig () {
      var s = state.settings;
      var meta = state.meta;
      var p = meta.provider;
      var kv = $('#ai_provider_info').empty();
      [['Status', p.configured ? translate('Key configured on server') : translate('AIINSIGHTS_API_KEY not set')]
        , ['Format', p.format], ['Model', p.model], ['Base URL', p.baseUrl]
        , ['Max tokens', String(p.maxTokens)], ['Temperature', String(p.temperature)]
        , ['Server privacy ack', meta.privacyAck ? 'yes' : 'no (set AIINSIGHTS_PRIVACY_ACK=true)']
      ].forEach(function each (pair) {
        kv.append($('<span>').text(pair[0]), $('<span>').text(pair[1]));
      });
      $('#ai_privacy_ack').prop('checked', !!s.privacyAcknowledgedAt);

      var periodSel = $('#ai_cfg_period').empty();
      meta.periods.forEach(function each (d) { periodSel.append($('<option>').val(d).text(d + ' days')); });
      periodSel.val(s.analysisPeriod);
      var persSel = $('#ai_cfg_personality').empty();
      meta.personalities.forEach(function each (k) { persSel.append($('<option>').val(k).text(k.replace(/_/g, ' '))); });
      persSel.val(s.aiPersonality);
      $('#ai_cfg_tight').val(s.tightRangeUpperBound);
      $('#ai_cfg_bed').val(s.sleepSchedule.bedHour);
      $('#ai_cfg_wake').val(s.sleepSchedule.wakeHour);
      Object.keys(s.features).forEach(function each (f) { $('#ai_f_' + f).prop('checked', !!s.features[f]); });
      $('#ai_b_cap').val(s.budget.monthlyCapUsd);
      $('#ai_b_warn').val(s.budget.warnPercent);
      $('#ai_b_hard').prop('checked', s.budget.hardBlock);
      $('#ai_b_confirm').prop('checked', s.budget.confirmBeforeCall);
      loadUsage();
    }

    function loadUsage () {
      ajax('GET', '/usage').done(function done (u) {
        var kv = $('#ai_usage').empty();
        kv.append($('<span>').text(translate('This month')), $('<span>').text('$' + fmt(u.estimatedCostUsd, 3) + ' over ' + u.callCount + ' calls'));
        if (u.capUsd > 0) {
          kv.append($('<span>').text(translate('Budget')), $('<span>').text(fmt(u.percentUsed, 1) + '% of $' + u.capUsd + (u.blocked ? ' (blocked)' : '')));
        }
      });
    }

    $('#ai_cfg_save').on('click', function save () {
      var features = { };
      ['circadian', 'foodResponse', 'caffeineTracking', 'alcoholTracking', 'cgmBackfillDetection'].forEach(function each (f) {
        features[f] = $('#ai_f_' + f).is(':checked');
      });
      var patch = {
        analysisPeriod: parseInt($('#ai_cfg_period').val(), 10)
        , aiPersonality: $('#ai_cfg_personality').val()
        , tightRangeUpperBound: parseInt($('#ai_cfg_tight').val(), 10)
        , sleepSchedule: { bedHour: parseInt($('#ai_cfg_bed').val(), 10), wakeHour: parseInt($('#ai_cfg_wake').val(), 10) }
        , features: features
        , budget: {
          monthlyCapUsd: parseFloat($('#ai_b_cap').val()) || 0
          , warnPercent: parseInt($('#ai_b_warn').val(), 10)
          , hardBlock: $('#ai_b_hard').is(':checked')
          , confirmBeforeCall: $('#ai_b_confirm').is(':checked')
        }
        , privacyAcknowledged: $('#ai_privacy_ack').is(':checked')
      };
      $('#ai_cfg_status').text(translate('Saving…'));
      ajax('PUT', '/settings', patch).done(function done (res) {
        state.settings = res.settings;
        state.meta.settings = res.settings;
        state.meta.readiness = res.readiness;
        $('#ai_cfg_status').text(translate('Saved'));
        renderReadiness();
        renderConfig();
      }).fail(function fail (jqXHR) {
        $('#ai_cfg_status').text(errorText(jqXHR));
      });
    });

    $('#ai_test_connection').on('click', function test () {
      $('#ai_test_result').text(translate('Testing…'));
      ajax('POST', '/settings/test-connection', { }).done(function done (r) {
        $('#ai_test_result').text((r.ok ? '✓ ' : '✗ ') + (r.message || '') + (r.latencyMs ? ' (' + r.latencyMs + ' ms)' : ''));
      }).fail(function fail (jqXHR) {
        var r = jqXHR.responseJSON;
        $('#ai_test_result').text('✗ ' + (r && r.message ? r.message : errorText(jqXHR)));
      });
    });

    // ----------------------------------------------------------- aggregate --

    function loadAggregate () {
      ajax('GET', '/aggregate?period=' + state.period).done(function done (data) {
        state.aggregate = data;
        $('#ai_metrics').empty().append(metricsChips(data.glucose, data.score));
        $('#ai_score').text(data.score ? translate('Score') + ': ' + data.score.grade + ' (' + data.score.total + ')' : '');
        var box = $('#ai_patterns').empty();
        if (!data.patterns.length) { box.append($('<div>').addClass('ai-muted').text(translate('No notable patterns detected'))); }
        data.patterns.forEach(function each (p) {
          box.append($('<div>').addClass('ai-pattern ' + p.severity).append(
            $('<strong>').text(p.title + ' '), $('<span>').addClass('ai-muted').text('(' + p.severity + ') '), $('<span>').text(p.description)
          ));
        });
      }).fail(function fail (jqXHR) {
        $('#ai_metrics').empty().append($('<span>').addClass('ai-muted').text(errorText(jqXHR)));
      });
    }

    // ---------------------------------------------------------- suggestions --

    function loadSuggestions () {
      ajax('GET', '/suggestions?status=pending&limit=20').done(function done (rows) {
        var box = $('#ai_suggestions').empty();
        if (!rows.length) { box.append($('<div>').addClass('ai-muted').text(translate('No pending suggestions. Run an analysis to get started.'))); }
        rows.forEach(function each (s) { box.append(suggestionCard(s, true)); });
      });
      ajax('GET', '/suggestions?status=applied,dismissed,reverted&limit=10').done(function done (rows) {
        var box = $('#ai_history').empty();
        if (!rows.length) { box.append($('<div>').addClass('ai-muted').text(translate('Nothing yet'))); }
        rows.forEach(function each (s) { box.append(suggestionCard(s, false)); });
      });
    }

    function suggestionCard (s, pending) {
      var card = $('<div>').addClass('ai-card');
      var title = $('<h4>').text(SETTING_LABELS[s.setting_type] || s.setting_type);
      title.append($('<span>').addClass('ai-badge ' + s.confidence).text(s.confidence));
      if (!pending) { title.append($('<span>').addClass('ai-badge status').text(s.status)); }
      if (s.out_of_recommended_range) { title.append($('<span>').addClass('ai-badge warn').text(translate('outside recommended range'))); }
      card.append(title);
      card.append($('<div>').addClass('ai-muted').text(new Date(s.created_at).toLocaleString() + ' · ' + s.period_days + ' ' + translate('days')));
      if (s.plain_summary) { card.append($('<div>').addClass('ai-plain').text(s.plain_summary)); }

      var table = $('<table>').addClass('ai-blocks').append($('<tr>').append(
        $('<th>').text(translate('Time block')), $('<th>').text(translate('Current')), $('<th>').text(translate('Proposed')), $('<th>').text(translate('Change'))
      ));
      (s.time_blocks || []).forEach(function each (b) {
        var pct = b.current_value ? ((b.proposed_value - b.current_value) / b.current_value * 100) : 0;
        table.append($('<tr>').append(
          $('<td>').text(fmtTime(b.start_seconds) + ' – ' + fmtTime(b.end_seconds))
          , $('<td>').text(b.current_value + ' ' + SETTING_UNITS[s.setting_type])
          , $('<td>').text(b.proposed_value + ' ' + SETTING_UNITS[s.setting_type])
          , $('<td>').text((pct > 0 ? '+' : '') + pct.toFixed(1) + '%')
        ));
      });
      card.append(table);

      var reasoning = $('<details>').addClass('ai-details').append($('<summary>').text(translate('Reasoning')), $('<p>').text(s.reasoning));
      card.append(reasoning);
      if (s.success_criteria) {
        var sc = s.success_criteria;
        var det = $('<details>').addClass('ai-details').append($('<summary>').text(translate('Success criteria') + ' (' + sc.evaluation_days + ' ' + translate('days') + ')'));
        var ul = $('<ul>');
        (sc.expected_outcomes || []).forEach(function each (o) { ul.append($('<li>').text(o)); });
        det.append(ul);
        if (sc.revert_warnings && sc.revert_warnings.length) {
          det.append($('<div>').text(translate('Revert if') + ': ' + sc.revert_warnings.join('; ')));
        }
        card.append(det);
      }
      if (s.evaluation) {
        card.append($('<div>').append($('<strong>').text(translate('Evaluation') + ': ' + s.evaluation.verdict + ' (' + s.evaluation.criteria_met + '/' + s.evaluation.criteria_total + ') '), $('<span>').text(s.evaluation.reasoning)));
      }
      if (s.validation_notes && s.validation_notes.length) {
        card.append($('<div>').addClass('ai-notes').text(translate('Validation notes') + ': ' + s.validation_notes.join(' · ')));
      }

      var actions = $('<div>').addClass('ai-card-actions');
      if (pending) {
        actions.append($('<button>').addClass('ai-primary').text(translate('I applied this in my pump')).on('click', function applied () {
          if (!window.confirm(translate('Nightscout does not change pump settings. Confirm that you changed this setting yourself in Loop/AAPS.'))) { return; }
          patchSuggestion(s.record_id, 'applied', s.out_of_recommended_range);
        }));
        actions.append($('<button>').text(translate('Dismiss')).on('click', function dismiss () { patchSuggestion(s.record_id, 'dismissed'); }));
      } else if (s.status === 'applied') {
        actions.append($('<button>').text(translate('Reverted')).on('click', function reverted () { patchSuggestion(s.record_id, 'reverted'); }));
      }
      card.append(actions);
      return card;
    }

    function patchSuggestion (recordId, status, outOfRange) {
      var body = { status: status };
      if (outOfRange && status === 'applied') {
        if (!window.confirm(translate('This value is outside the recommended clinical range. Mark as applied anyway?'))) { return; }
        body.confirmOutOfRange = true;
      }
      ajax('PATCH', '/suggestions/' + encodeURIComponent(recordId), body).done(loadSuggestions).fail(function fail (jqXHR) {
        banner(errorText(jqXHR), 'ai-error');
      });
    }

    // -------------------------------------------------------------- analyze --

    $('.ai-analyze').on('click', function analyze () {
      startAnalyze($(this).data('type'), false);
    });

    function startAnalyze (settingType, confirmCost) {
      var body = { settingType: settingType, period: state.period, confirmCost: confirmCost || state.confirmAll };
      $('.ai-analyze').prop('disabled', true);
      $('#ai_job').show().text(translate('Starting analysis…'));
      ajax('POST', '/analyze', body).done(function done (res) {
        if (res.warning === 'budget_warning') { banner(translate('Budget warning: you are near your monthly AI cap'), ''); }
        pollJob(res.jobId, function finished (job) {
          $('.ai-analyze').prop('disabled', false);
          if (job.status === 'done') {
            var r = job.result;
            var n = r.suggestions.length;
            $('#ai_job').text(translate('Analysis complete') + ': ' + n + ' ' + translate('suggestion(s)') + '. ' + (r.analyses.map(function a (x) { return x.overallAssessment; }).filter(Boolean).join(' ')));
            loadSuggestions();
            loadAggregate();
          } else {
            $('#ai_job').text(translate('Analysis failed') + ': ' + (job.error ? job.error.message : ''));
          }
        });
      }).fail(function fail (jqXHR) {
        $('.ai-analyze').prop('disabled', false);
        var j = jqXHR.responseJSON;
        if (jqXHR.status === 409 && j && j.requiresConfirmation) {
          var msg = translate('Estimated cost') + ' $' + fmt(j.estimatedCostUsd, 2) + '. ' + translate('Proceed?');
          if (window.confirm(msg)) {
            if (window.confirm(translate('Skip this confirmation for the rest of this session?'))) {
              state.confirmAll = true;
              window.sessionStorage.setItem('aiinsights-confirm-all', 'true');
            }
            return startAnalyze(settingType, true);
          }
          $('#ai_job').hide();
          return;
        }
        $('#ai_job').text(errorText(jqXHR));
      });
    }

    function pollJob (jobId, done) {
      clearTimeout(state.pollTimer);
      ajax('GET', '/jobs/' + encodeURIComponent(jobId)).done(function got (job) {
        if (job.status === 'done' || job.status === 'failed') { return done(job); }
        $('#ai_job').text(translate('Working…') + (job.progress ? ' ' + job.progress : ''));
        state.pollTimer = setTimeout(function again () { pollJob(jobId, done); }, POLL_MS);
      }).fail(function fail (jqXHR) {
        done({ status: 'failed', error: { message: errorText(jqXHR) } });
      });
    }

    // --------------------------------------------------------------- trends --

    $('.ai-trend').on('click', function pick () { loadTrend($(this).data('tab'), false); });
    $('#ai_trend_refresh').on('click', function refresh () {
      var active = $('.ai-trend.active').data('tab') || 'weekly';
      loadTrend(active, true);
    });

    function loadTrend (tab, refresh) {
      $('.ai-trend').removeClass('active');
      $('.ai-trend[data-tab="' + tab + '"]').addClass('active');
      var box = $('#ai_trend_result').empty().append($('<div>').addClass('ai-muted').text(translate('Loading…')));
      ajax('POST', '/trends', { tab: tab, refresh: refresh, confirmCost: state.confirmAll }).done(function done (res, textStatus, jqXHR) {
        if (jqXHR.status === 202) {
          pollJob(res.jobId, function finished (job) {
            if (job.status === 'done') { renderTrend(job.result); } else { box.empty().append($('<div>').addClass('ai-muted').text(translate('Trends failed') + ': ' + (job.error ? job.error.message : ''))); }
          });
        } else {
          renderTrend(res);
        }
      }).fail(function fail (jqXHR) {
        box.empty().append($('<div>').addClass('ai-muted').text(errorText(jqXHR)));
      });
    }

    function renderTrend (t) {
      $('#ai_trend_metrics').empty().append(metricsChips(t.snapshot ? {
        tirPct: t.snapshot.tir, tbrPct: t.snapshot.tbr, tarPct: t.snapshot.tar, mean: t.snapshot.avg, cv: t.snapshot.cv, gmi: t.snapshot.gmi
      } : null, t.snapshot ? t.snapshot.score : null));
      var box = $('#ai_trend_result').empty();
      box.append($('<div>').addClass('ai-muted').text(t.tab + ' · ' + t.periodDays + ' ' + translate('days') + ' · ' + new Date(t.createdAt).toLocaleString()));
      box.append($('<p>').append(richText(t.summary)));
      if (t.highlights && t.highlights.length) {
        var ul = $('<ul>');
        t.highlights.forEach(function each (h) { ul.append($('<li>').append(richText(h))); });
        box.append(ul);
      }
    }

    // ----------------------------------------------------------------- chat --

    function renderChat () {
      var log = $('#ai_chat_log').empty();
      state.chat.forEach(function each (m) {
        log.append($('<div>').addClass('ai-msg ' + m.role).append(richText(m.content)));
      });
      log.scrollTop(log[0].scrollHeight);
    }

    $('#ai_chat_send').on('click', sendChat);
    $('#ai_chat_text').on('keydown', function key (e) { if (e.key === 'Enter') { sendChat(); } });
    $('#ai_chat_clear').on('click', function clear () { state.chat = []; saveChat(); renderChat(); });

    function sendChat () {
      var text = $('#ai_chat_text').val().trim();
      if (!text) { return; }
      $('#ai_chat_text').val('');
      var history = state.chat.slice(-10);
      state.chat.push({ role: 'user', content: text });
      saveChat();
      renderChat();
      var pendingEl = $('<div>').addClass('ai-msg assistant pending').text(translate('Thinking…'));
      $('#ai_chat_log').append(pendingEl);
      $('#ai_chat_send').prop('disabled', true);
      ajax('POST', '/chat', { message: text, history: history, confirmCost: state.confirmAll }).done(function done (res) {
        pollJob(res.jobId, function finished (job) {
          $('#ai_chat_send').prop('disabled', false);
          pendingEl.remove();
          var reply = job.status === 'done' ? job.result.reply : translate('Sorry, that failed') + ': ' + (job.error ? job.error.message : '');
          state.chat.push({ role: 'assistant', content: reply });
          saveChat();
          renderChat();
        });
      }).fail(function fail (jqXHR) {
        $('#ai_chat_send').prop('disabled', false);
        pendingEl.remove().text('');
        state.chat.push({ role: 'assistant', content: errorText(jqXHR) });
        saveChat();
        renderChat();
      });
    }

    // ----------------------------------------------------------------- boot --

    loadSettings().done(function ready () {
      loadAggregate();
      loadSuggestions();
    });
  });

  function loadChat () {
    try {
      return JSON.parse(window.sessionStorage.getItem('aiinsights-chat') || '[]');
    } catch (err) {
      return [];
    }
  }

  function saveChat () {
    try {
      window.sessionStorage.setItem('aiinsights-chat', JSON.stringify(state.chat.slice(-40)));
    } catch (err) {
      // storage full or disabled; chat simply isn't persisted
    }
  }
};

module.exports = init;
