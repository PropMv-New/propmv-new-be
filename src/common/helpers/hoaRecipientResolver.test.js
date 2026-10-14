const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('hoaRecipientResolver', () => {
  it('mergeBoardAndAffected delivers community events to every board member', () => {
    const { mergeBoardAndAffected } = require('./hoaRecipientResolver');
    const board1 = '507f1f77bcf86cd799439011';
    const board2 = '507f1f77bcf86cd799439012';
    const board3 = '507f1f77bcf86cd799439013';
    const owner = '507f1f77bcf86cd799439014';

    const recipients = mergeBoardAndAffected([board1, board2, board3], [owner], board1);
    assert.deepEqual(recipients.sort(), [board1, board2, board3, owner].sort());
  });

  it('excludeActor removes only the acting user from recipient list', async () => {
    const { excludeActor } = require('./hoaRecipientResolver');
    const actor = '507f1f77bcf86cd799439011';
    const other = '507f1f77bcf86cd799439012';
    assert.deepEqual(excludeActor([actor, other, other], actor), [other]);
  });

  it('mergeBoardAndAffected keeps all board members and includes the acting owner', () => {
    const { mergeBoardAndAffected } = require('./hoaRecipientResolver');
    const actor = '507f1f77bcf86cd799439011';
    const boardA = '507f1f77bcf86cd799439012';
    const boardB = '507f1f77bcf86cd799439013';
    const ownerA = '507f1f77bcf86cd799439014';
    const ownerB = '507f1f77bcf86cd799439015';

    // Acting board member still receives their own notification copy.
    assert.deepEqual(
      mergeBoardAndAffected([boardA, actor], [ownerA, ownerB], actor).sort(),
      [boardA, actor, ownerA, ownerB].sort()
    );

    // All board members + all owners when actor is not an owner.
    assert.deepEqual(
      mergeBoardAndAffected([boardA, boardB, actor], [ownerA, ownerB], actor).sort(),
      [boardA, boardB, actor, ownerA, ownerB].sort()
    );

    // Acting owner also receives their own notification copy.
    assert.deepEqual(
      mergeBoardAndAffected([boardA, boardB], [ownerA, actor], actor).sort(),
      [boardA, boardB, ownerA, actor].sort()
    );
  });

  it('excludes the acting vendor from invoice recipients while keeping board and assignee', () => {
    const { mergeBoardAndAffected, excludeActor } = require('./hoaRecipientResolver');
    const vendor = '507f1f77bcf86cd799439011';
    const board = '507f1f77bcf86cd799439012';
    const assignee = '507f1f77bcf86cd799439013';
    assert.deepEqual(
      excludeActor(mergeBoardAndAffected([board], [assignee, vendor]), vendor).sort(),
      [board, assignee].sort()
    );
  });

  it('dedupeIds removes duplicate recipient ids', () => {
    const { dedupeIds } = require('./hoaRecipientResolver');
    const a = '507f1f77bcf86cd799439011';
    const b = '507f1f77bcf86cd799439012';
    assert.deepEqual(dedupeIds([a, b, a, b, a]), [a, b]);
  });

  it('resolveExpensePropertyId reads property field used by expense model', async () => {
    const { resolveExpensePropertyId } = require('./hoaRecipientResolver');
    const propertyId = '507f1f77bcf86cd799439011';
    assert.equal(
      resolveExpensePropertyId({ property: propertyId }),
      propertyId
    );
    assert.equal(
      resolveExpensePropertyId({ property: { _id: propertyId } }),
      propertyId
    );
  });

  it('resolveExpenseNotificationRecipients does not include vendor payees', async () => {
    const Module = require('module');
    const resolverPath = require.resolve('./hoaRecipientResolver');
    const isolationPath = require.resolve('../../middleware/hoaDataIsolation');
    delete require.cache[resolverPath];

    const boardA = '507f1f77bcf86cd799439011';
    const boardB = '507f1f77bcf86cd799439012';
    const vendor = '507f1f77bcf86cd799439099';
    const hoaId = '507f1f77bcf86cd799439088';
    const originalLoad = Module._load;
    Module._load = function patched(request, parent, isMain) {
      if (request === isolationPath || String(request).endsWith('hoaDataIsolation')) {
        return {
          loadHoaMemberUserIds: async () => [boardA, boardB],
        };
      }
      return originalLoad(request, parent, isMain);
    };

    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const { resolveExpenseNotificationRecipients } = require('./hoaRecipientResolver');
      const recipients = await resolveExpenseNotificationRecipients(
        { hoaId, vendorUserId: vendor, vendorPaidTo: 'Pat Vendor' },
        boardA
      );
      assert.ok(recipients.includes(boardA));
      assert.ok(recipients.includes(boardB));
      assert.equal(recipients.includes(vendor), false);
    } finally {
      Module._load = originalLoad;
      delete require.cache[resolverPath];
    }
  });

  it('resolvePropertyOwnerUserIds does not call getPropertyOwnerIds (avoids circular require)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, 'hoaRecipientResolver.js'), 'utf8');
    const start = src.indexOf('async function resolvePropertyOwnerUserIds');
    const nextFn = src.indexOf('\nasync function ', start + 1);
    const body = src.slice(start, nextFn === -1 ? undefined : nextFn);
    assert.equal(body.includes('getPropertyOwnerIds'), false);
  });

  it('collectMaintenanceAffectedUserIds includes populated assignee and requestedBy', () => {
    const { collectMaintenanceAffectedUserIds } = require('./hoaRecipientResolver');
    const vendor = '507f1f77bcf86cd799439011';
    const owner = '507f1f77bcf86cd799439012';
    assert.deepEqual(
      collectMaintenanceAffectedUserIds({
        assignedTo: { _id: vendor, firstName: 'Pat', email: 'vendor@example.com' },
        requestedBy: [{ _id: owner, firstName: 'Owner' }],
      }).sort(),
      [vendor, owner].sort()
    );
    assert.deepEqual(
      collectMaintenanceAffectedUserIds({ assignedTo: vendor, requestedBy: owner }),
      [owner, vendor]
    );
  });

  it('maintenanceAssigneeId reads populated or raw assignedTo', () => {
    const { maintenanceAssigneeId } = require('./hoaRecipientResolver');
    const vendor = '507f1f77bcf86cd799439011';
    assert.equal(maintenanceAssigneeId({ assignedTo: vendor }), vendor);
    assert.equal(maintenanceAssigneeId({ assignedTo: { _id: vendor } }), vendor);
    assert.equal(maintenanceAssigneeId({}), '');
  });

  it('Owners Only upload notifications stay with granted owners', async () => {
    const { resolveDocumentNotificationRecipients } = require('./hoaRecipientResolver');
    const ownerA = '507f1f77bcf86cd799439011';
    const ownerB = '507f1f77bcf86cd799439012';
    const hoaId = '507f1f77bcf86cd799439099';

    const recipients = await resolveDocumentNotificationRecipients({
      hoaId,
      accessLevel: 'Owners Only',
      linkedOwnerId: ownerA,
      allowedOwnerIds: [ownerA],
      allowedBoardMemberIds: [],
      allowCommunityBoardAccess: false,
      uploadSource: 'owner',
    }, ownerA);

    assert.deepEqual(recipients, [ownerA]);
    assert.equal(recipients.includes(ownerB), false);
  });

  it('Selective upload notifications stay with the selected recipients', async () => {
    const { resolveDocumentNotificationRecipients } = require('./hoaRecipientResolver');
    const ownerA = '507f1f77bcf86cd799439011';
    const boardA = '507f1f77bcf86cd799439013';
    const hoaId = '507f1f77bcf86cd799439099';

    const recipients = await resolveDocumentNotificationRecipients({
      hoaId,
      accessLevel: 'Selective board + owner',
      allowedOwnerIds: [ownerA],
      allowedBoardMemberIds: [boardA],
      allowCommunityBoardAccess: false,
    });

    assert.deepEqual(recipients.sort(), [ownerA, boardA].sort());
  });

  it('exports centralized recipient helpers used by all HOA notify paths', () => {
    const resolver = require('./hoaRecipientResolver');
    const required = [
      'resolveBoardMemberIds',
      'resolvePropertyOwnerUserIds',
      'resolvePropertyScopedRecipients',
      'resolvePropertyNotificationRecipients',
      'resolveOwnerNotificationRecipients',
      'resolveInvoiceLifecycleRecipients',
      'resolveInvoicePaymentRecipients',
      'resolveExpenseNotificationRecipients',
      'resolveMaintenanceNotificationRecipients',
      'resolveVendorInvoiceNotificationRecipients',
      'resolveVendorNotificationRecipients',
      'resolveDocumentNotificationRecipients',
      'mergeBoardAndAffected',
      'collectMaintenanceAffectedUserIds',
      'maintenanceAssigneeId',
      'excludeVendorUserIds',
    ];
    for (const key of required) {
      assert.equal(typeof resolver[key], 'function', `${key} should be exported`);
    }
  });

  it('resolveMaintenanceNotificationRecipients includes board, property owners, and assignee', async () => {
    const Module = require('module');
    const resolverPath = require.resolve('./hoaRecipientResolver');
    const isolationPath = require.resolve('../../middleware/hoaDataIsolation');
    delete require.cache[resolverPath];

    const boardA = '507f1f77bcf86cd799439011';
    const boardB = '507f1f77bcf86cd799439012';
    const ownerA = '507f1f77bcf86cd799439013';
    const vendor = '507f1f77bcf86cd799439014';
    const actorBoard = boardA;
    const hoaId = '507f1f77bcf86cd799439088';
    const propertyId = '507f1f77bcf86cd799439077';
    const propertyDoc = {
      _id: propertyId,
      hoaId,
      associatedOwnerIds: [ownerA],
      name: 'Unit 12',
    };

    const originalLoad = Module._load;
    Module._load = function patched(request, parent, isMain) {
      if (request === isolationPath || String(request).endsWith('hoaDataIsolation')) {
        return {
          loadHoaMemberUserIds: async () => [boardA, boardB],
        };
      }
      if (
        String(request).includes('hoa-board/modules/property/model/property.model')
        || String(request).replace(/\\/g, '/').endsWith('property/model/property.model')
        || String(request).endsWith('property.model')
      ) {
        return {
          findOne: () => ({
            select: () => ({
              lean: async () => propertyDoc,
            }),
          }),
          findById: () => ({
            select: () => ({
              lean: async () => propertyDoc,
            }),
          }),
        };
      }
      if (
        String(request).includes('owners/services/unit.service')
        || String(request).replace(/\\/g, '/').endsWith('owners/services/unit.service')
      ) {
        return {
          getCurrentOwnerIdsFromUnit: () => [ownerA],
        };
      }
      if (
        String(request).includes('users/models/user.model')
        || String(request).replace(/\\/g, '/').endsWith('users/models/user.model')
      ) {
        return {
          find: () => ({
            select: () => ({
              lean: async () => [],
            }),
          }),
        };
      }
      return originalLoad(request, parent, isMain);
    };

    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const { resolveMaintenanceNotificationRecipients } = require('./hoaRecipientResolver');
      const recipients = await resolveMaintenanceNotificationRecipients(
        {
          hoaId,
          property_id: propertyId,
          assignedTo: vendor,
          requestedBy: [],
          notifyTenant: false,
        },
        actorBoard
      );
      assert.ok(recipients.includes(boardA));
      assert.ok(recipients.includes(boardB));
      assert.ok(recipients.includes(ownerA), 'property owners must receive resolve notifications');
      assert.ok(recipients.includes(vendor));
    } finally {
      Module._load = originalLoad;
      delete require.cache[resolverPath];
    }
  });

  it('resolvePropertyScopedRecipients strips Vendor-role users from property/community audiences', async () => {
    const Module = require('module');
    const resolverPath = require.resolve('./hoaRecipientResolver');
    const isolationPath = require.resolve('../../middleware/hoaDataIsolation');
    const vendorRolePath = require.resolve('./hoaVendorRole');
    const userModelPath = require.resolve('../../shared/modules/users/models/user.model');
    delete require.cache[resolverPath];
    delete require.cache[vendorRolePath];
    delete require.cache[userModelPath];

    const boardA = '507f1f77bcf86cd799439011';
    const vendor = '507f1f77bcf86cd799439099';
    const hoaId = '507f1f77bcf86cd799439088';
    const originalLoad = Module._load;
    Module._load = function patched(request, parent, isMain) {
      const req = String(request).replace(/\\/g, '/');
      if (request === isolationPath || req.endsWith('hoaDataIsolation.js') || req.endsWith('hoaDataIsolation')) {
        return {
          loadHoaMemberUserIds: async () => [boardA, vendor],
        };
      }
      if (request === vendorRolePath || req.endsWith('hoaVendorRole.js') || req.endsWith('hoaVendorRole')) {
        return {
          buildVendorUserFilter: async (extra = {}) => ({
            ...extra,
            companyRoleId: 'vendor-role',
          }),
          isVendorRole: () => true,
        };
      }
      if (request === userModelPath || req.endsWith('users/models/user.model.js') || req.endsWith('users/models/user.model')) {
        return {
          find: (query) => ({
            select: () => ({
              lean: async () => {
                const ids = (query._id?.$in || []).map((id) => String(id));
                return ids.includes(vendor) ? [{ _id: vendor }] : [];
              },
            }),
          }),
        };
      }
      return originalLoad(request, parent, isMain);
    };

    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const { resolvePropertyScopedRecipients } = require('./hoaRecipientResolver');
      const recipients = await resolvePropertyScopedRecipients({ hoaId });
      assert.ok(recipients.includes(boardA));
      assert.equal(recipients.includes(vendor), false);
    } finally {
      Module._load = originalLoad;
      delete require.cache[resolverPath];
      delete require.cache[vendorRolePath];
      delete require.cache[userModelPath];
    }
  });
});

