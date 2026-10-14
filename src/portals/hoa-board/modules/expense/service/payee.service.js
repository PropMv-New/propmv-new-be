/**
 * ------------------------------------------------------------------
 * File: payee.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * payee.controller
 * ------------------------------------------------------------------
 */

const Payee = require('../model/payee.model');
const mongoose = require('mongoose');
const { getPagination } = require('../../../../../common/helpers/paginationHelper');
const { applyHOADataFilter } = require('../../../../../middleware/hoaDataIsolation');
const { logActivity } = require('../../dashboard/service/activity.service');

/**
 * format Payee Name
 *
 * Performs logic operations for formatPayeeName.
 *
 * @param payee - Request/input argument
 * @returns Operations result
 */
function formatPayeeName(payee) {
  if (!payee) return 'Payee';
  const name = `${payee.firstName || ''} ${payee.lastName || ''}`.trim();
  if (payee.organization) {
    return name ? `${name} (${payee.organization})` : payee.organization;
  }
  return name || payee.email || 'Payee';
}

/**
 * NotFoundError
 *
 * Represents the Not Found Error controller/model class.
 */
class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

async function createPayee(data, userId, userContext = null) {
  if (userId) data.createdBy = userId;
  if (userContext?.userId) data.hoaBoardMemberId = userContext.userId;
  if (userContext?.hoaId && mongoose.Types.ObjectId.isValid(String(userContext.hoaId))) {
    data.hoaId = new mongoose.Types.ObjectId(String(userContext.hoaId));
  }
  const payee = new Payee(data);
  await payee.validate();
  const saved = await payee.save();

  if (userId) {
    const label = formatPayeeName(saved);
    await logActivity({
      userId,
      action: 'CREATE',
      module: 'Settings',
      entityId: saved._id,
      entityName: label,
      description: `Added payee "${label}"`,
      meta: { category: saved.category },
    });
  }

  return saved;
}

async function listPayees(query = {}, userContext = null) {
  const { category, search, pageNumber, pageSize } = query;
  const andClauses = [{ isDeleted: { $ne: true } }];

  // Community-scoped: include HOA-tagged payees plus legacy rows created by any active community member.
  if (userContext?.isHOABoardMember && userContext?.hoaId) {
    const hoaIdStr = String(userContext.hoaId);
    const hoaMatch = mongoose.Types.ObjectId.isValid(hoaIdStr)
      ? { hoaId: new mongoose.Types.ObjectId(hoaIdStr) }
      : { hoaId: hoaIdStr };
    const memberIds = (
      Array.isArray(userContext.hoaMemberUserIds) && userContext.hoaMemberUserIds.length
        ? userContext.hoaMemberUserIds
        : [userContext.userId]
    )
      .map((id) => {
        const str = String(id || '').trim();
        return mongoose.Types.ObjectId.isValid(str) ? new mongoose.Types.ObjectId(str) : null;
      })
      .filter(Boolean);

    const communityOr = [hoaMatch];
    if (memberIds.length) {
      communityOr.push(
        { createdBy: { $in: memberIds } },
        { hoaBoardMemberId: { $in: memberIds } },
      );
    }
    andClauses.push({ $or: communityOr });
  } else if (userContext?.isHOABoardMember) {
    const scoped = applyHOADataFilter({}, userContext);
    if (scoped && Object.keys(scoped).length) {
      andClauses.push(scoped);
    }
  }

  if (category) andClauses.push({ category });
  if (search) {
    const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'i');
    andClauses.push({
      $or: [
        { firstName: re },
        { lastName: re },
        { organization: re },
        { email: re },
      ],
    });
  }

  const filter = andClauses.length === 1 ? andClauses[0] : { $and: andClauses };
  const { offset, limit, page } = getPagination({ page: pageNumber, pageSize });

  const [data, total] = await Promise.all([
    Payee.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit || 0),
    Payee.countDocuments(filter),
  ]);

  return { data, total, page, pageSize: limit };
}

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

async function getPayeeById(id) {
  const oid = toObjectId(id);
  if (!oid) throw new NotFoundError('Payee not found');
  const payee = await Payee.findById(oid);
  if (!payee || payee.isDeleted) throw new NotFoundError('Payee not found');
  return payee;
}

async function updatePayee(id, updates, userId) {
  const oid = toObjectId(id);
  if (!oid) throw new NotFoundError('Payee not found');
  const payee = await Payee.findByIdAndUpdate(oid, { $set: updates }, { new: true, runValidators: true });
  if (!payee) throw new NotFoundError('Payee not found');

  if (userId) {
    const label = formatPayeeName(payee);
    await logActivity({
      userId,
      action: 'UPDATE',
      module: 'Settings',
      entityId: payee._id,
      entityName: label,
      description: `Updated payee "${label}"`,
      meta: { category: payee.category },
    });
  }

  return payee;
}

async function deletePayee(id, userId) {
  const oid = toObjectId(id);
  if (!oid) throw new NotFoundError('Payee not found');
  const payee = await Payee.findById(oid);
  if (!payee) throw new NotFoundError('Payee not found');
  const label = formatPayeeName(payee);
  payee.isDeleted = true;
  await payee.save();

  if (userId) {
    await logActivity({
      userId,
      action: 'DELETE',
      module: 'Settings',
      entityId: payee._id,
      entityName: label,
      description: `Removed payee "${label}"`,
      meta: { category: payee.category },
    });
  }

  return true;
}

module.exports = {
  createPayee,
  listPayees,
  getPayeeById,
  updatePayee,
  deletePayee
};
