'use strict';

// Small shared formatting helpers for the AI Insights prompt templates.
// Everything here is pure and dependency-free.

const NA = 'n/a';

function isNum (n) {
  return typeof n === 'number' && isFinite(n);
}

/**
 * Seconds since midnight -> 'h:mm AM' (spec 6.5: schedule times use h:mm AM/PM).
 * 0 -> '12:00 AM', 21600 -> '6:00 AM', 45000 -> '12:30 PM'.
 */
function fmtTime12 (seconds) {
  const total = isNum(seconds) ? Math.floor(seconds) : 0;
  const h24 = Math.floor(total / 3600) % 24;
  const m = Math.floor((total % 3600) / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  return h12 + ':' + String(m).padStart(2, '0') + ' ' + suffix;
}

/**
 * Hour of day -> 'HH:00' (spec 6.5: hourly averages are labelled in 24h form).
 */
function fmtHour24 (hour) {
  const h = isNum(hour) ? Math.floor(hour) % 24 : 0;
  return String(h).padStart(2, '0') + ':00';
}

/**
 * Fixed-decimal number. null / undefined / NaN render as 'n/a'.
 */
function fmt (n, decimals) {
  if (!isNum(n)) {
    return NA;
  }
  return n.toFixed(decimals || 0);
}

/**
 * Signed fixed-decimal number: '+5', '-3', '+0'.
 */
function fmtSigned (n, decimals) {
  if (!isNum(n)) {
    return NA;
  }
  const s = fmt(Math.abs(n), decimals);
  // Treat values that round to zero as positive so we never emit '-0'.
  const negative = n < 0 && Number(s) !== 0;
  return (negative ? '-' : '+') + s;
}

/**
 * Percentage with trailing '%'.
 */
function pct (n, decimals) {
  if (!isNum(n)) {
    return NA;
  }
  return fmt(n, decimals) + '%';
}

module.exports = {
  fmtTime12
  , fmtHour24
  , fmt
  , fmtSigned
  , pct
  , NA
};
