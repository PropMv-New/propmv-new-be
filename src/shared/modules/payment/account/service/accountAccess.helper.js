'use strict';

const mongoose = require('mongoose');
const { ENTITY_TYPE } = require('../constants/account.constants');

function assertAccountAccess(account, { businessId, userId }) {
  if (!account || account.isDeleted) {
    const err = new Error('Account not found');
    err.statusCode = 404;
    throw err;
  }

  // HOA board Straddle accounts are owned by the board member who created them.
  if (account.entityType === ENTITY_TYPE.HOA) {
    if (userId && account.createdBy && String(account.createdBy) === String(userId)) return;
    if (userId && String(account.entityId) === String(userId)) return;
    const err = new Error('You do not have permission to manage this account.');
    err.statusCode = 403;
    throw err;
  }

  if (businessId && String(account.businessId) === String(businessId)) return;
  if (userId && account.createdBy && String(account.createdBy) === String(userId)) return;
  if (!businessId && userId && String(account.createdBy) === String(userId)) return;

  const err = new Error('You do not have permission to manage this account.');
  err.statusCode = 403;
  throw err;
}

function resolveHoaBoardEntityId(userId, clientEntityId) {
  return {
    entityId: new mongoose.Types.ObjectId().toString(),
    metadataHoaId: clientEntityId ? String(clientEntityId) : null,
  };
}

function isHoaBoardAccount(entityType) {
  return entityType === ENTITY_TYPE.HOA;
}

module.exports = {
  assertAccountAccess,
  resolveHoaBoardEntityId,
  isHoaBoardAccount,
};
