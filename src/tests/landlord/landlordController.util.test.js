const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { handleLandlordError } = require('../../portals/landlord/utils/landlordController.util');

function createMockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe('handleLandlordError', () => {
  test('returns explicit error status and message', () => {
    const req = { landlordRequestId: 'req-1', userId: 'user-1' };
    const res = createMockRes();
    const err = Object.assign(new Error('Not found'), { status: 404 });

    handleLandlordError(req, res, err, null, 'getProperty');

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { message: 'Not found' });
  });

  test('delegates to next when error has no status', () => {
    const req = { landlordRequestId: 'req-2' };
    const res = createMockRes();
    const err = new Error('Unexpected failure');
    let forwarded = null;
    const next = (e) => { forwarded = e; };

    handleLandlordError(req, res, err, next, 'createLease');

    assert.equal(forwarded, err);
    assert.equal(res.statusCode, null);
  });

  test('returns 500 when next is not a function and error has no status', () => {
    const req = { landlordRequestId: 'req-3' };
    const res = createMockRes();
    const err = new Error('Server blew up');

    handleLandlordError(req, res, err, null, 'deleteTenant');

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { message: 'Server blew up' });
  });
});
