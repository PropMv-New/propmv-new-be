const test = require('node:test');
const assert = require('node:assert/strict');
const access = require('../helpers/hoaDocumentAccess');

test('HOA Owner can upload but not manage documents', () => {
  assert.equal(access.canUploadDocuments('HOA Owner'), true);
  assert.equal(access.canManageDocuments('HOA Owner'), false);
  assert.doesNotThrow(() => access.assertCanUploadDocuments('HOA Owner'));
  assert.throws(
    () => access.assertCanManageDocuments('HOA Owner'),
    (err) => err.message === 'You do not have permission to manage documents'
  );
});

test('HOA Board Member can upload and manage documents', () => {
  assert.equal(access.canUploadDocuments('HOA Board Member'), true);
  assert.equal(access.canManageDocuments('HOA Board Member'), true);
  assert.doesNotThrow(() => access.assertCanUploadDocuments('HOA Board Member'));
  assert.doesNotThrow(() => access.assertCanManageDocuments('HOA Board Member'));
});

test('HOA Owner cannot set Board Only access on upload', () => {
  assert.throws(
    () => access.assertValidUploadAccessLevel('HOA Owner', access.ACCESS_LEVELS.BOARD_ONLY),
    (err) => err.message === 'You do not have permission to set this access level'
  );
  assert.doesNotThrow(() =>
    access.assertValidUploadAccessLevel('HOA Owner', access.ACCESS_LEVELS.OWNERS_ONLY)
  );
});

test('HOA Owner upload rejects foreign-owner recipient grants but allows board sharing', () => {
  const ownerA = '507f1f77bcf86cd799439011';
  const ownerB = '507f1f77bcf86cd799439012';
  const boardA = '507f1f77bcf86cd799439013';

  assert.throws(
    () =>
      access.assertOwnerUploadGrantPolicy('HOA Owner', {
        uploaderId: ownerA,
        ownerGrantIds: [ownerB],
      }),
    (err) => err.status === 403
  );

  assert.doesNotThrow(() =>
    access.assertOwnerUploadGrantPolicy('HOA Owner', {
      uploaderId: ownerA,
      ownerGrantIds: [ownerA],
      boardGrantIds: [boardA],
      allowCommunityBoardAccess: true,
    })
  );

  assert.doesNotThrow(() =>
    access.assertOwnerUploadGrantPolicy('HOA Owner', {
      uploaderId: ownerA,
      ownerGrantIds: [ownerA],
      boardGrantIds: [],
      allowCommunityBoardAccess: false,
    })
  );

  assert.doesNotThrow(() =>
    access.assertOwnerUploadGrantPolicy('HOA Board Member', {
      uploaderId: ownerA,
      ownerGrantIds: [ownerB],
      boardGrantIds: [boardA],
      allowCommunityBoardAccess: true,
    })
  );
});

test('HOA Owner can update and delete own uploads but not manage board documents', () => {
  const ownerDoc = { uploadedById: 'owner-a', accessLevel: access.ACCESS_LEVELS.OWNERS_ONLY };
  const boardDoc = { uploadedById: 'board-a', accessLevel: access.ACCESS_LEVELS.OWNERS_ONLY };

  assert.equal(access.canUpdateDocument('HOA Owner', ownerDoc, { userId: 'owner-a' }), true);
  assert.equal(access.canDeleteDocument('HOA Owner', ownerDoc, { userId: 'owner-a' }), true);
  assert.equal(access.canUpdateDocument('HOA Owner', ownerDoc, { userId: 'owner-b' }), false);
  assert.equal(access.canDeleteDocument('HOA Owner', boardDoc, { userId: 'owner-a' }), false);
  assert.equal(access.canManageDocuments('HOA Owner'), false);
  assert.throws(
    () => access.assertCanManageDocuments('HOA Owner'),
    (err) => err.message === 'You do not have permission to manage documents'
  );
  assert.throws(
    () => access.assertCanDeleteDocument('HOA Owner', boardDoc, { userId: 'owner-a' }),
    (err) => err.message === 'You can only delete documents you uploaded'
  );
});

