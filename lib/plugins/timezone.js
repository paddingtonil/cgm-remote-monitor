'use strict';

/*
 * Travelling indicator.
 *
 * A status pill that appears when the patient's current timezone differs
 * from home (HOME_TIMEZONE, else the profile timezone), so a caregiver
 * knows the times on the page are the patient's local wall clock and not
 * their own. Hidden while the patient is at home. The resolution of where
 * the patient is lives in lib/client-core/timezone-context.js.
 */

var utcOffset = require('../utc-offset');

function init (ctx) {
  var translate = ctx.language.translate;

  var timezone = {
    name: 'timezone'
    , label: 'Time zone'
    , pluginType: 'pill-status'
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
