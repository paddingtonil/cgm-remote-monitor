'use strict';

require('should');

var helper = require('./inithelper')();
var moment = helper.ctx.moment;

function profileWith (records) {
  var profile = require('../lib/profilefunctions')(null, helper.ctx);
  profile.loadData(records);
  return profile;
}

function storeProfile (startDate, timezone) {
  var store = { dia: 3, carbs_hr: 30, carbratio: 7, sens: 35 };
  if (timezone) store.timezone = timezone;
  return {
    defaultProfile: 'Default'
    , startDate: startDate
    , store: { Default: store }
  };
}

describe('timezone-context', function () {
  var tzContext = require('../lib/client-core/timezone-context');

  // Winter: Israel UTC+2, Tokyo UTC+9, New York UTC-5
  var winter = moment('2024-01-15T12:00:00Z').valueOf();
  // Summer: Israel UTC+3
  var summer = moment('2024-07-15T12:00:00Z').valueOf();

  function make (settings, profile) {
    return tzContext({ moment: moment, settings: settings || {}, profile: profile || null });
  }

  describe('mode', function () {
    it('defaults to patient time', function () {
      make({}).mode().should.equal('patient');
      make({ timeDisplay: 'nonsense' }).mode().should.equal('patient');
    });

    it('honours TIME_DISPLAY', function () {
      make({ timeDisplay: 'browser' }).mode().should.equal('browser');
      make({ timeDisplay: 'profile' }).mode().should.equal('profile');
    });
  });

  describe('home', function () {
    it('is HOME_TIMEZONE, with daylight saving applied at the instant', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' });
      tz.homeZone().should.equal('Asia/Jerusalem');
      tz.homeOffsetAt(winter).should.equal(120);
      tz.homeOffsetAt(summer).should.equal(180);
    });

    it('falls back to the current profile zone', function () {
      var tz = make({}, profileWith([storeProfile('2020-01-01', 'Europe/Berlin')]));
      tz.homeZone().should.equal('Europe/Berlin');
      tz.homeOffsetAt(winter).should.equal(60);
    });

    it('ignores an unknown HOME_TIMEZONE', function () {
      var tz = make({ homeTimezone: 'Mars/Olympus' }, profileWith([storeProfile('2020-01-01', 'Europe/Berlin')]));
      tz.homeZone().should.equal('Europe/Berlin');
    });

    it('is null with nothing configured', function () {
      (make({}).homeZone() === null).should.equal(true);
      (make({}).homeOffsetAt(winter) === null).should.equal(true);
    });
  });

  describe('recordOffset', function () {
    var tz = make({});

    it('reads a non-zero utcOffset', function () {
      tz.recordOffset({ utcOffset: 540 }).should.equal(540);
      tz.recordOffset({ utcOffset: '-300' }).should.equal(-300);
    });

    it('treats zero as unknown: uploaders send UTC regardless of location', function () {
      (tz.recordOffset({ utcOffset: 0 }) === null).should.equal(true);
    });

    it('is null for a missing or invalid offset', function () {
      (tz.recordOffset({}) === null).should.equal(true);
      (tz.recordOffset({ utcOffset: 'abc' }) === null).should.equal(true);
      (tz.recordOffset(null) === null).should.equal(true);
    });
  });

  describe('patientAt (layered)', function () {
    var history = [
      storeProfile('2024-01-20T00:00:00Z', 'Asia/Jerusalem') // back home
      , storeProfile('2024-01-10T00:00:00Z', 'Asia/Tokyo') // on a trip
      , storeProfile('2020-01-01T00:00:00Z', 'Asia/Jerusalem')
    ];

    it('uses the record offset first', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profileWith(history));
      var resolved = tz.patientAt(winter, { utcOffset: -300 });
      resolved.offset.should.equal(-300);
      resolved.source.should.equal('record');
    });

    it('then the profile in effect at the instant, not the newest one', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profileWith(history));
      var onTrip = tz.patientAt(moment('2024-01-15T12:00:00Z').valueOf(), { utcOffset: 0 });
      onTrip.offset.should.equal(540);
      onTrip.zone.should.equal('Asia/Tokyo');
      onTrip.source.should.equal('profile');

      var before = tz.patientAt(moment('2024-01-05T12:00:00Z').valueOf(), null);
      before.offset.should.equal(120);
      before.zone.should.equal('Asia/Jerusalem');

      var after = tz.patientAt(moment('2024-01-25T12:00:00Z').valueOf(), null);
      after.offset.should.equal(120);
    });

    it('then home', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profileWith([storeProfile('2020-01-01', undefined)]));
      var resolved = tz.patientAt(summer, null);
      resolved.offset.should.equal(180);
      resolved.source.should.equal('home');
    });

    it('is unknown with nothing to go on', function () {
      var resolved = make({}).patientAt(winter, { utcOffset: 0 });
      (resolved.offset === null).should.equal(true);
      resolved.source.should.equal('unknown');
    });
  });

  describe('displayOffsetAt / momentAt', function () {
    var profile = profileWith([storeProfile('2020-01-01', 'Asia/Jerusalem')]);

    it('patient mode shows the record wall clock', function () {
      var tz = make({ timeDisplay: 'patient', homeTimezone: 'Asia/Jerusalem' }, profile);
      tz.momentAt(winter, { utcOffset: 540 }).format('HH:mm').should.equal('21:00');
      tz.momentAt(winter, { utcOffset: 0 }).format('HH:mm').should.equal('14:00');
    });

    it('profile mode ignores the record offset', function () {
      var tz = make({ timeDisplay: 'profile', homeTimezone: 'Asia/Jerusalem' }, profile);
      tz.momentAt(winter, { utcOffset: 540 }).format('HH:mm').should.equal('14:00');
    });

    it('browser mode leaves the moment in local time', function () {
      var tz = make({ timeDisplay: 'browser', homeTimezone: 'Asia/Jerusalem' }, profile);
      (tz.displayOffsetAt(winter, { utcOffset: 540 }) === null).should.equal(true);
      tz.momentAt(winter, { utcOffset: 540 }).utcOffset().should.equal(moment(winter).utcOffset());
    });

    it('format() is a shorthand', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profile);
      tz.format(winter, 'HH:mm', { utcOffset: 540 }).should.equal('21:00');
    });
  });

  describe('isAwayAt', function () {
    var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profileWith([storeProfile('2020-01-01', 'Asia/Jerusalem')]));

    it('is true when the record offset differs from home', function () {
      tz.isAwayAt(winter, { utcOffset: 540 }).should.equal(true);
    });

    it('is false at home, and across the home daylight-saving change', function () {
      tz.isAwayAt(winter, { utcOffset: 120 }).should.equal(false);
      tz.isAwayAt(summer, { utcOffset: 180 }).should.equal(false);
      tz.isAwayAt(summer, { utcOffset: 0 }).should.equal(false);
    });

    it('is false when nothing is known', function () {
      make({}).isAwayAt(winter, { utcOffset: 540 }).should.equal(false);
    });
  });

  describe('currentPatient / status', function () {
    var profile = profileWith([storeProfile('2020-01-01', 'Asia/Jerusalem')]);
    var now = winter;
    var hour = 60 * 60 * 1000;

    it('takes the newest recent record with an offset, from treatments or SGVs', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profile);
      var data = {
        treatments: [{ mills: now - 2 * hour, utcOffset: 540 }]
        , sgvs: [{ mills: now - 3 * hour, utcOffset: 540 }, { mills: now - 5 * 60 * 1000, utcOffset: -300 }]
      };
      var current = tz.currentPatient(data, now);
      current.offset.should.equal(-300);
      current.source.should.equal('record');
      current.since.should.equal(now - 5 * 60 * 1000);
    });

    it('ignores records in the future, too old, or without an offset', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profile);
      var data = {
        treatments: [{ mills: now + hour, utcOffset: 540 }, { mills: now - 10 * hour, utcOffset: 540 }, { mills: now - hour, utcOffset: 0 }]
        , sgvs: []
      };
      var current = tz.currentPatient(data, now);
      current.source.should.equal('profile');
      current.offset.should.equal(120);
    });

    it('status() flags travel against home', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profile);
      var away = tz.status({ treatments: [{ mills: now - hour, utcOffset: 540 }] }, now);
      away.away.should.equal(true);
      away.known.should.equal(true);
      away.home.zone.should.equal('Asia/Jerusalem');
      away.home.offset.should.equal(120);
      away.patient.offset.should.equal(540);

      var home = tz.status({ treatments: [{ mills: now - hour, utcOffset: 120 }] }, now);
      home.away.should.equal(false);

      var unknown = make({}).status({}, now);
      unknown.known.should.equal(false);
      unknown.away.should.equal(false);
    });
  });

  describe('displayOffsetNow', function () {
    var profile = profileWith([storeProfile('2020-01-01', 'Asia/Jerusalem')]);
    var now = winter;
    var data = { treatments: [{ mills: now - 60 * 1000, utcOffset: 540 }] };

    it('follows the patient in patient mode', function () {
      make({ homeTimezone: 'Asia/Jerusalem' }, profile).displayOffsetNow(data, now).should.equal(540);
    });

    it('is the profile zone in profile mode', function () {
      make({ timeDisplay: 'profile', homeTimezone: 'Asia/Jerusalem' }, profile).displayOffsetNow(data, now).should.equal(120);
    });

    it('is null (browser) in browser mode', function () {
      (make({ timeDisplay: 'browser' }, profile).displayOffsetNow(data, now) === null).should.equal(true);
    });
  });

  describe('labels', function () {
    it('formats offsets', function () {
      make({}).label(540).should.equal('UTC+9');
      make({}).label(330).should.equal('UTC+5:30');
    });
  });
});