test('Owners Only document is visible only to selected owners, or board when explicitly shared', () => {
  const document = {
    accessLevel: access.ACCESS_LEVELS.OWNERS_ONLY,
    uploadedById: 'board-a',
    linkedOwnerId: 'owner-a',
    allowedOwnerIds: ['owner-a'],
    allowedBoardMemberIds: [],
    allowCommunityBoardAccess: false,
  };

  // Board uploader does not get library visibility from upload alone.
  assert.equal(access.canViewDocument('HOA Board Member', document, { userId: 'board-a' }), false);
  assert.equal(access.canViewDocument('HOA Owner', document, { userId: 'owner-a' }), true);
  assert.equal(access.canViewDocument('HOA Owner', document, { userId: 'owner-b' }), false);
  assert.equal(access.canViewDocument('Tenant', document, { userId: 'tenant-a' }), false);
  assert.equal(access.canViewDocument('HOA Board Member', document, { userId: 'board-b' }), false);
});

test('Owners Only document can be shared with other board members by checkbox', () => {
  const document = {
    accessLevel: access.ACCESS_LEVELS.OWNERS_ONLY,
    uploadedById: 'board-a',
    linkedOwnerId: 'owner-a',
    allowedOwnerIds: ['owner-a'],
    allowCommunityBoardAccess: true,
  };

  assert.equal(access.canViewDocument('HOA Board Member', document, { userId: 'board-b' }), true);
  assert.equal(access.canViewDocument('HOA Board Member', document, { userId: 'board-a' }), true);
  assert.equal(access.canViewDocument('HOA Owner', document, { userId: 'owner-b' }), false);
});

test('Other board members cannot manage a document unless they are admin', () => {
  const document = {
    accessLevel: access.ACCESS_LEVELS.OWNERS_ONLY,
    uploadedById: 'board-a',
  };

  assert.doesNotThrow(() =>
    access.assertCanManageDocuments('HOA Board Member', document, { userId: 'board-a' })
  );
  assert.throws(
    () => access.assertCanManageDocuments('HOA Board Member', document, { userId: 'board-b' }),
    (err) => err.message === 'You can only manage documents you uploaded'
  );
  assert.doesNotThrow(() =>
    access.assertCanManageDocuments('Administrator', document, { userId: 'admin-a' })
  );
});

test('buildRoleAccessFilter casts viewer ids to ObjectIds so folder counts match uploads', () => {
  const mongoose = require('mongoose');
  const ownerId = '507f1f77bcf86cd799439011';
  const ownerFilter = access.buildRoleAccessFilter('HOA Owner', { userId: ownerId });
  const linked = ownerFilter.$or.find(
    (clause) => clause.linkedOwnerId && clause.accessLevel === access.ACCESS_LEVELS.OWNERS_ONLY
  );
  assert.ok(linked);
  assert.ok(linked.linkedOwnerId.$in);
  assert.equal(String(linked.linkedOwnerId.$in[0]), ownerId);
  assert.equal(linked.linkedOwnerId.$in[0] instanceof mongoose.Types.ObjectId, true);

  const boardId = '507f1f77bcf86cd799439012';
  const boardFilter = access.buildRoleAccessFilter('HOA Board Member', { userId: boardId });
  // Board does not get Owners Only via uploader identity.
  const uploadedOwnersOnly = boardFilter.$or.find(
    (clause) => clause.uploadedById && clause.accessLevel === access.ACCESS_LEVELS.OWNERS_ONLY
  );
  assert.equal(uploadedOwnersOnly, undefined);
  const boardGrant = boardFilter.$or.find(
    (clause) =>
      clause.allowedBoardMemberIds && clause.accessLevel === access.ACCESS_LEVELS.OWNERS_ONLY
  );
  assert.ok(boardGrant);
  assert.ok(boardGrant.allowedBoardMemberIds.$in);
  assert.equal(String(boardGrant.allowedBoardMemberIds.$in[0]), boardId);
});

