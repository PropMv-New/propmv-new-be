const mongoose = require('mongoose');
const Lease = require('../model/lease.model');

// Load environment variables
require('dotenv').config();

/**
 * Unit Test for invoiceSummary Persistence
 * Tests that invoiceSummary field is correctly stored in MongoDB
 */

async function runInvoiceSummaryTest() {
  console.log('\n========================================');
  console.log('🧪 INVOICE SUMMARY PERSISTENCE TEST');
  console.log('========================================\n');

  try {
    // Connect to MongoDB if not already connected
    if (mongoose.connection.readyState !== 1) {
      console.log('📡 Connecting to MongoDB...');
      const mongoUri = process.env.DB_URL || 'mongodb://localhost:27017/propmv';
      await mongoose.connect(mongoUri);
      console.log('MongoDB connected\n');
    }

    // Test 1: Direct Mongoose Document Test
    console.log('📝 Test 1: Creating lease with invoiceSummary via Mongoose\n');

    const testInvoiceSummary = {
      rent: {
        dueDate: new Date('2026-04-15'),
        amount: 1000,
        frequency: 'monthly',
        description: 'Rent - monthly'
      },
      deposit: {
        dueDate: new Date('2026-04-15'),
        amount: 1000,
        description: 'Security Deposit'
      },
      additionalCharges: [
        {
          name: 'Test Charge',
          dueDate: new Date('2026-04-15'),
          frequency: 'monthly',
          amount: 100,
          description: 'Test',
          startDate: new Date('2026-04-15'),
          endDate: new Date('2026-12-02'),
          isRecurringInvoice: true,
          lineItemOnRentalInvoice: false
        }
      ],
      totalMonthlyAmount: 1100,
      totalOneTimeAmount: 1000
    };

    console.log('✏️ Test Invoice Summary Object:');
    console.log(JSON.stringify(testInvoiceSummary, null, 2));

    // Create a test lease document
    const testLeaseData = {
      property_id: new mongoose.Types.ObjectId(),
      unitName: 'Test Unit',
      leaseTerm: 'Fixed Term',
      lease_type: 'FixedTerm',
      start_date: new Date('2026-04-15'),
      end_date: new Date('2026-12-31'),
      switchMonthToMonth: false,
      auto_renew: false,
      rentDetails: {
        frequency: 'monthly',
        amount: 1000,
        dueOne: '1st',
        firstRentalInvoiceDue: new Date('2026-04-15')
      },
      depositDetails: {
        amount: 1000,
        due: new Date('2026-04-15'),
        isDepositAlreadyCollected: false
      },
      rentAndDepositDestribution: {
        isAllTenantsEquallyResponsible: true,
        isPartialPaymentAllowed: false,
        rentDistributionType: 'Fixed',
        securityDepositDestributionType: 'Fixed',
        split: [
          {
            tenantId: new mongoose.Types.ObjectId(),
            rentAmount: 1000,
            rentPercentage: 100,
            depositAmount: 1000,
            depositPercentage: 100,
            screening: ['application', 'credit', 'criminal']
          }
        ]
      },
      status: 'Submitted',
      invoiceSummary: testInvoiceSummary
    };

    console.log('\n📝 Lease data being saved (with invoiceSummary):');
    console.log(`   - unitName: ${testLeaseData.unitName}`);
    console.log(`   - invoiceSummary.rent.amount: ${testLeaseData.invoiceSummary.rent.amount}`);
    console.log(`   - invoiceSummary.deposit.amount: ${testLeaseData.invoiceSummary.deposit.amount}`);
    console.log(`   - invoiceSummary.additionalCharges.length: ${testLeaseData.invoiceSummary.additionalCharges.length}`);
    console.log(`   - invoiceSummary.totalMonthlyAmount: ${testLeaseData.invoiceSummary.totalMonthlyAmount}`);

    // Save the lease
    const savedLease = await Lease.create(testLeaseData);

    console.log('\nLease saved successfully');
    console.log(`   - ID: ${savedLease._id}`);
    console.log(`   - unitName: ${savedLease.unitName}`);

    // Test 2: Verify invoiceSummary in saved document
    console.log('\n📝 Test 2: Checking invoiceSummary in saved document\n');

    console.log('🔍 Checking savedLease object:');
    console.log(`   - savedLease.invoiceSummary exists? ${savedLease.invoiceSummary ? 'YES' : ' NO'}`);

    if (savedLease.invoiceSummary) {
      console.log(`   - rent.amount: ${savedLease.invoiceSummary.rent?.amount}`);
      console.log(`   - deposit.amount: ${savedLease.invoiceSummary.deposit?.amount}`);
      console.log(`   - additionalCharges count: ${savedLease.invoiceSummary.additionalCharges?.length}`);
      console.log(`   - totalMonthlyAmount: ${savedLease.invoiceSummary.totalMonthlyAmount}`);
    }

    // Test 3: Query from database and verify
    console.log('\n📝 Test 3: Querying lease from database\n');

    const queriedLease = await Lease.findById(savedLease._id);

    console.log('🔍 Checking queriedLease from database:');
    console.log(`   - queriedLease.invoiceSummary exists? ${queriedLease.invoiceSummary ? 'YES' : ' NO'}`);

    if (queriedLease.invoiceSummary) {
      console.log(`   - rent.amount: ${queriedLease.invoiceSummary.rent?.amount}`);
      console.log(`   - deposit.amount: ${queriedLease.invoiceSummary.deposit?.amount}`);
      console.log(`   - additionalCharges count: ${queriedLease.invoiceSummary.additionalCharges?.length}`);
      console.log(`   - totalMonthlyAmount: ${queriedLease.invoiceSummary.totalMonthlyAmount}`);

      // Verify data integrity
      const isRentCorrect = queriedLease.invoiceSummary.rent?.amount === 1000;
      const isDepositCorrect = queriedLease.invoiceSummary.deposit?.amount === 1000;
      const isChargesCorrect = queriedLease.invoiceSummary.additionalCharges?.length === 1;
      const isTotalsCorrect = queriedLease.invoiceSummary.totalMonthlyAmount === 1100 && queriedLease.invoiceSummary.totalOneTimeAmount === 1000;

      console.log('\n📊 Data Integrity Check:');
      console.log(`   - Rent amount correct (1000)? ${isRentCorrect ? 'YES' : ' NO'}`);
      console.log(`   - Deposit amount correct (1000)? ${isDepositCorrect ? 'YES' : ' NO'}`);
      console.log(`   - Additional charges count (1)? ${isChargesCorrect ? 'YES' : ' NO'}`);
      console.log(`   - Totals correct? ${isTotalsCorrect ? 'YES' : ' NO'}`);

      if (isRentCorrect && isDepositCorrect && isChargesCorrect && isTotalsCorrect) {
        console.log('\n🎉 ALL TESTS PASSED! invoiceSummary is being persisted correctly!\n');
        return true;
      } else {
        console.log('\n SOME TESTS FAILED! Data mismatch detected.\n');
        return false;
      }
    } else {
      console.log('\n TEST FAILED! invoiceSummary not found in database!\n');
      return false;
    }

  } catch (error) {
    console.error('\n TEST ERROR:', error.message);
    console.error(error);
    return false;
  }
}

// Export for use in testing
module.exports = { runInvoiceSummaryTest };

// Run test if executed directly
if (require.main === module) {
  runInvoiceSummaryTest().then(success => {
    console.log('\n========================================');
    console.log(success ? 'TEST SUITE PASSED' : ' TEST SUITE FAILED');
    console.log('========================================\n');
    process.exit(success ? 0 : 1);
  });
}
