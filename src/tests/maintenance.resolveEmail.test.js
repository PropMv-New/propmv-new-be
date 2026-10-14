'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const SERVICE_PATH = path.join(
  __dirname,
  '../shared/modules/maintenance/service/maintenance.service.js'
);

const BOARD_A = '507f1f77bcf86cd799439011';
const BOARD_B = '507f1f77bcf86cd799439012';
const OWNER_A = '507f1f77bcf86cd799439013';
const VENDOR = '507f1f77bcf86cd799439014';
const REQUESTER = '507f1f77bcf86cd799439015';
const TICKET_ID = '507f1f77bcf86cd799439099';

function endsWithPath(request, ...segments) {
  const normalized = String(request).replace(/\\/g, '/');
  return segments.some((segment) => normalized.endsWith(segment));
}

describe('maintenance resolve email', () => {
  afterEach(() => {
    delete require.cache[require.resolve(SERVICE_PATH)];
  });

  it('notifyMaintenanceResolved uses full HOA recipient resolver (owners + board)', () => {
    const src = fs.readFileSync(SERVICE_PATH, 'utf8');
    const start = src.indexOf('function notifyMaintenanceResolved');
    assert.ok(start >= 0, 'notifyMaintenanceResolved should exist');
    const nextFn = src.indexOf('\nfunction notifyMaintenanceDocumentsUpdated', start + 1);
    const body = src.slice(start, nextFn === -1 ? undefined : nextFn);
    assert.ok(
      body.includes('resolveMaintenanceNotificationRecipients'),
      'resolve emails must use resolveMaintenanceNotificationRecipients'
    );
    assert.ok(body.includes("eventKey: 'maintenance_resolved'"));
  });

  it('status update to Resolved/Completed routes through notifyMaintenanceResolved', () => {
    const src = fs.readFileSync(SERVICE_PATH, 'utf8');
    const start = src.indexOf('function notifyMaintenanceRequestUpdated');
    assert.ok(start >= 0);
    const nextFn = src.indexOf('\nfunction notifyMaintenanceResolved', start + 1);
    const body = src.slice(start, nextFn === -1 ? undefined : nextFn);
    assert.ok(body.includes('becameResolved'));
    assert.ok(body.includes('notifyMaintenanceResolved(doc, actorUserId)'));
  });

  it('notifyMaintenanceResolved emails board, owners, and assignee (actor excluded at send)', async () => {
    delete require.cache[require.resolve(SERVICE_PATH)];

    const calls = { actionUpdate: [], recipients: [] };
    const originalLoad = Module._load;
    const originalSetImmediate = global.setImmediate;

    Module._load = function patched(request, parent, isMain) {
      if (endsWithPath(request, 'hoaRecipientResolver.js', 'hoaRecipientResolver')) {
        return {
          resolveMaintenanceNotificationRecipients: async (doc, actorUserId) => {
            calls.recipients.push({
              ticketId: String(doc?._id || ''),
              actorUserId: actorUserId ? String(actorUserId) : null,
            });
            return [BOARD_A, BOARD_B, OWNER_A, VENDOR, REQUESTER].filter(
              (id) => String(id) !== String(actorUserId || '')
            );
          },
        };
      }
      if (endsWithPath(request, 'actionUpdateEmail.service.js', 'actionUpdateEmail.service')) {
        return {
          notifyActionUpdateInBackground: (payload) => {
            calls.actionUpdate.push(payload);
          },
        };
      }
      if (endsWithPath(request, 'hoaInAppNotify.helper.js', 'hoaInAppNotify.helper')) {
        return {
          notifyMaintenanceUpdatedInAppInBackground: () => {},
          notifyMaintenanceCommentInAppInBackground: () => {},
          notifyMaintenanceNoteInAppInBackground: () => {},
          notifyMaintenanceDocumentsInAppInBackground: () => {},
          notifyMaintenanceCreatedInAppInBackground: () => {},
          notifyMaintenanceVendorAssignedInAppInBackground: () => {},
        };
      }
      if (endsWithPath(request, 'landlordPortalEventEmail.service.js', 'landlordPortalEventEmail.service')) {
        return { notifyLandlordPortalEventInBackground: () => {} };
      }
      if (endsWithPath(request, 'maintenanceEmailHelper.js', 'maintenanceEmailHelper')) {
        return {
          sendMaintenanceRequestCreatedEmail: async () => {},
          sendMaintenanceVendorAssignedEmail: async () => {},
        };
      }
      if (endsWithPath(request, 'common/logger.js', 'common/logger')) {
        return { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
      }
      return originalLoad(request, parent, isMain);
    };

    const pending = [];
    global.setImmediate = (fn) => {
      pending.push(fn);
      return 0;
    };

    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const { notifyMaintenanceResolved } = require(SERVICE_PATH);

      notifyMaintenanceResolved(
        {
          _id: TICKET_ID,
          title: 'Leak under sink',
          status: 'Resolved',
          ticketNumber: 'M-100',
          hoaId: '507f1f77bcf86cd799439088',
          assignedTo: VENDOR,
          requestedBy: [REQUESTER],
          notifyTenant: true,
        },
        BOARD_A
      );

      for (const fn of pending) {
        // eslint-disable-next-line no-await-in-loop
        await fn();
      }

      assert.equal(calls.recipients.length, 1);
      assert.equal(calls.recipients[0].actorUserId, BOARD_A);
      assert.equal(calls.actionUpdate.length, 1);
      assert.equal(calls.actionUpdate[0].eventKey, 'maintenance_resolved');
      assert.deepEqual(
        calls.actionUpdate[0].userIds.sort(),
        [BOARD_B, OWNER_A, VENDOR, REQUESTER].sort()
      );
      assert.equal(calls.actionUpdate[0].userIds.includes(BOARD_A), false);
      assert.equal(calls.actionUpdate[0].userIds.includes(OWNER_A), true);
    } finally {
      global.setImmediate = originalSetImmediate;
      Module._load = originalLoad;
      delete require.cache[require.resolve(SERVICE_PATH)];
    }
  });
});