test('buildRoleAccessFilter omits ObjectId grant clauses when viewer id is missing', () => {
  const ownerFilter = access.buildRoleAccessFilter('HOA Owner', {});
  assert.ok(ownerFilter.$or.every((clause) => !clause.linkedOwnerId && !clause.uploadedById && !clause.allowedOwnerIds));
});

test('Legacy documents can still be matched to owner uploader by email', () => {
  const document = {
    accessLevel: access.ACCESS_LEVELS.OWNERS_ONLY,
    uploadedBy: 'owner@example.com',
    uploadedById: 'owner-a',
    linkedOwnerId: 'owner-a',
    allowedOwnerIds: ['owner-a'],
    allowCommunityBoardAccess: false,
  };

  assert.equal(
    access.canViewDocument('HOA Owner', document, { userId: 'owner-a', email: 'owner@example.com' }),
    true
  );
  assert.equal(
    access.canViewDocument('HOA Board Member', document, {
      userId: 'board-a',
      email: 'board@example.com',
    }),
    false
  );
});

test('Owner-uploaded Owners Only document is visible only to that owner', () => {
  const document = {
    accessLevel: access.ACCESS_LEVELS.OWNERS_ONLY,
    uploadedById: 'owner-a',
    uploadedBy: 'owner-a@example.com',
    linkedOwnerId: 'owner-a',
    allowedOwnerIds: ['owner-a'],
    allowedBoardMemberIds: [],
    allowCommunityBoardAccess: false,
    uploadSource: 'owner',
  };

  assert.equal(access.canViewDocument('HOA Owner', document, { userId: 'owner-a', email: 'owner-a@example.com' }), true);
  assert.equal(access.canViewDocument('HOA Owner', document, { userId: 'owner-b', email: 'owner-b@example.com' }), false);
  assert.equal(access.canViewDocument('HOA Board Member', document, { userId: 'board-a', email: 'board@example.com' }), false);
  assert.equal(access.canViewDocument('Tenant', document, { userId: 'tenant-a' }), false);
});

test('Owner-uploaded All Residents document stays visible to owners, board, and residents', () => {
  const document = {
    accessLevel: access.ACCESS_LEVELS.ALL_RESIDENTS,
    uploadedById: 'owner-a',
    linkedOwnerId: 'owner-a',
    allowedOwnerIds: [],
    uploadSource: 'owner',
  };

  assert.equal(access.canViewDocument('HOA Owner', document, { userId: 'owner-b' }), true);
  assert.equal(access.canViewDocument('HOA Board Member', document, { userId: 'board-a' }), true);
  assert.equal(access.canViewDocument('Tenant', document, { userId: 'tenant-a' }), true);
});

test('Owners Only does not match when viewer and document ids are both missing', () => {
  const document = {
    accessLevel: access.ACCESS_LEVELS.OWNERS_ONLY,
    allowedOwnerIds: [],
    allowCommunityBoardAccess: false,
  };

  assert.equal(access.canViewDocument('HOA Owner', document, {}), false);
  assert.equal(access.canViewDocument('HOA Board Member', document, {}), false);
});

test('Owner library filter does not expose every Owners Only document', () => {
  const ownerFilter = access.buildRoleAccessFilter('HOA Owner', {
    userId: '507f1f77bcf86cd799439011',
    email: 'owner-a@example.com',
  });
  const blanket = ownerFilter.$or.find(
    (clause) =>
      clause.accessLevel === access.ACCESS_LEVELS.OWNERS_ONLY &&
      !clause.uploadedById &&
      !clause.uploadedBy &&
      !clause.linkedOwnerId &&
      !clause.allowedOwnerIds
  );
  assert.equal(blanket, undefined);
});

test('Board members do not treat Owners Only as a default visible folder level', () => {
  assert.equal(
    access.canViewAccessLevel('HOA Board Member', access.ACCESS_LEVELS.OWNERS_ONLY),
    false
  );
  assert.equal(
    access.canViewAccessLevel('HOA Owner', access.ACCESS_LEVELS.OWNERS_ONLY),
    true
  );
  assert.doesNotThrow(() =>
    access.assertValidUploadAccessLevel('HOA Board Member', access.ACCESS_LEVELS.OWNERS_ONLY)
  );
});
