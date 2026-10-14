/**
 * HOA Bulk Data Seed Script - PropMv Database
 * User  : hiteshchavhan0811@gmail.com  (HOA Board Member)
 * HOA   : PropCare  (6a68b5e841ff222561fa638b)
 * DB    : PropMv  (mongodb+srv://...@propmv.nghqvlv.mongodb.net/PropMv)
 *
 * Insertion order:
 *  1. HOA Owners (Users with HOA Owner role)  - 1000
 *  2. HOA Properties (units)                  - 1000
 *  3. HOA Leases                              - 1000
 *  4. HOA Invoices                            - 1000
 *  5. HOA Expenses                            - 1000
 *  6. HOA Maintenance Requests                - 1000
 *  7. HOA Vendor Invoices                     - 1000
 *  8. HOA Applications                        - 1000
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const DB_URL = 'mongodb+srv://support_db_user:bCmGvGJJBywa9itS@propmv.nghqvlv.mongodb.net/PropMv?appName=PropMv';

// Known IDs from PropMv DB
const BOARD_MEMBER_ID = new mongoose.Types.ObjectId('6a68b5cd41ff222561fa637e'); // hiteshchavhan0811@gmail.com
const HOA_ID = new mongoose.Types.ObjectId('6a68b5e841ff222561fa638b'); // PropCare
const COMPANY_ID = new mongoose.Types.ObjectId('6a24563f1cda7ba2581d6e79'); // PropMv company
const HOA_OWNER_ROLE_ID = new mongoose.Types.ObjectId('6a24563f1cda7ba2581d6e7e'); // HOA Owner role
// Use an existing depositBankAccountId from another HOA property as a placeholder ObjectId
const DUMMY_BANK_ID = new mongoose.Types.ObjectId('6a65dc226dd8ff5d114d69f3');

const TOTAL = 100000;
const BATCH_SIZE = 500;

// ── helpers ──────────────────────────────────────────────────────────────────
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randFloat = (min, max) => parseFloat((Math.random() * (max - min) + min).toFixed(2));
const future = (days) => new Date(Date.now() + days * 86400000);
const past = (days) => new Date(Date.now() - days * 86400000);

const US_STATES = ['CA', 'TX', 'FL', 'NY', 'IL', 'PA', 'OH', 'GA', 'NC', 'MI'];
const CITIES = ['Los Angeles', 'Houston', 'Miami', 'New York', 'Chicago', 'Philadelphia', 'Columbus', 'Atlanta', 'Charlotte', 'Detroit'];
const STREETS = ['Main St', 'Oak Ave', 'Maple Dr', 'Cedar Ln', 'Pine Rd', 'Elm St', 'Park Blvd', 'Lake Dr', 'River Rd', 'Hill St'];
const PROP_TYPES = ['Single Family', 'Multi Family', 'Condo', 'Townhouse', 'Apartment'];
const OWN_TYPES = ['Individual', 'LLC', 'Corporation'];
const MAINT_CATS = ['Plumbing', 'Electrical', 'HVAC', 'Appliance', 'Structural', 'Pest Control', 'Landscaping', 'Other'];
const MAINT_PRI = ['Low', 'Medium', 'High', 'Urgent'];
const MAINT_STS = ['Open', 'InProgress', 'Completed'];
const EXP_CATS = ['Repairs', 'Utilities', 'Insurance', 'Taxes', 'Management', 'Landscaping', 'Cleaning', 'Other'];
const INV_TYPES = ['HOA Fee', 'Rent', 'Deposit', 'Miscellaneous', 'Other'];
const INV_STS = ['Pending', 'Paid', 'Partially Paid', 'Overdue'];
const APP_STS = ['submitted', 'pending', 'approved', 'rejected'];
const LEASE_TYPES = ['FixedTerm', 'MonthToMonth'];
const FREQ_TYPES = ['monthly', 'bi-monthly', 'weekly', 'bi-weekly'];

async function insertInBatches(collection, docs, label) {
  let inserted = 0;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    try {
      await collection.insertMany(batch, { ordered: false });
    } catch (e) {
      // ordered:false - partial inserts on duplicate key; ignore
    }
    inserted += batch.length;
    process.stdout.write(`\r  ${label}: ${Math.min(inserted, docs.length)}/${docs.length}`);
  }
  console.log(`\r   ${label}: batch done`);
}

async function main() {
  console.log('🔌 Connecting to PropMv database...');
  await mongoose.connect(DB_URL);
  const db = mongoose.connection.db;
  console.log(' Connected to DB:', db.databaseName, '\n');

  // ── 1. HOA Owners ─────────────────────────────────────────────────────────
  console.log('📦 Step 1: Seeding HOA Owners...');
  const existingOwnerCount = await db.collection('users').countDocuments({
    companyId: COMPANY_ID,
    companyRoleId: HOA_OWNER_ROLE_ID,
    'hoaInfo.hoaId': HOA_ID,
    isDeleted: { $ne: true },
  });
  console.log(`  Existing HOA owners: ${existingOwnerCount}`);

  let ownerIds = [];
  if (existingOwnerCount >= TOTAL) {
    const owners = await db.collection('users')
      .find({ companyId: COMPANY_ID, companyRoleId: HOA_OWNER_ROLE_ID, 'hoaInfo.hoaId': HOA_ID, isDeleted: { $ne: true } })
      .project({ _id: 1 }).limit(TOTAL).toArray();
    ownerIds = owners.map(o => o._id);
    console.log(`  ℹ️  Already have ${ownerIds.length} owners, skipping insert`);
  } else {
    const needed = TOTAL - existingOwnerCount;
    const hashedPwd = await bcrypt.hash('Owner@123', 10);
    const ts = Date.now();
    const ownerDocs = Array.from({ length: needed }, (_, i) => ({
      _id: new mongoose.Types.ObjectId(),
      email: `hoa.owner.${ts}.${i + 1}@propmv-seed.com`,
      password: hashedPwd,
      firstName: `OwnerFirst${i + 1}`,
      lastName: `OwnerLast${i + 1}`,
      phone: `+1${randInt(2000000000, 9999999999)}`,
      address: `${randInt(100, 9999)} ${rand(STREETS)}`,
      state: rand(US_STATES),
      zipCode: `${randInt(10000, 99999)}`,
      status: 'Active',
      companyId: COMPANY_ID,
      companyRoleId: HOA_OWNER_ROLE_ID,
      hoaInfo: { hoaId: HOA_ID, communityName: 'PropCare', numberOfUnits: 1, associationType: 'Apartment' },
      createdBy: BOARD_MEMBER_ID,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    await insertInBatches(db.collection('users'), ownerDocs, 'HOA Owners');
    const allOwners = await db.collection('users')
      .find({ companyId: COMPANY_ID, companyRoleId: HOA_OWNER_ROLE_ID, 'hoaInfo.hoaId': HOA_ID, isDeleted: { $ne: true } })
      .project({ _id: 1 }).limit(TOTAL).toArray();
    ownerIds = allOwners.map(o => o._id);
  }
  console.log(`  📊 Owner IDs available: ${ownerIds.length}`);

  // ── 2. HOA Properties (units) ─────────────────────────────────────────────
  console.log('\n📦 Step 2: Seeding HOA Properties...');
  const existingPropCount = await db.collection('properties').countDocuments({
    landlord_id: BOARD_MEMBER_ID,
    hoaId: HOA_ID,
    isDeleted: { $ne: true },
  });
  console.log(`  Existing HOA properties: ${existingPropCount}`);

  let propertyIds = [];
  let propertyDocs_cache = [];

  if (existingPropCount >= TOTAL) {
    const props = await db.collection('properties')
      .find({ landlord_id: BOARD_MEMBER_ID, hoaId: HOA_ID, isDeleted: { $ne: true } })
      .project({ _id: 1, unitDetails: 1 }).limit(TOTAL).toArray();
    propertyIds = props.map(p => p._id);
    propertyDocs_cache = props;
    console.log(`  ℹ️  Already have ${propertyIds.length} properties, skipping insert`);
  } else {
    const needed = TOTAL - existingPropCount;
    const propDocs = Array.from({ length: needed }, (_, i) => {
      const idx = existingPropCount + i + 1;
      const si = i % US_STATES.length;
      const unitId = new mongoose.Types.ObjectId();
      const ownerId = ownerIds[i % ownerIds.length];
      return {
        _id: new mongoose.Types.ObjectId(),
        landlord_id: BOARD_MEMBER_ID,
        hoaId: HOA_ID,
        name: `PropCare Community`,
        propertyType: rand(PROP_TYPES),
        ownershipType: 'Owned',
        ownerName: `OwnerFirst${idx} OwnerLast${idx}`,
        ownerEmail: `hoa.owner.prop.${Date.now()}.${idx}@propmv-seed.com`,
        ownerPhone: `+1${randInt(2000000000, 9999999999)}`,
        ownerType: rand(OWN_TYPES),
        address: {
          street: `${randInt(100, 9999)} ${rand(STREETS)}`,
          city: CITIES[si],
          state: US_STATES[si],
          zip: `${randInt(10000, 99999)}`,
          country: 'USA',
        },
        unitDetails: [{
          _id: unitId,
          unitName: `Unit-${idx}`,
          unitType: 'Residential',
          squareFeet: randInt(500, 3000),
          bedRooms: randInt(1, 4),
          bathRoom: randInt(1, 3),
          amenities: ['Parking', 'Laundry'],
        }],
        depositBankAccountId: DUMMY_BANK_ID,
        depositBankAccountName: 'Primary Checking',
        associatedOwnerIds: [ownerId],
        monthlyRecurringFee: randFloat(200, 1000),
        paymentTerm: 12,
        startingBalance: 0,
        isDeleted: false,
        isArchieved: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });
    await insertInBatches(db.collection('properties'), propDocs, 'HOA Properties');
    const allProps = await db.collection('properties')
      .find({ landlord_id: BOARD_MEMBER_ID, hoaId: HOA_ID, isDeleted: { $ne: true } })
      .project({ _id: 1, unitDetails: 1 }).limit(TOTAL).toArray();
    propertyIds = allProps.map(p => p._id);
    propertyDocs_cache = allProps;
  }
  console.log(`  📊 Property IDs available: ${propertyIds.length}`);

  // helper: get unitName for a property
  const getUnitName = (idx) => {
    const p = propertyDocs_cache[idx % propertyDocs_cache.length];
    return p?.unitDetails?.[0]?.unitName || `Unit-${idx + 1}`;
  };

  // ── 3. HOA Leases ─────────────────────────────────────────────────────────
  console.log('\n📦 Step 3: Seeding HOA Leases...');
  const existingLeaseCount = await db.collection('leases').countDocuments({
    property_id: { $in: propertyIds },
    isDeleted: { $ne: true },
  });
  console.log(`  Existing HOA leases: ${existingLeaseCount}`);

  let leaseIds = [];
  if (existingLeaseCount >= TOTAL) {
    const leases = await db.collection('leases')
      .find({ property_id: { $in: propertyIds }, isDeleted: { $ne: true } })
      .project({ _id: 1 }).limit(TOTAL).toArray();
    leaseIds = leases.map(l => l._id);
    console.log(`  ℹ️  Already have ${leaseIds.length} leases, skipping insert`);
  } else {
    const needed = TOTAL - existingLeaseCount;
    const leaseDocs = Array.from({ length: needed }, (_, i) => {
      const propId = propertyIds[i % propertyIds.length];
      const ownerId = ownerIds[i % ownerIds.length];
      const unitName = getUnitName(i);
      const rentAmt = randFloat(300, 1500);
      const depAmt = randFloat(300, 1500);
      return {
        _id: new mongoose.Types.ObjectId(),
        property_id: propId,
        unitName,
        leaseTerm: '12 months',
        lease_type: rand(LEASE_TYPES),
        start_date: past(randInt(30, 365)),
        end_date: future(randInt(30, 365)),
        switchMonthToMonth: false,
        auto_renew: false,
        rentDetails: {
          frequency: rand(FREQ_TYPES),
          amount: rentAmt,
          dueOne: '1',
          firstRentalInvoiceDue: future(randInt(1, 30)),
        },
        depositDetails: {
          amount: depAmt,
          due: future(randInt(1, 15)),
          isDepositAlreadyCollected: false,
        },
        rentAndDepositDestribution: {
          isAllTenantsEquallyResponsible: true,
          isPartialPaymentAllowed: false,
          rentDistributionType: 'Equal',
          securityDepositDestributionType: 'Equal',
          split: [{
            tenantId: String(ownerId),
            rentAmount: rentAmt,
            rentPercentage: 100,
            depositAmount: depAmt,
            depositPercentage: 100,
            screening: [],
            inviteAcknowledged: false,
          }],
        },
        status: 'Submitted',
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });
    await insertInBatches(db.collection('leases'), leaseDocs, 'HOA Leases');
    const allLeases = await db.collection('leases')
      .find({ property_id: { $in: propertyIds }, isDeleted: { $ne: true } })
      .project({ _id: 1 }).limit(TOTAL).toArray();
    leaseIds = allLeases.map(l => l._id);
  }
  console.log(`  📊 Lease IDs available: ${leaseIds.length}`);

  // ── 4. HOA Invoices ───────────────────────────────────────────────────────
  console.log('\n📦 Step 4: Seeding HOA Invoices...');
  const existingInvCount = await db.collection('invoices').countDocuments({
    hoaId: HOA_ID,
    isDeleted: { $ne: true },
  });
  console.log(`  Existing HOA invoices: ${existingInvCount}`);

  if (existingInvCount < TOTAL) {
    const needed = TOTAL - existingInvCount;
    const ts = Date.now();
    const invDocs = Array.from({ length: needed }, (_, i) => {
      const propId = propertyIds[i % propertyIds.length];
      const ownerId = ownerIds[i % ownerIds.length];
      const leaseId = leaseIds[i % leaseIds.length];
      const unitName = getUnitName(i);
      const amount = randFloat(200, 2000);
      const paid = rand([0, randFloat(0, amount)]);
      const balance = parseFloat((amount - paid).toFixed(2));
      return {
        _id: new mongoose.Types.ObjectId(),
        invoiceId: `INV-HOA-${ts}-${i}`,
        type: rand(INV_TYPES),
        status: rand(INV_STS),
        lease_id: leaseId,
        propertyId: propId,
        propertyName: `PropCare Unit-${i + 1}`,
        hoaId: HOA_ID,
        unit: unitName,
        term: `${new Date().getFullYear()}-${String(randInt(1, 12)).padStart(2, '0')}`,
        tenants: [ownerId],
        invoiceItemDetails: [{
          invoiceItem: 'HOA Fee',
          description: 'Monthly HOA assessment',
          quantity: 1,
          rate: amount,
          amount,
        }],
        subAmount: amount,
        alreadyPaid: paid,
        processingAmount: 0,
        balanceDue: balance,
        isPartialPaymentAllowed: false,
        dueDate: future(randInt(-30, 60)),
        generatedFrom: 'manual',
        createdBy: BOARD_MEMBER_ID,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });
    await insertInBatches(db.collection('invoices'), invDocs, 'HOA Invoices');
  } else {
    console.log(`  ℹ️  Already have ${existingInvCount} invoices, skipping`);
  }

  // ── 5. HOA Expenses ───────────────────────────────────────────────────────
  console.log('\n📦 Step 5: Seeding HOA Expenses...');
  const existingExpCount = await db.collection('expenses').countDocuments({
    hoaId: HOA_ID,
    isDeleted: { $ne: true },
  });
  console.log(`  Existing HOA expenses: ${existingExpCount}`);

  if (existingExpCount < TOTAL) {
    const needed = TOTAL - existingExpCount;
    const expDocs = Array.from({ length: needed }, (_, i) => {
      const propId = propertyIds[i % propertyIds.length];
      const expDate = past(randInt(1, 180));
      const dueDate = future(randInt(1, 60));
      const amount = randFloat(100, 5000);
      return {
        _id: new mongoose.Types.ObjectId(),
        taxableEntity: 'PropCare HOA',
        bankAccount: 'HOA Primary Checking',
        property: propId,
        hoaId: HOA_ID,
        unit: getUnitName(i),
        payees: [{ name: `Vendor ${i + 1}`, contact: `vendor${i + 1}@example.com` }],
        expenseItems: [{
          _id: new mongoose.Types.ObjectId(),
          date: expDate,
          category: rand(EXP_CATS),
          description: `HOA expense item ${i + 1}`,
          amount,
        }],
        total: amount,
        expenseDate: expDate,
        dueDate,
        status: 'pending',
        createdBy: BOARD_MEMBER_ID,
        hoaBoardMemberId: BOARD_MEMBER_ID,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });
    await insertInBatches(db.collection('expenses'), expDocs, 'HOA Expenses');
  } else {
    console.log(`  ℹ️  Already have ${existingExpCount} expenses, skipping`);
  }

  // ── 6. HOA Maintenance Requests ───────────────────────────────────────────
  console.log('\n📦 Step 6: Seeding HOA Maintenance Requests...');
  const existingMaintCount = await db.collection('maintenancerequests').countDocuments({
    hoaId: HOA_ID,
    isDeleted: { $ne: true },
  });
  console.log(`  Existing HOA maintenance requests: ${existingMaintCount}`);

  if (existingMaintCount < TOTAL) {
    const needed = TOTAL - existingMaintCount;
    const ts = Date.now();
    const maintDocs = Array.from({ length: needed }, (_, i) => {
      const propId = propertyIds[i % propertyIds.length];
      const ownerId = ownerIds[i % ownerIds.length];
      const cat = rand(MAINT_CATS);
      return {
        _id: new mongoose.Types.ObjectId(),
        property_id: propId,
        hoaId: HOA_ID,
        units: getUnitName(i),
        title: `${cat} Issue ${i + 1}`,
        description: `HOA maintenance request for ${cat.toLowerCase()} issue. Unit ${i + 1}.`,
        category: cat,
        priority: rand(MAINT_PRI),
        isUrgent: Math.random() > 0.8,
        requestedBy: [ownerId],
        notifyTenant: true,
        request_date: past(randInt(1, 90)),
        status: rand(MAINT_STS),
        estimatedCost: randFloat(50, 2000),
        actualCost: 0,
        createdBy: BOARD_MEMBER_ID,
        ticketNumber: `MNT-HOA-${ts}-${i}`,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });
    await insertInBatches(db.collection('maintenancerequests'), maintDocs, 'HOA Maintenance');
  } else {
    console.log(`  ℹ️  Already have ${existingMaintCount} maintenance requests, skipping`);
  }

  // ── 7. HOA Vendor Invoices ────────────────────────────────────────────────
  console.log('\n📦 Step 7: Seeding HOA Vendor Invoices...');
  const existingVendorInvCount = await db.collection('vendorinvoices').countDocuments({
    hoaId: HOA_ID,
    isDeleted: { $ne: true },
  });
  console.log(`  Existing HOA vendor invoices: ${existingVendorInvCount}`);

  if (existingVendorInvCount < TOTAL) {
    const needed = TOTAL - existingVendorInvCount;
    const ts = Date.now();
    const vendorInvDocs = Array.from({ length: needed }, (_, i) => {
      const amount = randFloat(100, 5000);
      return {
        _id: new mongoose.Types.ObjectId(),
        invoiceNumber: `VINV-HOA-${ts}-${i}`,
        vendorId: BOARD_MEMBER_ID,
        assignedTo: BOARD_MEMBER_ID,
        hoaId: HOA_ID,
        title: `Vendor Service ${i + 1}`,
        description: `HOA vendor invoice for service ${i + 1}`,
        lineItems: [{
          description: `Service item ${i + 1}`,
          quantity: 1,
          rate: amount,
          amount,
        }],
        subAmount: amount,
        amountPaid: 0,
        balanceDue: amount,
        status: 'Pending',
        dueDate: future(randInt(7, 60)),
        createdBy: BOARD_MEMBER_ID,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });
    await insertInBatches(db.collection('vendorinvoices'), vendorInvDocs, 'HOA Vendor Invoices');
  } else {
    console.log(`  ℹ️  Already have ${existingVendorInvCount} vendor invoices, skipping`);
  }

  // ── 8. HOA Applications ───────────────────────────────────────────────────
  console.log('\n📦 Step 8: Seeding HOA Applications...');
  const existingAppCount = await db.collection('applications').countDocuments({
    landlord_id: BOARD_MEMBER_ID,
    isDeleted: { $ne: true },
  });
  console.log(`  Existing HOA applications: ${existingAppCount}`);

  if (existingAppCount < TOTAL) {
    const needed = TOTAL - existingAppCount;
    const ts = Date.now();
    const appDocs = Array.from({ length: needed }, (_, i) => {
      const propId = propertyIds[i % propertyIds.length];
      const ownerId = ownerIds[i % ownerIds.length];
      const leaseId = leaseIds[i % leaseIds.length];
      const idx = existingAppCount + i + 1;
      return {
        _id: new mongoose.Types.ObjectId(),
        property_id: propId,
        tenant_id: ownerId,
        lease_id: leaseId,
        landlord_id: BOARD_MEMBER_ID,
        createdBy: BOARD_MEMBER_ID,
        personalInformation: {
          firstName: `AppFirst${idx}`,
          lastName: `AppLast${idx}`,
          mobileNumber: `+1${randInt(2000000000, 9999999999)}`,
          email: `hoa.app.${ts}.${idx}@propmv-seed.com`,
          birthDate: past(randInt(7300, 18250)),
        },
        addressInformation: {
          addressLine1: `${randInt(100, 9999)} ${rand(STREETS)}`,
          city: rand(CITIES),
          state: rand(US_STATES),
          zip: `${randInt(10000, 99999)}`,
        },
        employmentHistory: [{
          employer: `Company ${idx}`,
          titleOrPosition: 'Engineer',
          startDate: past(randInt(365, 1825)),
          contact: {
            firstName: 'HR',
            lastName: 'Manager',
            email: `hr${idx}@company.com`,
            phone: `+1${randInt(2000000000, 9999999999)}`,
          },
        }],
        desiredMoveInDate: future(randInt(7, 60)),
        annualIncome: randInt(30000, 150000),
        status: rand(APP_STS),
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });
    await insertInBatches(db.collection('applications'), appDocs, 'HOA Applications');
  } else {
    console.log(`  ℹ️  Already have ${existingAppCount} applications, skipping`);
  }

  // ── Final counts ──────────────────────────────────────────────────────────
  console.log('\n📊 Final counts in PropMv DB for PropCare HOA:');
  const counts = {
    'HOA Owners': await db.collection('users').countDocuments({ companyId: COMPANY_ID, companyRoleId: HOA_OWNER_ROLE_ID, 'hoaInfo.hoaId': HOA_ID, isDeleted: { $ne: true } }),
    'HOA Properties': await db.collection('properties').countDocuments({ landlord_id: BOARD_MEMBER_ID, hoaId: HOA_ID, isDeleted: { $ne: true } }),
    'HOA Leases': await db.collection('leases').countDocuments({ property_id: { $in: propertyIds }, isDeleted: { $ne: true } }),
    'HOA Invoices': await db.collection('invoices').countDocuments({ hoaId: HOA_ID, isDeleted: { $ne: true } }),
    'HOA Expenses': await db.collection('expenses').countDocuments({ hoaId: HOA_ID, isDeleted: { $ne: true } }),
    'HOA Maintenance': await db.collection('maintenancerequests').countDocuments({ hoaId: HOA_ID, isDeleted: { $ne: true } }),
    'HOA Vendor Invoices': await db.collection('vendorinvoices').countDocuments({ hoaId: HOA_ID, isDeleted: { $ne: true } }),
    'HOA Applications': await db.collection('applications').countDocuments({ landlord_id: BOARD_MEMBER_ID, isDeleted: { $ne: true } }),
  };
  Object.entries(counts).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

  console.log('\n HOA bulk seed completed successfully!');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\n Seed failed:', err.message);
  console.error(err.stack);
  mongoose.disconnect();
  process.exit(1);
});
