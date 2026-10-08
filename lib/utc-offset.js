'use strict';

/*
 * lib/utc-offset.js
 *
 * Helpers for the per-record UTC offset Nightscout stores next to every
 * normalized timestamp (`utcOffset`, whole minutes east of UTC).
 *
 * Timestamps are stored as UTC ("...Z"). The offset is the only record of
 * the wall clock where the patient was when the event happened, so it has
 * to be captured carefully on every write path and preserved for display.
 *
 * Pure functions, no moment dependency: shared by the browser bundle
 * (careportal) and the server (treatments, websocket).
 */

var MAX_OFFSET_MINUTES = 1440;

// A trailing zone designator: "Z", "+03:00", "-0500".
var ZONE_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Whether a value is a usable offset in minutes.
 * @param {*} value
 * @returns {boolean}
 */
function isValid (value) {
  var n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n)
    && n >= -MAX_OFFSET_MINUTES && n <= MAX_OFFSET_MINUTES;
}

/**
 * The offset written into an ISO 8601 string, in minutes, or null when the
 * string carries no zone designator (or is not a string).
 * "Z" and "+00:00" both give 0.
 * @param {*} isoString
 * @returns {number|null}
 */
function explicitOffset (isoString) {
  if (typeof isoString !== 'string') return null;
  var match = ZONE_RE.exec(isoString.trim());
  if (!match) return null;
  var zone = match[1];
  if (zone.toUpperCase() === 'Z') return 0;
  var sign = zone.charAt(0) === '-' ? -1 : 1;
  var digits = zone.slice(1).replace(':', '');
  var hours = Number(digits.slice(0, 2));
  var minutes = Number(digits.slice(2, 4));
  if (hours > 23 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

/**
 * Decide which offset to store for a record.
 *
 * An offset written into the timestamp string wins when it is not zero.
 * A zero offset ("Z") is ambiguous: uploaders such as Loop and AAPS send
 * UTC strings regardless of where the phone is, so a client-supplied
 * `utcOffset` field is trusted over it. Only when neither gives an answer
 * does a zero in the string count as zero. With no zone at all, null.
 *
 * @param {string} isoString - the timestamp as sent by the client
 * @param {*} clientOffset - the `utcOffset` field as sent by the client
 * @returns {number|null}
 */
function resolve (isoString, clientOffset) {
  var explicit = explicitOffset(isoString);
  if (explicit !== null && explicit !== 0) return explicit;
  if (isValid(clientOffset)) return Number(clientOffset);
  return explicit;
}

function pad2 (n) {
  return (n < 10 ? '0' : '') + n;
}

/**
 * Format an instant as ISO 8601 with an explicit offset instead of "Z",
 * e.g. 2024-05-01T12:00:00.000+09:00. The wall-clock fields are those of
 * the given offset, so the string says where the patient was.
 * @param {Date} date
 * @param {number} offsetMinutes - minutes east of UTC
 * @returns {string}
 */
function toZonedISOString (date, offsetMinutes) {
  var offset = isValid(offsetMinutes) ? Number(offsetMinutes) : 0;
  var shifted = new Date(date.getTime() + offset * 60000);
  var sign = offset < 0 ? '-' : '+';
  var abs = Math.abs(offset);
  var millis = String(shifted.getUTCMilliseconds());
  while (millis.length < 3) millis = '0' + millis;

  return shifted.getUTCFullYear() + '-' + pad2(shifted.getUTCMonth() + 1) + '-' + pad2(shifted.getUTCDate())
    + 'T' + pad2(shifted.getUTCHours()) + ':' + pad2(shifted.getUTCMinutes()) + ':' + pad2(shifted.getUTCSeconds())
    + '.' + millis + sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
}

/**
 * The browser's (or server's) own offset at an instant, in minutes east of UTC.
 * @param {Date} date
 * @returns {number}
 */
function localOffset (date) {
  return -date.getTimezoneOffset();
}

/**
 * Format an offset for display: "UTC+3", "UTC-5:30", "UTC".
 * @param {number} offsetMinutes
 * @returns {string}
 */
function label (offsetMinutes) {
  if (!isValid(offsetMinutes)) return '';
  var offset = Number(offsetMinutes);
  if (offset === 0) return 'UTC';
  var sign = offset < 0 ? '-' : '+';
  var abs = Math.abs(offset);
  var hours = Math.floor(abs / 60);
  var minutes = abs % 60;
  return 'UTC' + sign + hours + (minutes ? ':' + pad2(minutes) : '');
}

module.exports = {
  MAX_OFFSET_MINUTES: MAX_OFFSET_MINUTES
  , isValid: isValid
  , explicitOffset: explicitOffset
  , resolve: resolve
  , toZonedISOString: toZonedISOString
  , localOffset: localOffset
  , label: label
};
