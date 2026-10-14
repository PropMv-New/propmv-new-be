'use strict';

const mongoose = require('mongoose');
const MasterData = require('../../master/model/masterData.model');
const {
  SYSTEM_EXPENSE_CATEGORIES,
  EXPENSE_CUSTOM_CATEGORY_TYPE,
  EXPENSE_CUSTOM_CATEGORY_KEY,
} = require('../../../../common/constants/expenseCategories');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function normalizeCategoryName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function resolveCategoryScope(userContext, userId) {
  if (userContext?.isHOABoardMember && userContext?.hoaId) {
    const hoaId = toObjectId(userContext.hoaId);
    if (!hoaId) {
      const err = new Error('Active HOA context is required to manage expense categories');
      err.status = 400;
      throw err;
    }
    return { scope: 'hoa', hoaId, userId: null };
  }

  const ownerId = toObjectId(userId);
  if (!ownerId) {
    const err = new Error('User context is required to manage expense categories');
    err.status = 401;
    throw err;
  }
  return { scope: 'user', userId: ownerId, hoaId: null };
}

function scopeFilter(scopeInfo) {
  const base = {
    type: EXPENSE_CUSTOM_CATEGORY_TYPE,
    scope: scopeInfo.scope,
    isActive: { $ne: false },
  };
  if (scopeInfo.scope === 'hoa') {
    return { ...base, hoaId: scopeInfo.hoaId };
  }
  return { ...base, userId: scopeInfo.userId };
}

function formatCategory(doc) {
  const item = Array.isArray(doc.data) && doc.data[0] ? doc.data[0] : {};
  return {
    id: String(doc._id),
    name: String(item.label || item.value || '').trim(),
    description: String(item.description || '').trim(),
    scope: doc.scope,
    isActive: doc.isActive !== false,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function userCanAccessCategory(doc, userContext, userId) {
  if (!doc || doc.type !== EXPENSE_CUSTOM_CATEGORY_TYPE) return false;
  if (doc.scope === 'hoa') {
    if (!userContext?.isHOABoardMember) return false;
    const docHoaId = toObjectId(doc.hoaId);
    const ctxHoaId = toObjectId(userContext?.hoaId);
    return Boolean(docHoaId && ctxHoaId && docHoaId.equals(ctxHoaId));
  }
  if (doc.scope === 'user') {
    const docUserId = toObjectId(doc.userId);
    const currentUserId = toObjectId(userId);
    return Boolean(docUserId && currentUserId && docUserId.equals(currentUserId));
  }
  return false;
}

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

async function listExpenseCategories(userContext, userId) {
  const scopeInfo = resolveCategoryScope(userContext, userId);
  const customDocs = await MasterData.find(scopeFilter(scopeInfo))
    .sort({ 'data.0.label': 1, createdAt: 1 })
    .lean();

  const customCategories = customDocs.map(formatCategory);
  const customNames = customCategories.map((c) => c.name).filter(Boolean);

  const systemSet = new Set(SYSTEM_EXPENSE_CATEGORIES);
  const merged = [...SYSTEM_EXPENSE_CATEGORIES];
  customNames.forEach((name) => {
    if (!systemSet.has(name)) merged.push(name);
  });

  return {
    systemCategories: [...SYSTEM_EXPENSE_CATEGORIES],
    customCategories,
    categories: merged,
  };
}

async function createExpenseCategory({ name, description }, userId, userContext = null) {
  const trimmedName = String(name || '').trim().replace(/\s+/g, ' ');
  if (!trimmedName) throw new ValidationError('Category name is required');
  if (trimmedName.length > 100) throw new ValidationError('Category name cannot be longer than 100 characters');

  const normalizedName = normalizeCategoryName(trimmedName);
  const scopeInfo = resolveCategoryScope(userContext, userId);

  const duplicate = await MasterData.findOne({
    ...scopeFilter(scopeInfo),
    normalizedName,
  }).lean();
  if (duplicate) {
    throw new ConflictError(`Category "${trimmedName}" already exists`);
  }

  const ownerId = toObjectId(userId);
  const doc = await MasterData.create({
    type: EXPENSE_CUSTOM_CATEGORY_TYPE,
    key: EXPENSE_CUSTOM_CATEGORY_KEY,
    scope: scopeInfo.scope,
    userId: scopeInfo.userId,
    hoaId: scopeInfo.hoaId,
    normalizedName,
    isActive: true,
    createdBy: ownerId,
    data: [{
      label: trimmedName,
      value: trimmedName,
      description: String(description || '').trim(),
      createdBy: ownerId,
    }],
  });

  return formatCategory(doc);
}

async function updateExpenseCategory(id, updates, userId, userContext = null) {
  const oid = toObjectId(id);
  if (!oid) throw new NotFoundError('Category not found');

  const doc = await MasterData.findById(oid);
  if (!doc || doc.type !== EXPENSE_CUSTOM_CATEGORY_TYPE || doc.isActive === false) {
    throw new NotFoundError('Category not found');
  }
  if (!userCanAccessCategory(doc, userContext, userId)) {
    const err = new Error('Access denied');
    err.status = 403;
    throw err;
  }

  const nextData = Array.isArray(doc.data) && doc.data[0] ? { ...doc.data[0] } : {};
  let nextNormalized = doc.normalizedName;

  if (updates.name !== undefined) {
    const trimmedName = String(updates.name || '').trim().replace(/\s+/g, ' ');
    if (!trimmedName) throw new ValidationError('Category name is required');
    if (trimmedName.length > 100) throw new ValidationError('Category name cannot be longer than 100 characters');
    nextNormalized = normalizeCategoryName(trimmedName);

    const scopeInfo = resolveCategoryScope(userContext, userId);
    const duplicate = await MasterData.findOne({
      ...scopeFilter(scopeInfo),
      normalizedName: nextNormalized,
      _id: { $ne: doc._id },
    }).lean();
    if (duplicate) throw new ConflictError(`Category "${trimmedName}" already exists`);

    nextData.label = trimmedName;
    nextData.value = trimmedName;
  }

  if (updates.description !== undefined) {
    nextData.description = String(updates.description || '').trim();
  }

  if (updates.isActive !== undefined) {
    doc.isActive = Boolean(updates.isActive);
  }

  doc.normalizedName = nextNormalized;
  doc.data = [nextData];
  await doc.save();
  return formatCategory(doc);
}

async function getExpenseCategoryById(id, userContext, userId) {
  const oid = toObjectId(id);
  if (!oid) throw new NotFoundError('Category not found');
  const doc = await MasterData.findById(oid).lean();
  if (!doc || doc.type !== EXPENSE_CUSTOM_CATEGORY_TYPE || doc.isActive === false) {
    throw new NotFoundError('Category not found');
  }
  if (!userCanAccessCategory(doc, userContext, userId)) {
    const err = new Error('Access denied');
    err.status = 403;
    throw err;
  }
  return formatCategory(doc);
}

module.exports = {
  listExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory,
  getExpenseCategoryById,
  normalizeCategoryName,
};
