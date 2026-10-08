'use strict';

require('should');

var helper = require('./inithelper')();
var moment = helper.ctx.moment;

describe('timezone plugin (travelling indicator)', function () {
  var language = require('../lib/language')();
  var plugin = require('../lib/plugins/timezone')({ language: language });
  var tzContext = require('../lib/client-core/timezone-context');

  var now = moment('2024-01-15T12:00:00Z').valueOf(); // Israel is UTC+2 in January

  function profileWith (timezone) {
    var profile = require('../lib/profilefunctions')(null, helper.ctx);
    profile.loadData([{ defaultProfile: 'Default', startDate: '2020-01-01', store: { Default: { timezone: timezone, dia: 3 } } }]);
    return profile;
  }

  function sandboxWith (settings, data) {
    var pills = [];
    var profile = profileWith('Asia/Jerusalem');
    var sbx = require('../lib/sandbox')().clientInit({
      settings: settings
      , language: language
      , levels: require('../lib/levels')
      , tz: tzContext({ moment: moment, settings: settings, profile: profile })
      , pluginBase: {
        updatePillText: function (p, options) { pills.push(options); }
      }
    }, now, data);
    sbx.data.profile = profile;
    sbx.pills = pills;
    return sbx;
  }

  it('is a status pill, enabled by default, registered under its file name', function () {
    plugin.name.should.equal('timezone');
    plugin.pluginType.should.equal('pill-status');
    require('../lib/settings')().DEFAULT_FEATURES.should.containEql('timezone');
  });

  it('is hidden while the patient is at home', function () {
    var sbx = sandboxWith({ homeTimezone: 'Asia/Jerusalem', timeDisplay: 'patient' }, { treatments: [{ mills: now - 60000, utcOffset: 120 }], sgvs: [] });
    plugin.setProperties(sbx);
    plugin.updateVisualisation(sbx);
    sbx.pills.length.should.equal(1);
    sbx.pills[0].hide.should.equal(true);
  });

  it('is hidden when nothing is known about where the patient is', function () {
    var sbx = sandboxWith({ timeDisplay: 'patient' }, { treatments: [], sgvs: [] });
    sbx.tz.setProfile(null);
    plugin.setProperties(sbx);
    plugin.updateVisualisation(sbx);
    sbx.pills[0].hide.should.equal(true);
  });

  it('shows the patient zone when away from home, with both local times', function () {
    var sbx = sandboxWith({ homeTimezone: 'Asia/Jerusalem', timeDisplay: 'patient' }, { treatments: [{ mills: now - 60000, utcOffset: 540 }], sgvs: [] });
    plugin.setProperties(sbx);
    plugin.updateVisualisation(sbx);

    var pill = sbx.pills[0];
    (pill.hide === undefined || pill.hide === false).should.equal(true);
    pill.label.should.equal('Trip');
    pill.value.should.equal('UTC+9 (7h ahead of home)');

    var info = {};
    pill.info.forEach(function (row) { info[row.label] = row.value; });
    info['Patient time zone'].should.equal('UTC+9');
    info['Time difference'].should.equal('7h ahead of home');
    info['Patient local time'].should.equal('9:00 PM');
    info['Home time zone'].should.equal('Asia/Jerusalem (UTC+2)');
    info['Home local time'].should.equal('2:00 PM');
    info.should.have.property('Away since');
    info.should.have.property('Browser time');
  });

  it('is hidden in browser mode even when away', function () {
    var sbx = sandboxWith({ homeTimezone: 'Asia/Jerusalem', timeDisplay: 'browser' }, { treatments: [{ mills: now - 60000, utcOffset: 540 }], sgvs: [] });
    plugin.setProperties(sbx);
    plugin.updateVisualisation(sbx);
    sbx.pills[0].hide.should.equal(true);
  });

  it('sandbox formatTime / formatDateTime use the display clock', function () {
    var sbx = sandboxWith({ homeTimezone: 'Asia/Jerusalem', timeDisplay: 'patient' }, { treatments: [], sgvs: [] });
    sbx.formatTime(now, { utcOffset: 540 }).should.equal('9:00 PM');
    sbx.formatTime(now).should.equal('2:00 PM'); // profile zone, Israel
    sbx.formatDateTime(now, { utcOffset: -300 }).should.equal('01/15/2024 7:00 AM');
  });
});
