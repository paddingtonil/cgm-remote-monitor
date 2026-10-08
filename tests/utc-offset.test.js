'use strict';

require('should');

var utcOffset = require('../lib/utc-offset');

describe('utc-offset', function () {

  describe('isValid', function () {
    it('accepts whole minutes within a day either side of UTC', function () {
      utcOffset.isValid(0).should.equal(true);
      utcOffset.isValid(180).should.equal(true);
      utcOffset.isValid(-420).should.equal(true);
      utcOffset.isValid(330).should.equal(true);
      utcOffset.isValid('120').should.equal(true);
      utcOffset.isValid(1440).should.equal(true);
    });

    it('rejects anything else', function () {
      utcOffset.isValid(undefined).should.equal(false);
      utcOffset.isValid(null).should.equal(false);
      utcOffset.isValid('').should.equal(false);
      utcOffset.isValid('abc').should.equal(false);
      utcOffset.isValid(NaN).should.equal(false);
      utcOffset.isValid(1.5).should.equal(false);
      utcOffset.isValid(1441).should.equal(false);
      utcOffset.isValid(-1441).should.equal(false);
    });
  });

  describe('explicitOffset', function () {
    it('reads the zone designator of an ISO string', function () {
      utcOffset.explicitOffset('2024-05-01T12:00:00+09:00').should.equal(540);
      utcOffset.explicitOffset('2024-05-01T12:00:00.000-05:00').should.equal(-300);
      utcOffset.explicitOffset('2024-05-01T12:00:00+0530').should.equal(330);
      utcOffset.explicitOffset('2024-05-01T12:00:00Z').should.equal(0);
      utcOffset.explicitOffset('2024-05-01T12:00:00+00:00').should.equal(0);
    });

    it('is null when there is no zone, or no string', function () {
      (utcOffset.explicitOffset('2024-05-01T12:00:00') === null).should.equal(true);
      (utcOffset.explicitOffset('2024-05-01') === null).should.equal(true);
      (utcOffset.explicitOffset(1714564800000) === null).should.equal(true);
      (utcOffset.explicitOffset(undefined) === null).should.equal(true);
    });
  });

  describe('resolve', function () {
    it('prefers a non-zero offset written into the string', function () {
      utcOffset.resolve('2024-05-01T12:00:00+09:00', 0).should.equal(540);
      utcOffset.resolve('2024-05-01T12:00:00+09:00', 180).should.equal(540);
      utcOffset.resolve('2024-05-01T12:00:00+09:00', undefined).should.equal(540);
    });

    it('trusts the client offset over a UTC string, which uploaders send regardless of location', function () {
      utcOffset.resolve('2024-05-01T12:00:00.000Z', 180).should.equal(180);
      utcOffset.resolve('2024-05-01T12:00:00.000Z', '-300').should.equal(-300);
      utcOffset.resolve('2024-05-01T12:00:00+00:00', 120).should.equal(120);
    });

    it('falls back to zero for a UTC string with no usable client offset', function () {
      utcOffset.resolve('2024-05-01T12:00:00.000Z', undefined).should.equal(0);
      utcOffset.resolve('2024-05-01T12:00:00.000Z', 'abc').should.equal(0);
      utcOffset.resolve('2024-05-01T12:00:00.000Z', 9999).should.equal(0);
    });

    it('is null for a string with no zone and no client offset', function () {
      (utcOffset.resolve('2024-05-01T12:00:00', undefined) === null).should.equal(true);
      utcOffset.resolve('2024-05-01T12:00:00', 60).should.equal(60);
    });
  });

  describe('toZonedISOString', function () {
    var instant = new Date('2024-06-01T12:00:00.000Z');

    it('writes the wall clock of the given offset with that offset as the designator', function () {
      utcOffset.toZonedISOString(instant, 540).should.equal('2024-06-01T21:00:00.000+09:00');
      utcOffset.toZonedISOString(instant, -300).should.equal('2024-06-01T07:00:00.000-05:00');
      utcOffset.toZonedISOString(instant, 330).should.equal('2024-06-01T17:30:00.000+05:30');
      utcOffset.toZonedISOString(instant, 0).should.equal('2024-06-01T12:00:00.000+00:00');
    });

    it('round-trips to the same instant', function () {
      [540, -300, 330, 0, 180, -570].forEach(function (offset) {
        new Date(utcOffset.toZonedISOString(instant, offset)).getTime().should.equal(instant.getTime());
      });
    });

    it('crosses the date line correctly', function () {
      var late = new Date('2024-06-01T23:30:00.000Z');
      utcOffset.toZonedISOString(late, 180).should.equal('2024-06-02T02:30:00.000+03:00');
      var early = new Date('2024-06-01T01:30:00.000Z');
      utcOffset.toZonedISOString(early, -300).should.equal('2024-05-31T20:30:00.000-05:00');
    });

    it('keeps milliseconds', function () {
      utcOffset.toZonedISOString(new Date('2024-06-01T12:00:00.007Z'), 60).should.equal('2024-06-01T13:00:00.007+01:00');
    });

    it('treats an invalid offset as zero', function () {
      utcOffset.toZonedISOString(instant, 'abc').should.equal('2024-06-01T12:00:00.000+00:00');
    });
  });

  describe('localOffset', function () {
    it('matches the runtime timezone', function () {
      var d = new Date();
      utcOffset.localOffset(d).should.equal(-d.getTimezoneOffset());
    });
  });

  describe('label', function () {
    it('formats offsets for display', function () {
      utcOffset.label(0).should.equal('UTC');
      utcOffset.label(180).should.equal('UTC+3');
      utcOffset.label(-300).should.equal('UTC-5');
      utcOffset.label(330).should.equal('UTC+5:30');
      utcOffset.label(-570).should.equal('UTC-9:30');
      utcOffset.label('abc').should.equal('');
    });
  });
});
