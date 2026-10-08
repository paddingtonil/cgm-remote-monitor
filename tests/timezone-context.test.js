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

    it('keeps the previous home offset as home for two weeks after a daylight-saving change', function () {
      // Israel: summer time starts 27 March 2026 and ends 25 October 2026. Loop
      // re-syncs the pump clock (and so the profile offset) days after a change.
      tz.isAwayAt(moment('2026-04-05T12:00:00Z').valueOf(), { utcOffset: 120 }).should.equal(false);
      tz.isAwayAt(moment('2026-11-01T12:00:00Z').valueOf(), { utcOffset: 180 }).should.equal(false);
    });

    it('otherwise treats the other daylight-saving offset as travel: a summer trip to Europe is UTC+2', function () {
      tz.isAwayAt(moment('2026-09-28T12:00:00Z').valueOf(), { utcOffset: 120 }).should.equal(true);
      tz.isAwayAt(winter, { utcOffset: 180 }).should.equal(true);
      tz.isAwayAt(winter, { utcOffset: 60 }).should.equal(true);
    });

    it('is false when nothing is known', function () {
      make({}).isAwayAt(winter, { utcOffset: 540 }).should.equal(false);
    });
  });

  describe('Loop-style fixed-offset profiles (pump time zone)', function () {
    // Loop writes the pump's zone as ETC/GMT+N (IANA sign: GMT+7 is UTC-7)
    var history = [
      storeProfile('2026-10-06T00:00:00Z', 'ETC/GMT-3') // back home, Israel summer time
      , storeProfile('2026-09-20T12:00:00Z', 'ETC/GMT-2') // on a trip to Europe, UTC+2
      , storeProfile('2026-04-02T00:00:00Z', 'ETC/GMT-3') // Israel summer time, synced 6 days late
      , storeProfile('2020-01-01T00:00:00Z', 'ETC/GMT-2') // Israel winter time
    ];
    var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profileWith(history));

    it('detects the trip from the profile history alone', function () {
      var onTrip = moment('2026-09-28T12:00:00Z').valueOf();
      var resolved = tz.patientAt(onTrip, { utcOffset: 0 });
      resolved.offset.should.equal(120);
      resolved.source.should.equal('profile');
      tz.isAwayAt(onTrip, { utcOffset: 0 }).should.equal(true);
      tz.zoneLabel(resolved.zone, resolved.offset).should.equal('UTC+2');
    });

    it('does not flag the daylight-saving changes, nor a late pump re-sync, as trips', function () {
      tz.isAwayAt(moment('2026-02-10T12:00:00Z').valueOf(), null).should.equal(false); // GMT-2 in winter
      tz.isAwayAt(moment('2026-03-30T12:00:00Z').valueOf(), null).should.equal(false); // still GMT-2, 3 days into summer time
      tz.isAwayAt(moment('2026-06-10T12:00:00Z').valueOf(), null).should.equal(false); // GMT-3 in summer
      tz.isAwayAt(moment('2026-10-20T12:00:00Z').valueOf(), null).should.equal(false); // GMT-3 after the trip
    });

    it('status() reports the trip while it is current', function () {
      var during = tz.status({}, moment('2026-10-01T12:00:00Z').valueOf());
      during.away.should.equal(true);
      during.patient.offset.should.equal(120);
      tz.status({}, moment('2026-10-07T12:00:00Z').valueOf()).away.should.equal(false);
    });
  });

  describe('homeDifference / differenceText', function () {
    var tz = make({ homeTimezone: 'Asia/Jerusalem' });
    var september = moment('2026-09-28T12:00:00Z').valueOf(); // Israel UTC+3

    it('gives the minutes ahead of (or behind) home', function () {
      tz.homeDifference(-240, september).should.equal(-420);
      tz.homeDifference(540, september).should.equal(360);
      tz.homeDifference(180, september).should.equal(0);
      (tz.homeDifference(null, september) === null).should.equal(true);
      (make({}).homeDifference(120, september) === null).should.equal(true);
    });

    it('formats the difference in hours and minutes', function () {
      tz.differenceText(-420).should.equal('7h behind home');
      tz.differenceText(360).should.equal('6h ahead of home');
      tz.differenceText(150).should.equal('2h 30m ahead of home');
      tz.differenceText(0).should.equal('');
      tz.differenceText(null).should.equal('');
    });

    it('translates through the given function', function () {
      var seen = [];
      tz.differenceText(-60, function (text, options) { seen.push(text, options.params[0]); return 'x'; }).should.equal('x');
      seen.should.eql(['%1 behind home', '1h']);
    });
  });

  describe('zoneLabel', function () {
    var tz = make({});

    it('names IANA zones with their offset and fixed zones by offset only', function () {
      tz.zoneLabel('Asia/Jerusalem', 120).should.equal('Asia/Jerusalem (UTC+2)');
      tz.zoneLabel('Etc/GMT+4', -240).should.equal('UTC-4');
      tz.zoneLabel('+05:30', 330).should.equal('UTC+5:30');
      tz.zoneLabel(null, 540).should.equal('UTC+9');
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

  describe('travel periods declared by hand (TRAVEL_PERIODS)', function () {
    var profile = profileWith([storeProfile('2020-01-01', 'Asia/Jerusalem')]);
    var settings = {
      homeTimezone: 'Asia/Jerusalem'
      , travelPeriods: '2026-09-20..2026-10-05=America/New_York, 2026-12-24..2026-12-31=Europe/London bogus 2026-01-01..2026-01-02=Mars/Olympus'
    };

    it('parses the valid entries and skips the rest', function () {
      var periods = make(settings, profile).travelPeriods();
      periods.length.should.equal(2);
      periods[0].zone.should.equal('America/New_York');
      periods[1].zone.should.equal('Europe/London');
    });

    it('covers the whole trip, from home midnight on the first day to the end of the last day there', function () {
      var tz = make(settings, profile);
      // 20 Sep 00:00 Israel (UTC+3) = 19 Sep 21:00Z
      (tz.travelPeriodAt(moment('2026-09-19T20:59:00Z').valueOf()) === null).should.equal(true);
      tz.travelPeriodAt(moment('2026-09-19T21:00:00Z').valueOf()).zone.should.equal('America/New_York');
      // 5 Oct 23:59 New York (UTC-4) = 6 Oct 03:59Z
      tz.travelPeriodAt(moment('2026-10-06T03:59:00Z').valueOf()).zone.should.equal('America/New_York');
      (tz.travelPeriodAt(moment('2026-10-06T04:00:00Z').valueOf()) === null).should.equal(true);
    });

    it('is used for records without their own offset, over the profile zone', function () {
      var tz = make(settings, profile);
      var onTrip = moment('2026-09-28T12:00:00Z').valueOf();
      var resolved = tz.patientAt(onTrip, { utcOffset: 0 });
      resolved.source.should.equal('travel');
      resolved.zone.should.equal('America/New_York');
      resolved.offset.should.equal(-240);
      tz.isAwayAt(onTrip, { utcOffset: 0 }).should.equal(true);
      tz.momentAt(onTrip, { utcOffset: 0 }).format('HH:mm').should.equal('08:00');
    });

    it('does not override a record that says where it was', function () {
      var tz = make(settings, profile);
      tz.patientAt(moment('2026-09-28T12:00:00Z').valueOf(), { utcOffset: 540 }).source.should.equal('record');
    });

    it('is ignored outside the declared dates', function () {
      var tz = make(settings, profile);
      tz.patientAt(moment('2026-10-20T12:00:00Z').valueOf(), null).source.should.equal('profile');
    });

    it('re-parses when the setting changes', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem', travelPeriods: '' }, profile);
      tz.travelPeriods().length.should.equal(0);
      tz.setSettings(settings);
      tz.travelPeriods().length.should.equal(2);
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

  describe('a pump offset that counts as home shows home\'s real clock', function () {
    // Israel left daylight saving on 2024-10-27 (UTC+3 -> UTC+2); the pump
    // kept UTC+3 until it was re-synced.
    var afterChange = moment('2024-10-30T12:00:00Z').valueOf();
    var profile = profileWith([storeProfile('2024-06-01', 'ETC/GMT-3')]);
    var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profile);

    it('is home at its current offset during the daylight-saving grace', function () {
      var at = tz.patientAt(afterChange, null);
      at.offset.should.equal(120);
      at.zone.should.equal('Asia/Jerusalem');
      at.source.should.equal('home');
      tz.isAwayAt(afterChange, null).should.equal(false);
    });

    it('still reports the pump zone itself when it is home\'s current offset', function () {
      var before = moment('2024-10-20T12:00:00Z').valueOf();
      var at = tz.patientAt(before, null);
      at.offset.should.equal(180);
      at.source.should.equal('profile');
    });

    it('does not mistake a trip for the grace', function () {
      // Europe in summer is UTC+2, Israel's winter offset, but not within two
      // weeks of a change at home.
      var europe = make({ homeTimezone: 'Asia/Jerusalem' }, profileWith([storeProfile('2024-06-01', 'ETC/GMT-2')]));
      var at = europe.patientAt(summer, null);
      at.offset.should.equal(120);
      at.source.should.equal('profile');
      europe.isAwayAt(summer, null).should.equal(true);
    });
  });

  describe('dayStart / dayOf (report days in the patient\'s clock)', function () {
    // The pump time zone history Loop recorded on a trip from Israel to the
    // US: synced to UTC-4 after landing on 25 Sep, UTC-5 on 29 Sep, UTC+2 at a
    // stopover and back to UTC+3 at home on 6 Oct. Newest first, as the API
    // returns them.
    var trip = profileWith([
      storeProfile('2026-10-06T16:18:00Z', 'ETC/GMT-3')
      , storeProfile('2026-10-06T07:08:00Z', 'ETC/GMT-2')
      , storeProfile('2026-09-29T14:00:00Z', 'ETC/GMT+5')
      , storeProfile('2026-09-25T17:07:00Z', 'ETC/GMT+4')
      , storeProfile('2026-06-01T00:00:00Z', 'ETC/GMT-3')
    ]);
    var tz = make({ homeTimezone: 'Asia/Jerusalem' }, trip);

    function iso (mom) { return mom.clone().utc().format(); }

    it('starts a home day at home\'s midnight', function () {
      iso(tz.dayStart('2026-09-24')).should.equal('2026-09-23T21:00:00Z');
      tz.dayStart('2026-09-24').utcOffset().should.equal(180);
      iso(tz.dayStart('2026-10-07')).should.equal('2026-10-06T21:00:00Z');
    });

    it('shows the day the pump was synced abroad in the destination\'s clock', function () {
      var start = tz.dayStart('2026-09-25');
      iso(start).should.equal('2026-09-25T04:00:00Z');
      start.utcOffset().should.equal(-240);
      start.format('HH:mm').should.equal('00:00');
    });

    it('follows the patient through the trip', function () {
      iso(tz.dayStart('2026-09-27')).should.equal('2026-09-27T04:00:00Z');
      iso(tz.dayStart('2026-09-30')).should.equal('2026-09-30T05:00:00Z');
      iso(tz.dayStart('2026-10-05')).should.equal('2026-10-05T05:00:00Z');
    });

    it('shows the day of the flight home in home\'s clock', function () {
      var start = tz.dayStart('2026-10-06');
      iso(start).should.equal('2026-10-05T21:00:00Z');
      start.utcOffset().should.equal(180);
    });

    it('keeps a 7:00 meal at 7:00 wherever it was eaten', function () {
      var breakfastInNewYork = moment('2026-09-27T11:00:00Z').valueOf();
      tz.momentAt(breakfastInNewYork, null).format('HH:mm').should.equal('07:00');
      tz.dayOf(breakfastInNewYork, null).should.equal('2026-09-27');
      var dinnerInChicago = moment('2026-10-02T00:30:00Z').valueOf();
      tz.momentAt(dinnerInChicago, null).format('HH:mm').should.equal('19:30');
      tz.dayOf(dinnerInChicago, null).should.equal('2026-10-01');
    });

    it('notes every day from the first pump change until the zone is set back home', function () {
      var ONE_HOUR = 60 * 60 * 1000;
      function awayOnDay (day) {
        var start = tz.dayStart(day).valueOf();
        return [1, 4, 7, 10, 13, 16, 19, 22].some(function (hour) {
          return tz.isAwayAt(start + hour * ONE_HOUR, null);
        });
      }
      var away = [];
      for (var d = moment.utc('2026-09-20'); d.isBefore(moment.utc('2026-10-10')); d.add(1, 'day')) {
        if (awayOnDay(d.format('YYYY-MM-DD'))) away.push(d.format('YYYY-MM-DD'));
      }
      away.should.eql([
        '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30'
        , '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'
      ]);
    });

    it('is the profile zone of the day in profile mode', function () {
      var profileMode = make({ timeDisplay: 'profile', homeTimezone: 'Asia/Jerusalem' }, trip);
      iso(profileMode.dayStart('2026-09-27')).should.equal('2026-09-27T04:00:00Z');
      iso(profileMode.dayStart('2026-09-24')).should.equal('2026-09-23T21:00:00Z');
    });

    it('is the browser\'s midnight in browser mode', function () {
      var browser = make({ timeDisplay: 'browser', homeTimezone: 'Asia/Jerusalem' }, trip);
      browser.dayStart('2026-09-27').valueOf().should.equal(moment('2026-09-27', 'YYYY-MM-DD').valueOf());
    });

    it('uses an IANA zone with its daylight saving when one is known', function () {
      var declared = make({ homeTimezone: 'Asia/Jerusalem', travelPeriods: '2024-03-05..2024-03-15=America/New_York' }, null);
      // New York moved to daylight saving on 2024-03-10
      iso(declared.dayStart('2024-03-08')).should.equal('2024-03-08T05:00:00Z');
      iso(declared.dayStart('2024-03-12')).should.equal('2024-03-12T04:00:00Z');
    });
  });
});
