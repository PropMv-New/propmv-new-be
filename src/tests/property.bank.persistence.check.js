/**
 * ------------------------------------------------------------------
 * File: property.bank.persistence.check.js
 * Module: Src Tests
 *
 * Purpose:
 * Backend utility/module providing helper functions for property.bank.persistence.check.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../config/db.config');
const {
  createPropertyService,
  updatePropertyService,
  deletePropertyService,
} = require('../portals/landlord/modules/property/service/property.service');
const Property = require('../portals/landlord/modules/property/model/property.model');

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

  const landlordId = new mongoose.Types.ObjectId().toString();
  const uniqueSuffix = Date.now();

  const createPayload = {
    name: `BankPersistence_${uniqueSuffix}`,
    propertyType: 'apartment',
    type: 'apartment',
    description: 'Bank persistence validation property',
    ownershipType: 'individual',
    propertyManager: 'integration-test',
    hasHOA: false,
    address: {
      street: '123 Test St',
      line2: 'Apt 10A',
      city: 'Test City',
      state: 'Alabama',
      zip: '12345',
      country: 'USA',
    },
    ownerName: 'Test Owner',
    ownerEmail: `owner_${uniqueSuffix}@example.com`,
    ownerPhone: '(998) 877-6655',
    ownerType: 'individual',
    unitDetails: [
      {
        unitName: 'Unit 1',
        unitType: 'residential',
        rentIncludes: [],
        bedRooms: 1,
        bathRoom: 1,
        squareFeet: 1200,
        amenities: [],
      },
    ],
    propertySettings: {
      bankAccount: {
        entityType: 'individual',
        firstName: 'Annu',
        lastName: 'Bharti',
        email: `bank_${uniqueSuffix}@example.com`,
        phone: '(998) 877-6655',
        dob: '1997-04-03',
        ssn: '123-45-6789',
        bankName: 'Chase Bank',
        accountType: 'checking',
        routingNumber: '123456789',
        accountNumber: '123456789012',
        address: {
          street: 'Ventana, Clover Park',
          line2: 'Suite B',
          city: 'Test',
          state: 'Alabama',
          zip: '12345',
        },
      },
      lateFees: [],
    },
    status: 'active',
  };

  const created = await createPropertyService(createPayload, landlordId);
  const createdId = created._id.toString();

  const createdDoc = await Property.findById(createdId).lean();
  if (!createdDoc) {
    throw new Error('Created property not found in DB');
  }

  assertEqual(createdDoc.propertySettings?.bankAccount?.bankName, 'Chase Bank', 'create.bankName');
  assertEqual(createdDoc.propertySettings?.bankAccount?.accountType, 'checking', 'create.accountType');
  assertEqual(createdDoc.propertySettings?.bankAccount?.routingNumber, '123456789', 'create.routingNumber');
  assertEqual(createdDoc.propertySettings?.bankAccount?.accountNumber, '123456789012', 'create.accountNumber');
  assertEqual(createdDoc.address?.addressLine2, 'Apt 10A', 'create.property.addressLine2');
  assertEqual(createdDoc.propertySettings?.bankAccount?.address?.addressLine2, 'Suite B', 'create.bankAccount.addressLine2');

  const updatePayload = {
    ...createPayload,
    name: `BankPersistence_${uniqueSuffix}_Updated`,
    address: {
      ...createPayload.address,
      addressLine2: 'Unit 201',
    },
    propertySettings: {
      ...createPayload.propertySettings,
      bankAccount: {
        ...createPayload.propertySettings.bankAccount,
        bankName: 'Wells Fargo',
        accountType: 'savings',
        routingNumber: '987654321',
        accountNumber: '999988887777',
        address: {
          ...createPayload.propertySettings.bankAccount.address,
          addressLine2: 'Floor 3',
        },
      },
    },
  };

  await updatePropertyService(createdId, updatePayload, landlordId);

  const updatedDoc = await Property.findById(createdId).lean();
  if (!updatedDoc) {
    throw new Error('Updated property not found in DB');
  }

  assertEqual(updatedDoc.propertySettings?.bankAccount?.bankName, 'Wells Fargo', 'update.bankName');
  assertEqual(updatedDoc.propertySettings?.bankAccount?.accountType, 'savings', 'update.accountType');
  assertEqual(updatedDoc.propertySettings?.bankAccount?.routingNumber, '987654321', 'update.routingNumber');
  assertEqual(updatedDoc.propertySettings?.bankAccount?.accountNumber, '999988887777', 'update.accountNumber');
  assertEqual(updatedDoc.address?.addressLine2, 'Unit 201', 'update.property.addressLine2');
  assertEqual(updatedDoc.propertySettings?.bankAccount?.address?.addressLine2, 'Floor 3', 'update.bankAccount.addressLine2');

  await deletePropertyService(createdId);

  console.log('PASS: property bank fields persisted on create and update.');
}

run()
  .then(async () => {
    await disconnectDB();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('FAIL:', err.message);
    try { await disconnectDB(); } catch (e) {}
    process.exit(1);
  });

