'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const MasterData = require('../../master/model/masterData.model');
const {
  listExpenseCategories,
  createExpenseCategory,
  normalizeCategoryName,
} = require('../service/expenseCategory.service');

function buildCategoryDoc({ name, scope, userId, hoaId, createdBy }) {
  const trimmedName = String(name || '').trim().replace(/\s+/g, ' ');
  const normalizedName = normalizeCategoryName(trimmedName);
  return {
    _id: new mongoose.Types.ObjectId(),
    type: 'Expense_Custom_Category',
    key: 'expense_custom_category',
    scope,
    userId: scope === 'user' ? userId : null,
    hoaId: scope === 'hoa' ? hoaId : null,
    normalizedName,
    isActive: true,
    createdBy,
    data: [{ label: trimmedName, value: trimmedName, description: '' }],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('expenseCategory.service', () => {
  /** @type {Array<Record<string, unknown>>} */
  let store;

  beforeEach(() => {
    store = [];

    MasterData.find = (filter = {}) => ({
      sort: () => ({
        lean: async () =>
          store.filter((doc) => {
            if (filter.type && doc.type !== filter.type) return false;
            if (filter.scope && doc.scope !== filter.scope) return false;
            if (filter.userId && String(doc.userId) !== String(filter.userId)) return false;
            if (filter.hoaId && String(doc.hoaId) !== String(filter.hoaId)) return false;
            if (filter.isActive && filter.isActive.$ne === false && doc.isActive === false) return false;
            return true;
          }),
      }),
    });

    MasterData.findOne = (filter = {}) => ({
      lean: async () => {
        const match = (doc) => {
          if (filter.type && doc.type !== filter.type) return false;
          if (filter.scope && doc.scope !== filter.scope) return false;
          if (filter.userId && String(doc.userId) !== String(filter.userId)) return false;
          if (filter.hoaId && String(doc.hoaId) !== String(filter.hoaId)) return false;
          if (filter.normalizedName && doc.normalizedName !== filter.normalizedName) return false;
          if (filter._id?.$ne && String(doc._id) === String(filter._id.$ne)) return false;
          if (filter.isActive && filter.isActive.$ne === false && doc.isActive === false) return false;
          return true;
        };
        return store.find(match) || null;
      },
    });

    MasterData.create = async (payload) => {
      const doc = { ...payload, _id: new mongoose.Types.ObjectId(), createdAt: new Date(), updatedAt: new Date() };
      store.push(doc);
      return doc;
    };

    MasterData.countDocuments = async (filter = {}) =>
      store.filter((doc) => {
        if (filter.type && doc.type !== filter.type) return false;
        if (filter.scope && doc.scope !== filter.scope) return false;
        return true;
      }).length;
  });

  it('normalizeCategoryName collapses whitespace and lowercases', () => {
    assert.equal(normalizeCategoryName('  Community   Landscaping '), 'community landscaping');
  });

  it('creates HOA-scoped category visible to same community only', async () => {
    const hoaA = new mongoose.Types.ObjectId();
    const hoaB = new mongoose.Types.ObjectId();
    const userA = new mongoose.Types.ObjectId();

    await createExpenseCategory(
      { name: 'Community Landscaping', description: 'HOA grounds' },
      userA,
      { isHOABoardMember: true, hoaId: hoaA, userId: userA },
    );

    const listA = await listExpenseCategories({ isHOABoardMember: true, hoaId: hoaA, userId: userA }, userA);
    assert.ok(listA.categories.includes('Community Landscaping'));
    assert.equal(listA.customCategories.length, 1);

    const listB = await listExpenseCategories({ isHOABoardMember: true, hoaId: hoaB, userId: userA }, userA);
    assert.equal(listB.customCategories.length, 0);
    assert.equal(listB.categories.includes('Community Landscaping'), false);
  });

  it('creates landlord-scoped category visible only to that user', async () => {
    const userA = new mongoose.Types.ObjectId();
    const userB = new mongoose.Types.ObjectId();

    await createExpenseCategory(
      { name: 'Property Insurance', description: 'Landlord policy' },
      userA,
      null,
    );

    const listA = await listExpenseCategories(null, userA);
    assert.ok(listA.categories.includes('Property Insurance'));

    const listB = await listExpenseCategories(null, userB);
    assert.equal(listB.customCategories.length, 0);
  });

  it('prevents duplicate categories within the same scope', async () => {
    const userA = new mongoose.Types.ObjectId();
    await createExpenseCategory({ name: 'Roof Repair' }, userA, null);
    await assert.rejects(
      () => createExpenseCategory({ name: 'roof  repair' }, userA, null),
      (err) => err.status === 409,
    );
    const count = await MasterData.countDocuments({ type: 'Expense_Custom_Category', scope: 'user' });
    assert.equal(count, 1);
  });
});
