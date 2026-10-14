'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const HELPER_PATH = require.resolve('./maintenanceEmailHelper');

const BOARD_A = '507f1f77bcf86cd799439011';
const OWNER_A = '507f1f77bcf86cd799439013';
const VENDOR = '507f1f77bcf86cd799439014';
const HOA_ID = '507f1f77bcf86cd799439088';
const PROPERTY_ID = '507f1f77bcf86cd799439077';

function matchesPath(request, ...needles) {
  const normalized = String(request).replace(/\\/g, '/').toLowerCase();
  return needles.some((needle) => normalized.includes(String(needle).toLowerCase()));
}

describe('sendMaintenanceActivityEmails', () => {
  afterEach(() => {
    delete require.cache[HELPER_PATH];
  });

  it('emails board, owner, and vendor including the acting board member', async () => {
    delete require.cache[HELPER_PATH];
    for (const key of Object.keys(require.cache)) {
      const normalized = key.replace(/\\/g, '/').toLowerCase();
      if (
        normalized.includes('hoaDataIsolation'.toLowerCase())
        || normalized.includes('transactionalEmail.service'.toLowerCase())
        || normalized.includes('hoaRecipientResolver'.toLowerCase())
        || normalized.includes('property.model')
        || normalized.includes('user.model')
        || normalized.includes('maintenanceEmailRecipients'.toLowerCase())
      ) {
        delete require.cache[key];
      }
    }

    const sends = [];
    const originalLoad = Module._load;
    Module._load = function patched(request, parent, isMain) {
      if (matchesPath(request, 'hoaDataIsolation')) {
        return {
          loadHoaMemberUserIds: async () => [BOARD_A],
          addHOADataIsolationHooks: () => {},
        };
      }
      if (matchesPath(request, 'transactionalEmail.service')) {
        return {
          sendTransactionalEmail: async (payload) => {
            sends.push(payload);
            return { sent: true };
          },
          buildEventKey: (...parts) => parts.join(':'),
        };
      }
      if (matchesPath(request, 'hoaRecipientResolver')) {
        return {
          resolvePropertyOwnerUserIds: async () => [OWNER_A],
        };
      }
      if (matchesPath(request, 'landlord/modules/property/model/property.model')) {
        return {
          findById: () => ({
            select: () => ({
              lean: async () => ({
                _id: PROPERTY_ID,
                hoaId: HOA_ID,
                name: 'Oak Street',
                unitDetails: [],
              }),
            }),
          }),
        };
      }
      if (matchesPath(request, 'users/models/user.model')) {
        return {
          find: () => ({
            select: () => ({
              lean: async () => [
                { _id: BOARD_A, firstName: 'Bo', lastName: 'Board', email: 'board@example.com' },
                { _id: OWNER_A, firstName: 'Ow', lastName: 'Owner', email: 'owner@example.com' },
                { _id: VENDOR, firstName: 'Ve', lastName: 'Vendor', email: 'vendor@example.com' },
              ],
            }),
          }),
        };
      }
      if (matchesPath(request, 'common/logger')) {
        return { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
      }
      return originalLoad(request, parent, isMain);
    };

    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const { sendMaintenanceActivityEmails } = require('./maintenanceEmailHelper');
      const result = await sendMaintenanceActivityEmails(
        {
          _id: '507f1f77bcf86cd799439099',
          title: 'Leak',
          status: 'Open',
          hoaId: HOA_ID,
          property_id: PROPERTY_ID,
          assignedTo: VENDOR,
          requestedBy: [],
          notifyTenant: true,
        },
        {
          eventKey: 'maintenance_comment_added',
          eventMessage: 'A comment was added to a maintenance request.',
          dedupeKey: 'comment:test:1',
          actorUserId: BOARD_A,
        }
      );

      assert.equal(result.sent, 3);
      assert.equal(sends.length, 3);
      const emails = sends.map((s) => s.toEmail).sort();
      assert.deepEqual(emails, ['board@example.com', 'owner@example.com', 'vendor@example.com'].sort());
      assert.ok(sends.every((s) => s.options.template === 'maintenance-ticket-updated'));
      assert.ok(sends.every((s) => String(s.eventKey).includes('maintenance_comment_added')));
      // Actor (board) is included
      assert.ok(emails.includes('board@example.com'));
    } finally {
      Module._load = originalLoad;
      delete require.cache[HELPER_PATH];
    }
  });
});
