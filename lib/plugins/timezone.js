'use strict';

/*
 * Travelling indicator, and the careportal "Trip" entry.
 *
 * A status pill that appears when the patient's current timezone differs
 * from home (HOME_TIMEZONE, else the profile timezone), so a caregiver
 * knows the times on the page are the patient's local wall clock and not
 * their own. Hidden while the patient is at home. The resolution of where
 * the patient is lives in lib/client-core/timezone-context.js.
 *
 * The plugin also adds a "Trip" event type to the careportal, so a trip can
 * be declared on the site when the automatic detection (the pump time zone
 * Loop / Trio write into the profile) has nothing to go on. A declaration is
 * stored as a `Travel` treatment with `timezone`, `startDate` and an optional
 * `endDate`, and takes precedence over the detected zone for those days.
 */

var utcOffset = require('../utc-offset');
var timezoneContext = require('../client-core/timezone-context');

function init (ctx) {
  var translate = ctx.language.translate;

  var timezone = {
    name: 'timezone'
    , label: 'Time zone'
    , pluginType: 'pill-status'
  };

  /**
   * Save a trip declared in the careportal as a `Travel` treatment. The
   * record's own timestamp is the first day's midnight at home, written as
   * UTC: the trip's dates and zone are what the resolver reads, and a zero
   * offset keeps the record itself from being taken for a location fix.
   */
  function postTrip (client, data, callback) {
    var tz = client.tz;
    var trip = tz && tz.tripFrom ? tz.tripFrom(data.startDate, data.endDate, data.timezone) : null;
    if (!trip) {
      callback(translate('Please enter the first day of the trip') + ', ' + translate('Please select the time zone of the trip'));
      return;
    }

    var treatment = {
      eventType: timezoneContext.TRAVEL_EVENT_TYPE
      , timezone: trip.zone
      , startDate: trip.startDate
      , created_at: new Date(trip.start).toISOString()
      , enteredBy: data.enteredBy
      , notes: data.notes
    };
    if (trip.endDate) treatment.endDate = trip.endDate;
    Object.keys(treatment).forEach(function dropEmpty (key) {
      if (treatment[key] === undefined || treatment[key] === '') delete treatment[key];
    });

    $.ajax({
      method: 'POST'
      , url: '/api/v1/treatments/'
      , headers: client.headers()
      , data: treatment
    }).done(function tripSaved () {
      callback();
    }).fail(function tripSaveFailed (jqXHR) {
      callback(translate('Entering record failed') + '. ' + translate('Status') + ': ' + jqXHR.status);
    });
  }

  timezone.getEventTypes = function getEventTypes () {
    return [
      {
        val: timezoneContext.TRAVEL_EVENT_TYPE
        , name: 'Trip'
        , bg: false, insulin: false, carbs: false, protein: false, fat: false, prebolus: false
        , duration: false, percent: false, absolute: false, profile: false, split: false, sensor: false
        , travel: true
        , submitHook: postTrip
      }
    ];
  };

  timezone.setProperties = function setProperties (sbx) {
    sbx.offerProperty('timezone', function setTimezone () {
      if (!sbx.tz) return null;
      return sbx.tz.status(sbx.data, sbx.time);
    });
  };

  timezone.updateVisualisation = function updateVisualisation (sbx) {
    var status = sbx.properties.timezone;

    if (!status || !status.known || !status.away || status.mode === 'browser') {
      sbx.pluginBase.updatePillText(timezone, { hide: true, label: '', value: null });
      return;
    }

    var now = sbx.time;
    var patientNow = sbx.tz.momentAt(now, { utcOffset: status.patient.offset }).format('LT');
    var homeNow = status.home.offset !== null ? sbx.tz.momentAt(now, { utcOffset: status.home.offset }).format('LT') : '';

    var difference = sbx.tz.differenceText(sbx.tz.homeDifference(status.patient.offset, now), translate);
    var info = [
      { label: translate('Patient time zone'), value: sbx.tz.zoneLabel(status.patient.zone, status.patient.offset) }
      , { label: translate('Time difference'), value: difference }
      , { label: translate('Patient local time'), value: patientNow }
      , { label: translate('Home time zone'), value: sbx.tz.zoneLabel(status.home.zone, status.home.offset) }
    ];
    if (homeNow) {
      info.push({ label: translate('Home local time'), value: homeNow });
    }
    if (status.patient.since) {
      info.push({ label: translate('Away since'), value: sbx.formatDateTime(status.patient.since, { utcOffset: status.patient.offset }) });
    }
    if (status.patient.source === 'travel' && sbx.tz.travelPeriodAt) {
      var trip = sbx.tz.travelPeriodAt(now);
      if (trip && trip.startDate) {
        info.push({ label: translate('Declared trip'), value: trip.startDate + ' – ' + (trip.endDate || translate('open-ended')) });
      }
    }
    info.push({ label: translate('Browser time'), value: sbx.tz.momentAt(now, { utcOffset: utcOffset.localOffset(new Date(now)) }).format('LT') });

    sbx.pluginBase.updatePillText(timezone, {
      value: utcOffset.label(status.patient.offset) + (difference ? ' (' + difference + ')' : '')
      , label: translate('Trip')
      , info: info
      , pillClass: 'travelling'
    });
  };

  return timezone;
}

module.exports = init;
