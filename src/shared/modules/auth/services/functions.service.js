/**
 * ------------------------------------------------------------------
 * File: functions.service.js
 * Module: Src Shared Modules Auth Services
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * functions.controller
 * ------------------------------------------------------------------
 */

const Function = require('../models/function.model');
const Company = require('../../company/models/company.model');

async function listFunctions() {
  return Function.find();
}

async function getFunctionById(id) {
  const item = await Function.findById(id);
  if (!item) throw new Error('Function not found');
  return item;
}

async function createFunction({ name, description }) {
  const { checkTransactionSupport } = require('../../../../common/helpers/transactionHelper');
  const mongoose = require('mongoose');
  const transactionsSupported = await checkTransactionSupport();
  let session;
  if (transactionsSupported) {
    session = await mongoose.startSession();
    session.startTransaction();
  }
  try {
    const exists = transactionsSupported
      ? await Function.findOne({ name }).session(session)
      : await Function.findOne({ name });
    if (exists) throw new Error('Function already exists');
    const functionFields = {
      name: name ?? null,
      description: description ?? null,
    };
    let func;
    if (transactionsSupported) {
      const funcDoc = await Function.create([functionFields], { session });
      func = funcDoc[0];
    } else {
      func = await Function.create(functionFields);
    }
    if (transactionsSupported) {
      await session.commitTransaction();
      session.endSession();
    }
    return func;
  } catch (err) {
    if (transactionsSupported && session) {
      await session.abortTransaction();
      session.endSession();
    }
    throw err;
  }
}

async function updateFunction(id, { name, description }) {
  const { checkTransactionSupport } = require('../../../../common/helpers/transactionHelper');
  const mongoose = require('mongoose');
  const transactionsSupported = await checkTransactionSupport();
  let session;
  if (transactionsSupported) {
    session = await mongoose.startSession();
    session.startTransaction();
  }
  try {
    const $set = {};
    if (name !== undefined) $set.name = name;
    if (description !== undefined) $set.description = description;
    const item = transactionsSupported
      ? await Function.findByIdAndUpdate(id, { $set }, { new: true, session })
      : await Function.findByIdAndUpdate(id, { $set }, { new: true });
    if (!item) throw new Error('Function not found');
    if (transactionsSupported) {
      await session.commitTransaction();
      session.endSession();
    }
    return item;
  } catch (err) {
    if (transactionsSupported && session) {
      await session.abortTransaction();
      session.endSession();
    }
    throw err;
  }
}

async function deleteFunction(id) {
  const { checkTransactionSupport } = require('../../../../common/helpers/transactionHelper');
  const mongoose = require('mongoose');
  const transactionsSupported = await checkTransactionSupport();
  let session;
  if (transactionsSupported) {
    session = await mongoose.startSession();
    session.startTransaction();
  }
  try {
    const func = transactionsSupported
      ? await Function.findById(id).session(session)
      : await Function.findById(id);
    if (!func) throw new Error('Function not found');

    const inUse = transactionsSupported
      ? await Company.exists({ 'roles.privileges': func.name, isDeleted: { $ne: true } }).session(session)
      : await Company.exists({ 'roles.privileges': func.name, isDeleted: { $ne: true } });
    if (inUse) throw new Error('Cannot delete: function is in use by one or more company roles');

    const item = transactionsSupported
      ? await Function.findByIdAndDelete(id, { session })
      : await Function.findByIdAndDelete(id);
    if (!item) throw new Error('Function not found');
    if (transactionsSupported) {
      await session.commitTransaction();
      session.endSession();
    }
    return true;
  } catch (err) {
    if (transactionsSupported && session) {
      await session.abortTransaction();
      session.endSession();
    }
    throw err;
  }
}

module.exports = {
  listFunctions,
  getFunctionById,
  createFunction,
  updateFunction,
  deleteFunction,
};
