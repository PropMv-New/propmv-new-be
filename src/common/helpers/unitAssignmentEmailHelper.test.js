const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sendUnitAssignmentEmail,
  resolveAssignmentHoaId,
} = require('./unitAssignmentEmailHelper');
const { buildCommunityEmailSubject } = require('./communityEmailContext.service');

test('resolveAssignmentHoaId prefers explicit hoaId then property then owner hoaInfo', () => {
  assert.equal(
    resolveAssignmentHoaId({
      hoaId: '507f1f77bcf86cd799439099',
      property: { hoaId: '507f1f77bcf86cd799439088' },
      recipient: { hoaInfo: { hoaId: '507f1f77bcf86cd799439077' } },
    }),
    '507f1f77bcf86cd799439099'
  );
  assert.equal(
    resolveAssignmentHoaId({
      property: { hoaId: '507f1f77bcf86cd799439088' },
      recipient: { hoaInfo: { hoaId: '507f1f77bcf86cd799439077' } },
    }),
    '507f1f77bcf86cd799439088'
  );
});

test('buildCommunityEmailSubject appends community name for unit assignment', () => {
  assert.equal(
    buildCommunityEmailSubject('Unit assigned to your account', 'Sunset Valley HOA'),
    'Unit assigned to your account - Sunset Valley HOA'
  );
});

test('sendUnitAssignmentEmail resolves community name from owner hoaInfo when property lacks hoaId', async () => {
  const HOA_ID = '507f1f77bcf86cd799439099';
  const HOA = require('../../portals/hoa-board/modules/hoa/model/hoa.model');
  const emailHelper = require('./emailHelper');
  const originalFindById = HOA.findById;
  const originalSendEmail = emailHelper.sendEmail;

  HOA.findById = () => ({
    select: () => ({
      lean: async () => ({ name: 'Sunset Valley HOA' }),
    }),
  });
  let capturedOptions = null;
  emailHelper.sendEmail = async (_type, _to, _data, options) => {
    capturedOptions = options;
    return true;
  };

  try {
    await sendUnitAssignmentEmail({
      recipient: {
        email: 'owner@example.com',
        firstName: 'Jai',
        hoaInfo: { hoaId: HOA_ID, communityName: 'Sunset Valley HOA' },
      },
      property: {
        name: 'Sunset Garden',
        address: { street: '1 Main St', city: 'Town', state: 'FL', zip: '33101' },
        unitDetails: [{ unitName: 'Unit 12' }],
      },
      assignedByName: 'Board Admin',
    });

    assert.equal(capturedOptions.subject, 'Unit assigned to your account - Sunset Valley HOA');
    assert.equal(capturedOptions.hoaId, HOA_ID);
    assert.equal(capturedOptions.communityName, 'Sunset Valley HOA');
  } finally {
    HOA.findById = originalFindById;
    emailHelper.sendEmail = originalSendEmail;
  }
});