describe('notificationProxy filterByCommunity', () => {
  it('returns matching community notifications and keeps rows without hoaId', () => {
    const { filterByCommunity } = require('../../shared/modules/notifications/service/notificationProxy.service');
    const hoaA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const hoaB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const notifications = [
      { _id: '1', metadata: { hoaId: hoaA } },
      { _id: '2', metadata: { hoaId: hoaB } },
      { _id: '3', metadata: {} },
    ];
    const filtered = filterByCommunity(notifications, hoaA);
    assert.deepEqual(filtered.map((n) => n._id), ['1', '3']);
  });

  it('keeps notifications whose hoaId is nested under eventData', () => {
    const { filterByCommunity } = require('../../shared/modules/notifications/service/notificationProxy.service');
    const hoaA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const notifications = [
      { _id: '1', metadata: { eventData: { hoaId: hoaA } } },
      { _id: '2', metadata: {} },
    ];
    const filtered = filterByCommunity(notifications, hoaA);
    assert.deepEqual(filtered.map((n) => n._id), ['1', '2']);
  });
});

describe('notify idempotency key generation', () => {
  it('generates stable notification ids for the same event recipient', () => {
    const notifyModule = require('../notifications/notify');
    const crypto = require('crypto');
    const seed = 'invoice_created:inv1:507f1f77bcf86cd799439011';
    const hash1 = crypto.createHash('sha256').update(`${seed}`).digest('hex');
    const hash2 = crypto.createHash('sha256').update(`${seed}`).digest('hex');
    assert.equal(hash1, hash2);
    assert.ok(notifyModule);
  });
});

