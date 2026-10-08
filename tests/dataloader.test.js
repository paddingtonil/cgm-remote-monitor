'use strict';

const should = require('should');

const dataloaderInit = require('../lib/data/dataloader');
const createDData = require('../lib/data/ddata');

describe('dataloader', function () {
  [false, true].forEach(function (logging) {
    it('completes update with logging=' + logging + ' when db.stats is promise-based', function (done) {
      const ddata = createDData();
      ddata.processTreatments = function () {};
      const ctx = {
        settings: {},
        language: {
          translate: function (value) { return value; }
        },
        cache: {
          isEmpty: function () { return true; },
          // the loader reads entries and treatments by reference now and keeps
          // cloning device statuses, so this stub has to answer both accessors
          insertData: function (key, results) { return results; },
          insertDataRef: function (key, results) { return results; },
          getData: function () { return []; },
          getDataRef: function () { return []; },
          getRemovalGeneration: function () { return 0; }
        },
        ddata: ddata,
        entries: {
          list: function (query, callback) { callback(null, []); }
        },
        treatments: {
          list: function (query, callback) { callback(null, []); }
        },
        profile: {
          last: function (callback) { callback(null, []); }
        },
        food: {
          list: function (callback) { callback(null, []); }
        },
        devicestatus: {
          list: function (query, callback) { callback(null, []); }
        },
        activity: {
          list: function (query, callback) { callback(null, []); }
        },
        store: {
          db: {
            stats: function () {
              return Promise.resolve({ dataSize: 123, indexSize: 456 });
            }
          }
        }
      };
      const env = {
        debug: { logging: logging },
        settings: {
          isEnabled: function () { return false; },
          units: 'mg/dl'
        },
        extendedSettings: {}
      };
      const loader = dataloaderInit(env, ctx);
      const originalInfo = console.info;
      const originalDebug = console.debug;
      const logs = [];
      console.info = console.debug = function (...args) { logs.push(args); };

      loader.update(ddata, function (err) {
        console.info = originalInfo;
        console.debug = originalDebug;
        logs.length.should.equal(logging ? 1 : 0);
        if (logging) logs[0][0].should.equal('Load Complete:');
        should.not.exist(err);
        ddata.dbstats.should.eql({
          dataSize: 123,
          indexSize: 456
        });
        done();
      });
    });

  });

  it('does not resurrect treatments deleted while a load is in flight', function (done) {
    const ddata = createDData();
    ddata.processTreatments = function () {};

    const bus = new (require('events').EventEmitter)();
    const ghost = {
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      eventType: 'Exercise',
      created_at: new Date(Date.now() - 60000).toISOString(),
      mills: Date.now() - 60000,
      duration: 43200
    };

    let treatmentLoads = 0;
    const ctx = {
      settings: {},
      bus: bus,
      language: {
        translate: function (value) { return value; }
      },
      ddata: ddata,
      entries: {
        list: function (query, callback) { callback(null, []); }
      },
      treatments: {
        list: function (query, callback) {
          // secondary loaders filter on eventType; only the main load matters here
          if (query.find && query.find.eventType) return callback(null, []);
          treatmentLoads += 1;
          if (treatmentLoads === 1) {
            // the query result still contains the document, but the delete
            // commits and flushes the cache before the merge happens
            bus.emit('data-update', { type: 'treatments', op: 'remove', count: 1 });
            return callback(null, [ghost]);
          }
          callback(null, []);
        }
      },
      profile: {
        last: function (callback) { callback(null, []); }
      },
      food: {
        list: function (callback) { callback(null, []); }
      },
      devicestatus: {
        list: function (query, callback) { callback(null, []); }
      },
      activity: {
        list: function (query, callback) { callback(null, []); }
      },
      store: {
        db: {
          stats: function () {
            return Promise.resolve({ dataSize: 123, indexSize: 456 });
          }
        }
      }
    };
    const env = {
      settings: {
        isEnabled: function () { return false; },
        units: 'mg/dl'
      },
      extendedSettings: {}
    };
    ctx.cache = require('../lib/server/cache')(env, ctx);
    const loader = dataloaderInit(env, ctx);

    loader.update(ddata, function (err) {
      should.not.exist(err);
      treatmentLoads.should.equal(2);
      ddata.treatments.filter(function (t) { return t._id === ghost._id; }).should.have.length(0);
      ctx.cache.getData('treatments').filter(function (t) { return t._id === ghost._id; }).should.have.length(0);
      done();
    });
  });

  it('loads trips declared on the site whatever their age, and keeps them in the data', function (done) {
    const ddata = createDData();
    ddata.processTreatments = function () {};

    // declared a month ago, for a trip that started then: outside every
    // treatment window, and outside the four days a query without a date
    // filter is limited to
    const trip = {
      _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      eventType: 'Travel',
      timezone: 'America/New_York',
      startDate: '2026-09-20',
      endDate: '2026-10-05',
      created_at: '2026-09-19T21:00:00.000Z'
    };

    let travelQuery = null;
    const ctx = {
      settings: {},
      language: {
        translate: function (value) { return value; }
      },
      cache: {
        isEmpty: function () { return true; },
        insertData: function (key, results) { return results; },
        insertDataRef: function (key, results) { return results; },
        getData: function () { return []; },
        getDataRef: function () { return []; },
        getRemovalGeneration: function () { return 0; }
      },
      ddata: ddata,
      entries: {
        list: function (query, callback) { callback(null, []); }
      },
      treatments: {
        list: function (query, callback) {
          if (query.find && query.find.eventType === 'Travel') {
            travelQuery = query;
            return callback(null, [trip]);
          }
          callback(null, []);
        }
      },
      profile: {
        last: function (callback) { callback(null, []); }
      },
      food: {
        list: function (callback) { callback(null, []); }
      },
      devicestatus: {
        list: function (query, callback) { callback(null, []); }
      },
      activity: {
        list: function (query, callback) { callback(null, []); }
      },
      store: {
        db: {
          stats: function () { return Promise.resolve({ dataSize: 1, indexSize: 1 }); }
        }
      }
    };
    const env = {
      settings: {
        isEnabled: function () { return false; },
        units: 'mg/dl'
      },
      extendedSettings: {}
    };
    const loader = dataloaderInit(env, ctx);

    loader.update(ddata, function (err) {
      should.not.exist(err);
      should.exist(travelQuery);
      // the lower bound is what defeats the default four-day window
      travelQuery.find.created_at.$gte.should.equal('2000-01-01T00:00:00.000Z');
      travelQuery.sort.created_at.should.equal(-1);
      const loaded = ddata.treatments.filter(function (t) { return t.eventType === 'Travel'; });
      loaded.should.have.length(1);
      loaded[0].timezone.should.equal('America/New_York');
      loaded[0].mills.should.equal(new Date(trip.created_at).getTime());
      done();
    });
  });
});
