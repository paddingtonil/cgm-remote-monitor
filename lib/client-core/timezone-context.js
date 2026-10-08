'use strict';

/*
 * lib/client-core/timezone-context.js
 *
 * Decides which wall clock a time is shown in, and whether the patient is
 * away from home. Shared by the dashboard, the reports and the server.
 *
 * Where the patient was at an instant is resolved in layers:
 *
 *   1. the record's own `utcOffset` (minutes east of UTC), when it is not
 *      zero. Uploaders such as Loop and AAPS send UTC timestamps regardless
 *      of where the phone is, so a zero is treated as unknown, not as UTC
 *      (see lib/utc-offset.js);
 *   2. a trip declared by hand in `TRAVEL_PERIODS`
 *      ("2026-09-20..2026-10-05=America/New_York", space or comma separated),
 *      for uploaders that leave no trace of the phone's zone;
 *   3. the timezone of the profile in effect at that instant. Loop and Trio
 *      re-upload the profile with the phone's current zone, so the profile
 *      history records travel;
 *   4. the home timezone (`HOME_TIMEZONE`, else the current profile zone).
 *
 * The display mode (`TIME_DISPLAY`) picks the clock: 'patient' (default),
 * 'profile' or 'browser'.
 *
 * Usage:
 *   var tz = require('./timezone-context')({ moment, settings, profile });
 *   tz.momentAt(treatment.mills, treatment).format('LT')
 *   tz.status(ddata, Date.now()).away
 */

var utcOffset = require('../utc-offset');

var MODES = ['patient', 'profile', 'browser'];
var DEFAULT_MODE = 'patient';
var RECENT_WINDOW_MS = 3 * 60 * 60 * 1000;
var FIXED_OFFSET_RE = /^[+-]\d{2}:\d{2}$/;

