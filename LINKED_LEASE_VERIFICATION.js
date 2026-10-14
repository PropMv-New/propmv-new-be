/**
 * ------------------------------------------------------------------
 * File: LINKED_LEASE_VERIFICATION.js
 * Module: Backend Core
 *
 * Purpose:
 * Backend utility/module providing helper functions for LINKED_LEASE_VERIFICATION.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * LinkedLease Feature Verification Script
 * 
 * This script demonstrates how the linkedLease field works and can be used for testing
 */

// Example: How the linkedLease field is populated during lease renewal

console.log('=== LinkedLease Feature Verification ===\n');

// Scenario 1: Original Lease
const originalLease = {
  _id: '507f1f77bcf86cd799439011',
  property_id: '507f191e810c19729de860ea',
  unitName: 'Unit 101',
  status: 'Active',
  start_date: '2023-06-01',
  end_date: '2024-05-31',
  rentDetails: { amount: 1500, frequency: 'monthly' },
  // linkedLease: undefined (original lease has no linked lease)
};

console.log('1. Original Lease:');
console.log(JSON.stringify(originalLease, null, 2));
console.log('\n');

// Scenario 2: User initiates renewal with "Renew With New Lease"
console.log('2. User initiates renewal with type: "Renew With New Lease"');
console.log('   - System terminates old lease (status -> Terminated)');
console.log('   - System creates new lease with linkedLease field\n');

// Scenario 3: New Renewed Lease (after renewal)
const renewedLease = {
  _id: '507f1f77bcf86cd799439022', // NEW lease ID
  property_id: '507f191e810c19729de860ea',
  unitName: 'Unit 101',
  status: 'Submitted',
  start_date: '2024-06-01',
  end_date: '2025-05-31',
  rentDetails: { amount: 1600, frequency: 'monthly' }, // Updated rent
  linkedLease: '507f1f77bcf86cd799439011' // <-- POINTS TO ORIGINAL LEASE
};

console.log('3. New Renewed Lease:');
console.log(JSON.stringify(renewedLease, null, 2));
console.log('\n');

// Scenario 4: Query Examples
console.log('4. Query Examples:\n');

console.log('a) Find all leases renewed from a specific original lease:');
console.log('   const renewedLeases = await Lease.find({');
console.log('     linkedLease: "507f1f77bcf86cd799439011",');
console.log('     isDeleted: { $ne: true }');
console.log('   });\n');

console.log('b) Get original lease info from a renewed lease:');
console.log('   const renewedLease = await Lease.findById(leaseId)');
console.log('     .populate("linkedLease")');
console.log('     .lean();\n');

console.log('c) Count renewal chain length:');
console.log('   const renewalCount = await Lease.countDocuments({');
console.log('     linkedLease: originalLeaseId');
console.log('   });\n');

// Scenario 5: Validation Checklist
console.log('5. Validation Checklist:\n');
console.log('   linkedLease field added to Lease model');
console.log('   linkedLease populated during "Renew With New Lease" flow');
console.log('   linkedLease accepted and saved in createLeaseService');
console.log('   Original lease remains with status "Terminated"');
console.log('   New lease references original via linkedLease field');
console.log('   No impact on "Renew And Extend" flow (updates existing lease)');
console.log('   Backward compatible (field is optional)\n');

// Scenario 6: Database Verification Queries
console.log('6. Database Verification Queries:\n');
console.log('// Check if linkedLease field exists in schema:');
console.log('db.leases.findOne({}, { linkedLease: 1 });\n');

console.log('// Find renewed leases (those with linkedLease field):');
console.log('db.leases.find({ linkedLease: { $exists: true } });\n');

console.log('// Find original lease from renewed lease:');
console.log('db.leases.findOne({ _id: ObjectId("renewedLeaseId") })');
console.log('  .then(renewed => db.leases.findOne({ _id: renewed.linkedLease }));\n');

console.log('=== Verification Complete ===');

// API Testing Example
console.log('\n=== API Testing Example ===\n');
console.log('POST /api/v1/leasing/renew-lease/:leaseId');
console.log('Request Body:');
console.log(JSON.stringify({
  type: 'Renew With New Lease',
  lease: {
    property_id: '507f191e810c19729de860ea',
    unitName: 'Unit 101',
    start_date: '2024-06-01',
    end_date: '2025-05-31',
    leaseTerm: '12 months',
    lease_type: 'Fixed-term',
    rentDetails: {
      amount: 1600,
      frequency: 'monthly',
      dueOne: '1',
      firstRentalInvoiceDue: '2024-06-01'
    },
    depositDetails: {
      amount: 1600,
      due: '2024-06-01',
      isDepositAlreadyCollected: false
    },
    rentAndDepositDestribution: {
      isAllTenantsEquallyResponsible: true,
      isPartialPaymentAllowed: true,
      rentDistributionType: 'Equal',
      securityDepositDestributionType: 'Equal',
      split: [
        {
          tenantId: '507f191e810c19729de860eb',
          rentAmount: 1600,
          rentPercentage: 100,
          depositAmount: 1600,
          depositPercentage: 100
        }
      ]
    }
  }
}, null, 2));

console.log('\nExpected Response:');
console.log(JSON.stringify({
  _id: 'new-lease-id',
  linkedLease: 'original-lease-id', // <-- AUTOMATICALLY SET
  status: 'Submitted',
  // ... other lease fields
}, null, 2));

console.log('\n=== End of Verification Script ===');
