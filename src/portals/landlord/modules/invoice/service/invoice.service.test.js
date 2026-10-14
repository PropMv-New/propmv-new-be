// Simple test script for invoice creation logic
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Invoice = require('../model/invoice.model');
const Lease = require('../../leasing/model/lease.model');
const Property = require('../../property/model/property.model');
const { createInvoice } = require('../service/invoice.service');

async function run() {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);

  // Create property and lease
  const property = await Property.create({
    createdBy: new mongoose.Types.ObjectId(),
    name: 'Test Property',
    propertyType: 'residential',
    ownershipType: 'sole',
    ownerName: 'Owner',
    ownerEmail: 'owner@example.com',
    ownerPhone: '+1234567890',
    ownerType: 'primary',
    unitDetails: [{ unitName: 'Unit 1', unitType: 'apartment', squareFeet: 100 }],
  });
  const lease = await Lease.create({
    property_id: property._id,
    unitId: property.unitDetails[0]._id,
    unitName: 'Unit 1',
    leaseTerm: '2026',
    lease_type: 'FixedTerm', // Correct enum value
    start_date: new Date(),
    end_date: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    rentDetails: { frequency: 'monthly', amount: 1000, firstRentalInvoiceDue: new Date() },
    depositDetails: { amount: 0, isDepositAlreadyCollected: true },
    additionalFees: [],
    rentAndDepositDestribution: {
      split: [],
      securityDepositDestributionType: 'equal',
      rentDistributionType: 'equal',
      isPartialPaymentAllowed: false,
      isAllTenantsEquallyResponsible: true
    },
  });

  // Test: create invoice with only leaseId
  const payload = {
    leaseId: lease._id,
    invoiceId: 'INVTEST1',
    type: 'Other',
    term: '', // purposely blank
    tenants: [],
    invoiceItemDetails: [{ invoiceItem: 'Internet', description: 'Internet', quantity: 1, rate: 100, amount: 100 }],
    subAmount: 100,
    alreadyPaid: 0,
    balanceDue: 100,
    isPartialPaymentAllowed: false,
    dueDate: new Date(),
  };
  try {
    const result = await createInvoice(payload, property.createdBy, []);
    console.log('Invoice created successfully:', result.invoiceId, result.propertyId, result.unit, result.unitId);
  } catch (err) {
    console.error('Invoice creation failed:', err);
  }

  await mongoose.disconnect();
  await mongod.stop();
}

if (require.main === module) {
  run();
}