function init (ctx) {
  ctx = ctx || {};
  var moment = ctx.moment;
  var settings = ctx.settings || {};
  var profile = ctx.profile || null;

  var tz = {};

  tz.MODES = MODES;

  /** Use a (possibly later created) profilefunctions instance. */
  tz.setProfile = function setProfile (p) {
    profile = p;
  };

  tz.setSettings = function setSettings (s) {
    settings = s || {};
  };

  tz.mode = function mode () {
    var m = settings.timeDisplay;
    return MODES.indexOf(m) >= 0 ? m : DEFAULT_MODE;
  };

  function hasProfile () {
    return !!(profile && profile.hasData && profile.hasData());
  }

  /**
   * UTC offset of a zone at an instant. The zone is an IANA name or a
   * fixed-offset string. Null for an unknown zone.
   */
  tz.zoneOffsetAt = function zoneOffsetAt (zone, mills) {
    if (!zone || typeof zone !== 'string') return null;
    if (FIXED_OFFSET_RE.test(zone)) {
      return moment.parseZone('2000-01-01T00:00:00' + zone).utcOffset();
    }
    if (!moment.tz || !moment.tz.zone(zone)) return null;
    return moment(mills).tz(zone).utcOffset();
  };

  /** The home zone: HOME_TIMEZONE, else the current profile zone. */
  tz.homeZone = function homeZone () {
    var configured = typeof settings.homeTimezone === 'string' ? settings.homeTimezone.trim() : '';
    if (configured && moment.tz && moment.tz.zone(configured)) return configured;
    if (hasProfile()) return profile.getTimezone() || null;
    return null;
  };

  tz.homeOffsetAt = function homeOffsetAt (mills) {
    return tz.zoneOffsetAt(tz.homeZone(), mills);
  };

  var parsedPeriodsSource = null;
  var parsedPeriods = [];

  /**
   * The declared trips (TRAVEL_PERIODS), parsed once per setting value:
   * [{ start: mills, end: mills, zone }]. A period runs from midnight at the
   * start date in the home zone to the end of the end date in the trip zone.
   * Malformed entries and unknown zones are skipped.
   */
  tz.travelPeriods = function travelPeriods () {
    var source = typeof settings.travelPeriods === 'string' ? settings.travelPeriods.trim() : '';
    if (source === parsedPeriodsSource) return parsedPeriods;
    parsedPeriodsSource = source;
    parsedPeriods = [];
    if (!source || !moment.tz) return parsedPeriods;

    source.split(/[\s,;]+/).forEach(function eachEntry (entry) {
      var match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})=(.+)$/.exec(entry);
      if (!match || !moment.tz.zone(match[3])) return;
      var homeZone = tz.homeZone();
      var start = homeZone && moment.tz.zone(homeZone) ? moment.tz(match[1], homeZone) : moment.utc(match[1]);
      var end = moment.tz(match[2], match[3]).endOf('day');
      if (!start.isValid() || !end.isValid() || end.valueOf() < start.valueOf()) return;
      parsedPeriods.push({ start: start.valueOf(), end: end.valueOf(), zone: match[3] });
    });
    return parsedPeriods;
  };

  /** Layer 2: the declared trip covering the instant, or null. */
  tz.travelPeriodAt = function travelPeriodAt (mills) {
    var periods = tz.travelPeriods();
    for (var i = 0; i < periods.length; i++) {
      if (mills >= periods[i].start && mills <= periods[i].end) return periods[i];
    }
    return null;
  };

  /** Layer 1: the record's own offset, or null when absent or zero. */
  tz.recordOffset = function recordOffset (record) {
    if (!record || !utcOffset.isValid(record.utcOffset)) return null;
    var offset = Number(record.utcOffset);
    return offset === 0 ? null : offset;
  };

  /** Layer 3: the offset of the profile zone in effect at the instant. */
  tz.profileZoneAt = function profileZoneAt (mills) {
    if (!hasProfile()) return null;
    return (profile.getTimezoneAt ? profile.getTimezoneAt(mills) : profile.getTimezone()) || null;
  };

  tz.profileOffsetAt = function profileOffsetAt (mills) {
    return tz.zoneOffsetAt(tz.profileZoneAt(mills), mills);
  };

  /**
   * Where the patient was at an instant.
   * @returns {{offset: number|null, zone: string|null, source: 'record'|'travel'|'profile'|'home'|'unknown'}}
   */
  tz.patientAt = function patientAt (mills, record) {
    var offset = tz.recordOffset(record);
    if (offset !== null) return { offset: offset, zone: null, source: 'record' };

    var period = tz.travelPeriodAt(mills);
    if (period) {
      offset = tz.zoneOffsetAt(period.zone, mills);
      if (offset !== null) return { offset: offset, zone: period.zone, source: 'travel' };
    }

    var zone = tz.profileZoneAt(mills);
    offset = tz.zoneOffsetAt(zone, mills);
    if (offset !== null) return { offset: offset, zone: zone, source: 'profile' };

    zone = tz.homeZone();
    offset = tz.zoneOffsetAt(zone, mills);
    if (offset !== null) return { offset: offset, zone: zone, source: 'home' };

    return { offset: null, zone: null, source: 'unknown' };
  };

  /**
   * The offset times are displayed in, for the active mode. Null means the
   * browser's own clock (nothing better is known).
   */
  tz.displayOffsetAt = function displayOffsetAt (mills, record) {
    var mode = tz.mode();
    if (mode === 'browser') return null;
    if (mode === 'profile') {
      var profileOffset = tz.profileOffsetAt(mills);
      return profileOffset !== null ? profileOffset : tz.homeOffsetAt(mills);
    }
    return tz.patientAt(mills, record).offset;
  };

  /** A moment at `mills` set to the display offset for that instant. */
  tz.momentAt = function momentAt (mills, record) {
    var mom = moment(mills);
    var offset = tz.displayOffsetAt(mills, record);
    return offset === null ? mom : mom.utcOffset(offset);
  };

  /** Format an instant in the display clock with a moment format string. */
  tz.format = function format (mills, fmt, record) {
    return tz.momentAt(mills, record).format(fmt);
  };

  /** Whether the patient was away from home at an instant. */
  tz.isAwayAt = function isAwayAt (mills, record) {
    var patient = tz.patientAt(mills, record).offset;
    var home = tz.homeOffsetAt(mills);
    if (patient === null || home === null) return false;
    return patient !== home;
  };

  function newestRecordWithOffset (records, now, windowMs) {
    if (!Array.isArray(records)) return null;
    var best = null;
    for (var i = records.length - 1; i >= 0; i--) {
      var record = records[i];
      if (!record || typeof record.mills !== 'number') continue;
      if (record.mills > now || now - record.mills > windowMs) continue;
      if (tz.recordOffset(record) === null) continue;
      if (!best || record.mills > best.mills) best = record;
    }
    return best;
  }

  /**
   * Where the patient is now, from the newest recent record that carries an
   * offset (treatments and SGVs), else the profile zone, else home.
   * @param {Object} data - ddata-like: { treatments, sgvs }
   * @param {number} now
   * @param {number} [windowMs] - how far back a record still counts as "now"
   */
  tz.currentPatient = function currentPatient (data, now, windowMs) {
    data = data || {};
    windowMs = windowMs || RECENT_WINDOW_MS;
    var newest = null;
    [data.treatments, data.sgvs].forEach(function eachList (list) {
      var candidate = newestRecordWithOffset(list, now, windowMs);
      if (candidate && (!newest || candidate.mills > newest.mills)) newest = candidate;
    });
    if (newest) {
      return { offset: tz.recordOffset(newest), zone: null, source: 'record', since: newest.mills };
    }
    var resolved = tz.patientAt(now, null);
    resolved.since = null;
    return resolved;
  };

  /**
   * The offset the current time is displayed in, for the active mode: where
   * the patient is now. Null means the browser's own clock.
   */
  tz.displayOffsetNow = function displayOffsetNow (data, now) {
    var mode = tz.mode();
    if (mode === 'browser') return null;
    if (mode === 'profile') {
      var profileOffset = tz.profileOffsetAt(now);
      return profileOffset !== null ? profileOffset : tz.homeOffsetAt(now);
    }
    return tz.currentPatient(data, now).offset;
  };

  /**
   * Summary for the travelling indicator.
   * @returns {{mode: string, home: {zone, offset}, patient: {offset, zone, source}, away: boolean, known: boolean}}
   */
  tz.status = function status (data, now) {
    var home = { zone: tz.homeZone(), offset: tz.homeOffsetAt(now) };
    var patient = tz.currentPatient(data, now);
    var known = patient.offset !== null;
    var away = known && home.offset !== null && patient.offset !== home.offset;
    return { mode: tz.mode(), home: home, patient: patient, away: away, known: known };
  };

  tz.label = utcOffset.label;

  return tz;
}

module.exports = init;
module.exports.MODES = MODES;
module.exports.DEFAULT_MODE = DEFAULT_MODE;
