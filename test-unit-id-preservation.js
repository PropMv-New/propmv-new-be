/**
 * ------------------------------------------------------------------
 * File: test-unit-id-preservation.js
 * Module: Backend Core
 *
 * Purpose:
 * Backend utility/module providing helper functions for test-unit-id-preservation.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Test script to verify that unit _id values are preserved during property updates
 * This ensures lease references remain valid after property updates
 */

const mongoose = require('mongoose');
const Property = require('./src/portals/landlord/modules/property/model/property.model');
const Lease = require('./src/portals/landlord/modules/leasing/model/lease.model');
const { updatePropertyService } = require('./src/portals/landlord/modules/property/service/property.service');

async function testUnitIdPreservation() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/propmv', {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    console.log('Connected to MongoDB');

    // Create a test property with units
    const testProperty = new Property({
      landlord_id: new mongoose.Types.ObjectId(),
      name: 'Test Property for Unit ID Preservation',
      propertyType: 'Residential',
      ownershipType: 'Individual',
      ownerName: 'Test Owner',
      ownerEmail: 'test@example.com',
      ownerPhone: '+1234567890',
      ownerType: 'Individual',
      address: {
        street: '123 Test St',
        city: 'Test City',
        state: 'TS',
        zip: '12345',
        country: 'USA'
      },
      unitDetails: [
        {
          unitName: 'Unit A',
          unitType: 'Residential',
          squareFeet: 1000,
          bedRooms: 2,
          bathRoom: 1,
          rentIncludes: []
        },
        {
          unitName: 'Unit B',
          unitType: 'Residential',
          squareFeet: 1200,
          bedRooms: 3,
          bathRoom: 2,
          rentIncludes: []
        }
      ]
    });

    await testProperty.save();
    console.log('✓ Test property created');

    // Store original unit IDs
    const originalUnitAId = testProperty.unitDetails[0]._id.toString();
    const originalUnitBId = testProperty.unitDetails[1]._id.toString();
    console.log(`✓ Original Unit A ID: ${originalUnitAId}`);
    console.log(`✓ Original Unit B ID: ${originalUnitBId}`);

    // Create a test lease referencing Unit A
    const testLease = new Lease({
      property_id: testProperty._id,
      unitId: testProperty.unitDetails[0]._id,
      unitName: 'Unit A',
      leaseTerm: '12 months',
      lease_type: 'Fixed-Term',
      start_date: new Date(),
      end_date: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      rentDetails: {
        frequency: 'Monthly',
        amount: 1500,
        firstRentalInvoiceDue: new Date()
      },
      depositDetails: {
        amount: 1500,
        isDepositAlreadyCollected: false
      },
      rentAndDepositDestribution: {
        isAllTenantsEquallyResponsible: true,
        isPartialPaymentAllowed: false,
        rentDistributionType: 'Equal',
        securityDepositDestributionType: 'Equal',
        split: []
      }
    });

    await testLease.save();
    console.log('✓ Test lease created and linked to Unit A');

    // Update the property (modify unit details)
    const updateData = {
      unitDetails: [
        {
          unitName: 'Unit A',
          unitType: 'Residential',
          squareFeet: 1100, // Changed
          bedRooms: 2,
          bathRoom: 1,
          rentIncludes: ['Water'] // Changed
        },
        {
          unitName: 'Unit B',
          unitType: 'Residential',
          squareFeet: 1300, // Changed
          bedRooms: 3,
          bathRoom: 2,
          rentIncludes: ['Parking'] // Changed
        }
      ]
    };

    await updatePropertyService(testProperty._id, updateData, testProperty.landlord_id);
    console.log('✓ Property updated with modified unit details');

    // Fetch updated property
    const updatedProperty = await Property.findById(testProperty._id).lean();
    const newUnitAId = updatedProperty.unitDetails[0]._id.toString();
    const newUnitBId = updatedProperty.unitDetails[1]._id.toString();

    console.log(`✓ New Unit A ID: ${newUnitAId}`);
    console.log(`✓ New Unit B ID: ${newUnitBId}`);

    // Verify unit IDs are preserved
    if (originalUnitAId === newUnitAId) {
      console.log('SUCCESS: Unit A ID preserved after update');
    } else {
      console.log(' FAILURE: Unit A ID changed after update');
      console.log(`   Expected: ${originalUnitAId}`);
      console.log(`   Got: ${newUnitAId}`);
    }

    if (originalUnitBId === newUnitBId) {
      console.log('SUCCESS: Unit B ID preserved after update');
    } else {
      console.log(' FAILURE: Unit B ID changed after update');
      console.log(`   Expected: ${originalUnitBId}`);
      console.log(`   Got: ${newUnitBId}`);
    }

    // Verify lease still references correct unit
    const updatedLease = await Lease.findById(testLease._id).lean();
    if (updatedLease.unitId.toString() === originalUnitAId) {
      console.log('SUCCESS: Lease still references correct unit ID');
    } else {
      console.log(' FAILURE: Lease reference broken');
      console.log(`   Expected: ${originalUnitAId}`);
      console.log(`   Got: ${updatedLease.unitId.toString()}`);
    }

    // Cleanup
    await Property.findByIdAndDelete(testProperty._id);
    await Lease.findByIdAndDelete(testLease._id);
    console.log('✓ Test data cleaned up');

    console.log('\n=== Test completed successfully ===');

  } catch (error) {
    console.error(' Test failed with error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  }
}

// Run the test
testUnitIdPreservation();
