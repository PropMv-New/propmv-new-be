'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

describe('MaintenanceRequest.distinctOpenPropertyIds', () => {
  let MaintenanceRequest;
  let originalAggregate;

  beforeEach(() => {
    // Fresh require so we can spy aggregate without leaking across files.
    delete require.cache[require.resolve('./maintenanceRequest.model')];
    MaintenanceRequest = require('./maintenanceRequest.model');
    originalAggregate = MaintenanceRequest.aggregate;
  });

  afterEach(() => {
    MaintenanceRequest.aggregate = originalAggregate;
  });

  it('matches open tickets case-insensitively (Open / InProgress)', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    let matchStage = null;

    MaintenanceRequest.aggregate = (pipeline) => {
      matchStage = pipeline[0].$match;
      return {
        exec: async () => [{ _id: propertyId }],
      };
    };

    const result = await MaintenanceRequest.distinctOpenPropertyIds([propertyId]);

    assert.deepEqual(result, [propertyId]);
    assert.ok(matchStage.$expr);
    assert.deepEqual(
      matchStage.$expr.$in[1],
      ['open', 'submitted', 'inprogress'],
    );
    assert.equal(
      matchStage.$expr.$in[0].$toLower.$ifNull[0],
      '$status',
    );
  });

  it('returns an empty list when no property ids are provided', async () => {
    let called = false;
    MaintenanceRequest.aggregate = () => {
      called = true;
      return { exec: async () => [] };
    };

    const result = await MaintenanceRequest.distinctOpenPropertyIds([]);
    assert.deepEqual(result, []);
    assert.equal(called, false);
  });
});
