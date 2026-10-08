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
 *   2. a trip declared by hand: a `Travel` treatment entered on the site
 *      (careportal "Trip": start date, end date, zone; see
 *      lib/plugins/timezone.js), or an entry in `TRAVEL_PERIODS`
 *      ("2026-09-20..2026-10-05=America/New_York", space or comma separated).
 *      Either covers uploaders that leave no trace of the phone's zone, and
 *      corrects the automatic detection when the pump clock was not synced;
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
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The treatment eventType a trip declared on the site is stored under. */
var TRAVEL_EVENT_TYPE = 'Travel';

function isTravelTreatment (treatment) {
  return !!treatment && treatment.eventType === TRAVEL_EVENT_TYPE;
}

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

  var DST_SYNC_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

  /**
   * The offsets that count as home at an instant: home's offset then, plus,
   * for two weeks after a daylight-saving change at home, the offset from
   * before the change. Loop writes the pump's zone into the profile as a
   * fixed offset (ETC/GMT+N), which changes at a daylight-saving transition
   * as much as on a trip, and the pump is often re-synced days later. The
   * grace is deliberately short: a summer trip from Israel (UTC+3) to Europe
   * (UTC+2) must not be mistaken for Israel's own winter offset.
   */
  tz.homeOffsets = function homeOffsets (mills) {
    var offsets = [];
    var now = tz.homeOffsetAt(mills);
    if (now === null) return offsets;
    offsets.push(now);
    var before = tz.homeOffsetAt(mills - DST_SYNC_GRACE_MS);
    if (before !== null && before !== now) offsets.push(before);
    return offsets;
  };

  /** Whether an offset counts as home at that instant (see homeOffsets). */
  tz.isHomeOffset = function isHomeOffset (offset, mills) {
    if (offset === null || offset === undefined) return false;
    return tz.homeOffsets(mills).indexOf(offset) >= 0;
  };

  /**
   * Minutes the patient's clock is ahead of home's at an instant (negative
   * when behind), or null when either side is unknown.
   */
  tz.homeDifference = function homeDifference (offset, mills) {
    var home = tz.homeOffsetAt(mills);
    if (offset === null || offset === undefined || home === null) return null;
    return offset - home;
  };

  /**
   * Text for a difference from home, e.g. "7h behind home", "5h 30m ahead of
   * home", or '' when there is none. `translate` is optional.
   */
  tz.differenceText = function differenceText (minutes, translate) {
    translate = translate || function identity (text, options) {
      return text.replace('%1', options && options.params ? options.params[0] : '');
    };
    if (minutes === null || minutes === undefined || minutes === 0) return '';
    var abs = Math.abs(minutes);
    var text = Math.floor(abs / 60) + 'h' + (abs % 60 ? ' ' + (abs % 60) + 'm' : '');
    return translate(minutes < 0 ? '%1 behind home' : '%1 ahead of home', { params: [text] });
  };

  /**
   * A label for a zone: the IANA name with its offset, or just the offset for
   * fixed-offset zones (Etc/GMT+N, +05:30), whose names read inverted.
   */
  tz.zoneLabel = function zoneLabel (zone, offset) {
    var offsetLabel = utcOffset.label(offset);
    if (!zone || FIXED_OFFSET_RE.test(zone) || /^Etc\//i.test(zone)) return offsetLabel;
    return offsetLabel && zone !== offsetLabel ? zone + ' (' + offsetLabel + ')' : zone;
  };

  /** Midnight starting a calendar day ('YYYY-MM-DD') in the home zone. */
  function homeMidnight (day) {
    var homeZone = tz.homeZone();
    return homeZone && moment.tz.zone(homeZone) ? moment.tz(day, 'YYYY-MM-DD', homeZone) : moment.utc(day, 'YYYY-MM-DD');
  }

  /**
   * A trip from its dates and zone, or null when it does not make sense. A
   * trip runs from midnight at the start date in the home zone to the end of
   * the end date in the trip zone; without an end date it is open-ended.
   * @returns {{start: number, end: number, zone: string, startDate: string, endDate: string|null}|null}
   */
  tz.tripFrom = function tripFrom (startDate, endDate, zone) {
    if (!moment.tz || typeof zone !== 'string' || !moment.tz.zone(zone)) return null;
    if (!DATE_RE.test(startDate || '')) return null;
    var start = homeMidnight(startDate);
    if (!start.isValid()) return null;
    var trip = { start: start.valueOf(), end: Infinity, zone: zone, startDate: startDate, endDate: null };
    if (endDate) {
      if (!DATE_RE.test(endDate)) return null;
      var end = moment.tz(endDate, 'YYYY-MM-DD', zone).endOf('day');
      if (!end.isValid() || end.valueOf() < trip.start) return null;
      trip.end = end.valueOf();
      trip.endDate = endDate;
    }
    return trip;
  };

  /**
   * The trip a `Travel` treatment declares, or null for anything else. The
   * treatment carries `timezone`, `startDate` and optionally `endDate`
   * ('YYYY-MM-DD'); an old record without a start date starts at its
   * created_at, in the home zone.
   */
  tz.tripFromTreatment = function tripFromTreatment (treatment) {
    if (!isTravelTreatment(treatment)) return null;
    var startDate = treatment.startDate;
    if (!startDate && treatment.created_at && moment.tz) {
      var homeZone = tz.homeZone();
      var created = homeZone && moment.tz.zone(homeZone) ? moment(treatment.created_at).tz(homeZone) : moment.utc(treatment.created_at);
      if (created.isValid()) startDate = created.format('YYYY-MM-DD');
    }
    var trip = tz.tripFrom(startDate, treatment.endDate, treatment.timezone);
    if (!trip) return null;
    trip.id = treatment._id ? String(treatment._id) : null;
    trip.treatment = treatment;
    return trip;
  };

  var declaredTrips = [];

  /**
   * Take the trips declared on the site from a list of treatments (only the
   * `Travel` ones count; anything else in the list is ignored). The dashboard
   * passes ddata.treatments on every update, the reports what they fetch.
   * Later declarations win where two overlap.
   */
  tz.setDeclaredTrips = function setDeclaredTrips (treatments) {
    declaredTrips = (Array.isArray(treatments) ? treatments : [])
      .map(tz.tripFromTreatment)
      .filter(function valid (trip) { return !!trip; })
      .sort(function newestFirst (a, b) {
        var at = a.treatment.created_at ? new Date(a.treatment.created_at).getTime() : 0;
        var bt = b.treatment.created_at ? new Date(b.treatment.created_at).getTime() : 0;
        return bt - at || b.start - a.start;
      });
  };

  /** The trips declared on the site, newest declaration first. */
  tz.declaredTrips = function getDeclaredTrips () {
    return declaredTrips;
  };

  var parsedPeriodsSource = null;
  var parsedPeriods = [];

  /**
   * The trips declared in TRAVEL_PERIODS, parsed once per setting value.
   * Malformed entries and unknown zones are skipped.
   */
  function settingPeriods () {
    var source = typeof settings.travelPeriods === 'string' ? settings.travelPeriods.trim() : '';
    if (source === parsedPeriodsSource) return parsedPeriods;
    parsedPeriodsSource = source;
    parsedPeriods = [];
    if (!source || !moment.tz) return parsedPeriods;

    source.split(/[\s,;]+/).forEach(function eachEntry (entry) {
      var match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})=(.+)$/.exec(entry);
      if (!match) return;
      var trip = tz.tripFrom(match[1], match[2], match[3]);
      if (trip) parsedPeriods.push(trip);
    });
    return parsedPeriods;
  }

  /**
   * Every declared trip, [{ start: mills, end: mills, zone, ... }]: the
   * `Travel` treatments entered on the site first, then TRAVEL_PERIODS.
   */
  tz.travelPeriods = function travelPeriods () {
    return declaredTrips.concat(settingPeriods());
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
    if (offset !== null) {
      // A pump offset that counts as home is home: show home's real clock,
      // not the pump's stale fixed offset in the weeks after a
      // daylight-saving change (see homeOffsets).
      var homeZone = tz.homeZone();
      var homeOffset = tz.zoneOffsetAt(homeZone, mills);
      if (homeOffset !== null && offset !== homeOffset && tz.isHomeOffset(offset, mills)) {
        return { offset: homeOffset, zone: homeZone, source: 'home' };
      }
      return { offset: offset, zone: zone, source: 'profile' };
    }

    zone = tz.homeZone();
    offset = tz.zoneOffsetAt(zone, mills);
    if (offset !== null) return { offset: offset, zone: zone, source: 'home' };

    return { offset: null, zone: null, source: 'unknown' };
  };

  var DAY_MS = 24 * 60 * 60 * 1000;

  /** Midnight starting a calendar day ('YYYY-MM-DD') in a resolved location. */
  function startOfDayIn (day, resolved) {
    if (resolved && resolved.zone && moment.tz && moment.tz.zone(resolved.zone)) {
      return moment.tz(day, 'YYYY-MM-DD', resolved.zone);
    }
    if (resolved && resolved.offset !== null && resolved.offset !== undefined) {
      return moment.utc(day, 'YYYY-MM-DD').utcOffset(resolved.offset, true);
    }
    return moment(day, 'YYYY-MM-DD');
  }

  /**
   * The instant a report day ('YYYY-MM-DD') begins, as a moment set to the
   * clock that day is shown in. In the patient mode that is the patient's
   * day where they ended it: a day spent flying out already reads in the
   * destination's time, and the day of the flight home reads in home's. The
   * zone is settled by resolving the location at the end of the candidate
   * day until it stops moving. Browser mode is the browser's midnight.
   */
  tz.dayStart = function dayStart (day) {
    var mode = tz.mode();
    if (mode === 'browser') return startOfDayIn(day, null);

    var midday = moment.utc(day, 'YYYY-MM-DD').valueOf() + DAY_MS / 2;
    if (mode === 'profile') {
      var zone = tz.profileZoneAt(midday) || tz.homeZone();
      return startOfDayIn(day, { zone: zone, offset: tz.zoneOffsetAt(zone, midday) });
    }

    var resolved = tz.patientAt(midday, null);
    var start = startOfDayIn(day, resolved);
    for (var i = 0; i < 2; i++) {
      var atEnd = tz.patientAt(start.valueOf() + DAY_MS - 1, null);
      if (atEnd.offset === resolved.offset) break;
      resolved = atEnd;
      start = startOfDayIn(day, resolved);
    }
    return start;
  };

  /** The calendar day ('YYYY-MM-DD') an instant falls on in the display clock. */
  tz.dayOf = function dayOf (mills, record) {
    return tz.momentAt(mills, record).format('YYYY-MM-DD');
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

  /**
   * Whether the patient was away from home at an instant: a known offset
   * that is neither home's standard nor daylight-saving offset.
   */
  tz.isAwayAt = function isAwayAt (mills, record) {
    var patient = tz.patientAt(mills, record).offset;
    if (patient === null || tz.homeOffsetAt(mills) === null) return false;
    return !tz.isHomeOffset(patient, mills);
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
    var away = known && home.offset !== null && !tz.isHomeOffset(patient.offset, now);
    return { mode: tz.mode(), home: home, patient: patient, away: away, known: known };
  };

  tz.label = utcOffset.label;

  return tz;
}

module.exports = init;
module.exports.MODES = MODES;
module.exports.DEFAULT_MODE = DEFAULT_MODE;
module.exports.TRAVEL_EVENT_TYPE = TRAVEL_EVENT_TYPE;
module.exports.isTravelTreatment = isTravelTreatment;