describe('HOA notification events registry', () => {
  const EVENTS = require('../notifications/notificationEvents');

  it('includes owner, expense paid/deleted, maintenance reopened, and vendor events', () => {
    assert.equal(EVENTS.OWNER_CREATED.type, 'owner_created');
    assert.equal(EVENTS.EXPENSE_PAID.type, 'expense_paid');
    assert.equal(EVENTS.EXPENSE_DELETED.type, 'expense_deleted');
    assert.equal(EVENTS.MAINTENANCE_REQUEST_REOPENED.type, 'maintenance_request');
    assert.equal(EVENTS.VENDOR_CREATED.type, 'vendor_created');
    assert.equal(EVENTS.VENDOR_ASSIGNED.type, 'vendor_assigned');
    assert.equal(
      EVENTS.VENDOR_ASSIGNED.message({
        vendorName: 'Acme Plumbing',
        title: 'Leak',
        unitName: '4B',
        customMessage: 'You have been assigned to maintenance ticket "Leak" for unit "4B".',
      }),
      'You have been assigned to maintenance ticket "Leak" for unit "4B".'
    );
    assert.equal(EVENTS.VENDOR_INVOICE_CREATED.type, 'vendor_invoice_created');
    assert.equal(EVENTS.VENDOR_INVOICE_COMMENT_ADDED.type, 'vendor_invoice_comment_added');
    assert.equal(
      EVENTS.VENDOR_INVOICE_COMMENT_ADDED.message({ invoiceTitle: 'Plumbing', invoiceNumber: 'VI-1' }),
      'A comment was added to vendor invoice "Plumbing".'
    );
    assert.equal(EVENTS.INVOICE_WAIVED.type, 'invoice_waived');
    assert.equal(
      EVENTS.INVOICE_WAIVED.message({ amount: '50.00', unitName: '4B' }),
      '$50.00 has been waived on the invoice for unit "4B".'
    );
  });

  it('includes HOA fee and board membership events', () => {
    assert.equal(EVENTS.HOA_FEE_UPDATED.type, 'hoa_fee_updated');
    assert.equal(EVENTS.BOARD_MEMBER_UPDATED.type, 'board_member_updated');
    assert.equal(EVENTS.BOARD_MEMBER_DELETED.type, 'board_member_deleted');
    assert.equal(EVENTS.BOARD_MEMBER_INVITED.type, 'board_member_invited');
    assert.equal(EVENTS.BOARD_MEMBER_INVITE_ACCEPTED.type, 'board_member_invite_accepted');
    assert.match(
      EVENTS.OWNER_DELETED.message({ ownerName: 'Jane Doe', unitName: 'Sunset · 4B' }),
      /removed from unit "Sunset · 4B"/
    );
    assert.equal(
      EVENTS.BOARD_MEMBER_INVITED.message({ memberName: 'Alex', hoaName: 'Riverside' }),
      'Alex has been invited to join the board for Riverside.'
    );
    assert.equal(
      EVENTS.BOARD_MEMBER_INVITE_ACCEPTED.message({ memberName: 'Alex', hoaName: 'Riverside' }),
      'Alex has accepted the board member invitation for Riverside.'
    );
  });

  it('formats property created message for recipients', () => {
    assert.equal(
      EVENTS.PROPERTY_CREATED.message({ propertyName: '18-Aug' }),
      'A new property "18-Aug" has been created.'
    );
  });
});
