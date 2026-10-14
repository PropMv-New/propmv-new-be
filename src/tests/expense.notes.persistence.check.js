/**
 * ------------------------------------------------------------------
 * File: expense.notes.persistence.check.js
 * Module: Src Tests
 *
 * Purpose:
 * Backend utility/module providing helper functions for expense.notes.persistence.check.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Integration check: expense addNote must persist a note in MongoDB.
 * Requires DB_URL (and related) in .env like other persistence checks.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/db.config');
const Expense = require('../shared/modules/expense/model/expense.model');
const { addNote } = require('../shared/modules/expense/service/expense.service');

/**
 * assert Equal
 *
 * Performs logic operations for assertEqual.
 *
 * @param actual - Request/input argument
 * @param expected - Request/input argument
 * @param label - Request/input argument
 * @returns Operations result
 */
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch. Expected "${expected}", got "${actual}"`);
  }
}

async function run() {
  await connectDB();

  const userId = new mongoose.Types.ObjectId();
  const created = await Expense.create({
    taxableEntity: '1',
    bankAccount: '1',
    property: new mongoose.Types.ObjectId(),
    unit: 'u',
    payees: [{ name: 'Payee' }],
    expenseItems: [
      {
        date: new Date('2026-04-23'),
        category: 'Advertising',
        description: 'd',
        amount: 1
      }
    ],
    vendorPaidTo: 'Payee',
    expenseDate: new Date('2026-04-23'),
    dueDate: new Date('2026-04-22'),
    status: 'overdue',
    total: 1,
    createdBy: userId
  });

  const id = String(created._id);
  const before = await Expense.findById(id).lean();
  if (before.notes && before.notes.length > 0) {
    throw new Error('expected expense to have no notes initially');
  }

  await addNote(id, 'Integration test note', String(userId));

  const after = await Expense.findById(id).lean();
  if (!after.notes || after.notes.length !== 1) {
    throw new Error(`expected 1 note in DB, got ${after.notes ? after.notes.length : 0}`);
  }
  assertEqual(after.notes[0].text, 'Integration test note', 'note.text');

  const fromService = await addNote(id, 'Second line', String(userId));
  if (!fromService.notes || fromService.notes.length !== 2) {
    throw new Error('addNote return should include two notes after second add');
  }

  await Expense.findByIdAndDelete(id);
  console.log('PASS: expense addNote $push persisted notes in MongoDB; service response includes all notes.');
}

run()
  .then(async () => {
    await disconnectDB();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('FAIL:', err.message);
    if (err.stack) console.error(err.stack);
    try { await disconnectDB(); } catch (e) { /* ignore */ }
    process.exit(1);
  });
