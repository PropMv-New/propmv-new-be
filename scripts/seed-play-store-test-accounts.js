/**
 * Seed Google Play Store reviewer test accounts and minimal role-specific sample data.
 *
 * Run:
 *   node scripts/seed-play-store-test-accounts.js
 *
 * Required env (from .env.local):
 *   DB_URL or MONGODB_URI
 *   DB_NAME (default: PropMv)
 *
 * Optional:
 *   PLAY_STORE_TEST_PASSWORD (default: Admin#123456)
 *   PLAY_STORE_DEPOSIT_BANK_ACCOUNT_ID (fallback: first HOA property bank account in DB)
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });
else require('dotenv').config();

const DB_URL = process.env.DB_URL || process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'PropMv';
const PASSWORD = process.env.PLAY_STORE_TEST_PASSWORD || 'Admin#123456';

const ACCOUNT_SUITES = [
  {
    id: 'playstore',
    label: 'Play Store Review',
    hoaCommunityName: 'Play Store Review Community',
    landlordPropertyName: 'Play Store Rental Home',
    unitName: 'Unit-101',
    hoaStreet: '100 Review Lane',
    landlordStreet: '200 Review Avenue',
    accounts: [
      { key: 'board', email: 'board@propmv.com', role: 'HOA Board Member', firstName: 'Play Store', lastName: 'Board' },
      { key: 'owner', email: 'owner@propmv.com', role: 'HOA Owner', firstName: 'Play Store', lastName: 'Owner' },
      { key: 'landlord', email: 'landlord@propmv.com', role: 'Landlord', firstName: 'Play Store', lastName: 'Landlord' },
      { key: 'tenant', email: 'tenants@propmv.com', role: 'Tenant', firstName: 'Play Store', lastName: 'Tenant' },
      {
        key: 'propertyManager',
        email: 'propertymanager@propmv.com',
        role: 'Property Manager',
        firstName: 'Play Store',
        lastName: 'Manager',
      },
    ],
  },
  {
    id: 'test',
    label: 'Internal Test',
    hoaCommunityName: 'PropMv Test Community',
    landlordPropertyName: 'Test Rental Home',
    unitName: 'Unit-201',
    hoaStreet: '150 Test Lane',
    landlordStreet: '300 Test Avenue',
    accounts: [
      { key: 'board', email: 'test_board@propmv.com', role: 'HOA Board Member', firstName: 'Test', lastName: 'Board' },
      { key: 'owner', email: 'test_owner@propmv.com', role: 'HOA Owner', firstName: 'Test', lastName: 'Owner' },
      { key: 'landlord', email: 'test_landlord@propmv.com', role: 'Landlord', firstName: 'Test', lastName: 'Landlord' },
      { key: 'tenant', email: 'test_tenants@propmv.com', role: 'Tenant', firstName: 'Test', lastName: 'Tenant' },
      {
        key: 'propertyManager',
        email: 'test_propertymanager@propmv.com',
        role: 'Property Manager',
        firstName: 'Test',
        lastName: 'Manager',
      },
      { key: 'vendor', email: 'test_vendor@propmv.com', role: 'Vendor', firstName: 'Test', lastName: 'Vendor' },
    ],
  },
];

function logStep(message) {
  console.log(`\n▶ ${message}`);
}

async function resolveDepositBankAccountId(db) {
  if (process.env.PLAY_STORE_DEPOSIT_BANK_ACCOUNT_ID) {
    return new mongoose.Types.ObjectId(process.env.PLAY_STORE_DEPOSIT_BANK_ACCOUNT_ID);
  }
  const existing = await db.collection('properties').findOne(
    { depositBankAccountId: { $exists: true, $ne: null }, isDeleted: { $ne: true } },
    { projection: { depositBankAccountId: 1 } }
  );
  if (existing?.depositBankAccountId) {
    return existing.depositBankAccountId;
  }
  return new mongoose.Types.ObjectId();
}

async function upsertReviewerUser({
  User,
  company,
  role,
  spec,
  hashedPassword,
  extraFields = {},
  assignPropMvCompany = true,
}) {
  const email = spec.email.toLowerCase();
  let user = await User.findOne({ email, isDeleted: { $ne: true } });
  const baseFields = {
    email,
    password: hashedPassword,
    firstName: spec.firstName,
    lastName: spec.lastName,
    phone: '+12025550100',
    status: 'Active',
    portalOnboardingStatus: 'active',
    emailVerifiedAt: new Date(),
    lockAccount: false,
    failedLoginAttempts: 0,
    lockUntil: null,
    mfaOtp: undefined,
    mfaOtpExpiresAt: undefined,
    mfaOtpAction: undefined,
    ...extraFields,
  };

  if (!user) {
    user = await User.create({
      ...baseFields,
      ...(assignPropMvCompany
        ? { companyId: company._id, companyRoleId: role._id }
        : {}),
    });
    console.log(`  Created user: ${email}`);
    return user;
  }

  Object.assign(user, baseFields);
  if (assignPropMvCompany) {
    user.companyId = company._id;
    user.companyRoleId = role._id;
  }
  await user.save();
  console.log(`  Updated user: ${email}`);
  return user;
}

async function upsertVendorUser({ User, spec, hashedPassword, boardUser, hoaId }) {
  const { assignVendorRoleFields } = require('../src/common/helpers/hoaVendorRole');
  const email = spec.email.toLowerCase();
  let user = await User.findOne({ email, isDeleted: { $ne: true } });
  const baseFields = {
    email,
    password: hashedPassword,
    firstName: spec.firstName,
    lastName: spec.lastName,
    phone: '+12025550103',
    status: 'Active',
    portalOnboardingStatus: 'active',
    emailVerifiedAt: new Date(),
    lockAccount: false,
    failedLoginAttempts: 0,
    lockUntil: null,
    mfaOtp: undefined,
    mfaOtpExpiresAt: undefined,
    mfaOtpAction: undefined,
    sendInvite: false,
    associatedHoaIds: hoaId ? [hoaId] : [],
    createdBy: boardUser?._id,
    hoaBoardMemberId: boardUser?._id,
  };

  if (!user) {
    await assignVendorRoleFields(baseFields);
    user = await User.create(baseFields);
    console.log(`  Created user: ${email}`);
    return user;
  }

  Object.assign(user, baseFields);
  await assignVendorRoleFields(user);
  await user.save();
  console.log(`  Updated user: ${email}`);
  return user;
}

async function ensureVendorSampleData({ vendorUser, boardUser, hoaId }) {
  if (!vendorUser || !hoaId) return;

  const hoaIdStr = String(hoaId);
  const associated = (vendorUser.associatedHoaIds || []).map(String);
  let changed = false;

  if (!associated.includes(hoaIdStr)) {
    vendorUser.associatedHoaIds = [...(vendorUser.associatedHoaIds || []), hoaId];
    changed = true;
  }
  if (boardUser && String(vendorUser.createdBy || '') !== String(boardUser._id)) {
    vendorUser.createdBy = boardUser._id;
    vendorUser.hoaBoardMemberId = boardUser._id;
    changed = true;
  }
  vendorUser.sendInvite = false;
  vendorUser.portalOnboardingStatus = 'active';
  vendorUser.status = 'Active';

  if (changed || vendorUser.isModified()) {
    await vendorUser.save();
    console.log('  Linked vendor to HOA community');
  } else {
    console.log('  Verified vendor HOA association');
  }
}

async function ensureHoaCommunity({
  HOA,
  HOAMembership,
  boardUser,
  ownerUser,
  depositBankAccountId,
  db,
  hoaCommunityName,
  unitName,
  hoaStreet,
}) {
  let hoa = await HOA.findOne({
    name: hoaCommunityName,
    createdBy: boardUser._id,
    isDeleted: { $ne: true },
  });

  if (!hoa) {
    hoa = await HOA.create({
      name: hoaCommunityName,
      createdBy: boardUser._id,
      numberOfUnits: 12,
      associationType: 'Condominium',
      propertyAddress: `${hoaStreet}, Austin, TX 78701`,
    });
    console.log(`  Created HOA: ${hoa.name}`);
  }

  boardUser.hoaInfo = {
    hoaId: hoa._id,
    communityName: hoaCommunityName,
    numberOfUnits: 12,
    associationType: 'Condominium',
    propertyAddress: `${hoaStreet}, Austin, TX 78701`,
  };
  await boardUser.save();

  const boardMembership = await HOAMembership.findOne({ hoaId: hoa._id, email: boardUser.email });
  if (!boardMembership) {
    await HOAMembership.create({
      hoaId: hoa._id,
      userId: boardUser._id,
      email: boardUser.email,
      role: 'admin',
      status: 'active',
      invitedBy: boardUser._id,
    });
    console.log('  Created HOA board membership');
  } else if (boardMembership.status !== 'active' || !boardMembership.userId) {
    boardMembership.userId = boardUser._id;
    boardMembership.status = 'active';
    boardMembership.role = 'admin';
    await boardMembership.save();
    console.log('  Reactivated HOA board membership');
  }

  ownerUser.hoaInfo = {
    hoaId: hoa._id,
    communityName: hoaCommunityName,
    numberOfUnits: 1,
    associationType: 'Condominium',
  };
  ownerUser.createdBy = boardUser._id;
  await ownerUser.save();

  const HOAProperty = require('../src/portals/hoa-board/modules/property/model/property.model');
  let unit = await HOAProperty.findOne({
    hoaId: hoa._id,
    landlord_id: boardUser._id,
    'unitDetails.unitName': unitName,
    isDeleted: { $ne: true },
  });

  const unitId = unit?.unitDetails?.[0]?._id || new mongoose.Types.ObjectId();
  if (!unit) {
    unit = await HOAProperty.create({
      landlord_id: boardUser._id,
      hoaId: hoa._id,
      name: hoaCommunityName,
      propertyType: 'Condo',
      ownershipType: 'Owned',
      ownerName: `${ownerUser.firstName} ${ownerUser.lastName}`,
      ownerEmail: ownerUser.email,
      ownerPhone: '+12025550101',
      ownerType: 'Individual',
      sourcePortal: 'hoa',
      address: {
        street: hoaStreet,
        city: 'Austin',
        state: 'TX',
        zip: '78701',
        country: 'USA',
      },
      unitDetails: [{
        _id: unitId,
        unitName,
        unitType: 'Residential',
        squareFeet: 1200,
        bedRooms: 2,
        bathRoom: 2,
        amenities: ['Parking'],
      }],
      depositBankAccountId,
      depositBankAccountName: `${hoaCommunityName} Checking`,
      associatedOwnerIds: [ownerUser._id],
      ownershipRecords: [{
        ownerId: ownerUser._id,
        startDate: new Date(),
        endDate: null,
        financialHandling: 'FRESH',
      }],
      monthlyRecurringFee: 350,
      paymentTerm: 12,
      startingBalance: 0,
      propertySettings: {
        bankAccount: {
          entityType: 'individual',
          firstName: boardUser.firstName,
          lastName: boardUser.lastName,
          email: boardUser.email,
          dob: new Date('1985-01-15'),
          ssn: '123456789',
          address: {
            street: hoaStreet,
            city: 'Austin',
            state: 'TX',
            zip: '78701',
          },
        },
      },
      isDeleted: false,
      isArchieved: false,
    });
    console.log(`  Created HOA owner unit: ${unitName}`);
  } else {
    const ownerIdStr = String(ownerUser._id);
    const associated = (unit.associatedOwnerIds || []).map(String);
    if (!associated.includes(ownerIdStr)) {
      unit.associatedOwnerIds = [...(unit.associatedOwnerIds || []), ownerUser._id];
      unit.ownershipRecords = [
        ...(unit.ownershipRecords || []),
        {
          ownerId: ownerUser._id,
          startDate: new Date(),
          endDate: null,
          financialHandling: 'FRESH',
        },
      ];
      await unit.save();
      console.log(`  Linked HOA owner to ${unitName}`);
    }
  }

  const existingInvoice = await db.collection('invoices').findOne({
    hoaId: hoa._id,
    unit: unitName,
    tenants: ownerUser._id,
    isDeleted: { $ne: true },
  });
  if (!existingInvoice) {
    const amount = 350;
    await db.collection('invoices').insertOne({
      invoiceId: `INV-${hoaCommunityName.replace(/\s+/g, '-').toUpperCase()}-${Date.now()}`,
      type: 'HOA Fee',
      status: 'Pending',
      propertyId: unit._id,
      propertyName: hoaCommunityName,
      hoaId: hoa._id,
      unit: unitName,
      term: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`,
      tenants: [ownerUser._id],
      invoiceItemDetails: [{
        invoiceItem: 'HOA Fee',
        description: `Monthly HOA assessment for ${hoaCommunityName}`,
        quantity: 1,
        rate: amount,
        amount,
      }],
      subAmount: amount,
      alreadyPaid: 0,
      processingAmount: 0,
      balanceDue: amount,
      isPartialPaymentAllowed: false,
      dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      generatedFrom: 'manual',
      createdBy: boardUser._id,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log('  Created sample HOA invoice for owner');
  }

  return { hoa, unit };
}

async function ensureLandlordSampleData({
  LandlordProperty,
  Lease,
  landlordUser,
  tenantUser,
  landlordPropertyName,
  landlordStreet,
}) {
  let property = await LandlordProperty.findOne({
    createdBy: landlordUser._id,
    name: landlordPropertyName,
    isDeleted: { $ne: true },
  });

  if (!property) {
    property = await LandlordProperty.create({
      createdBy: landlordUser._id,
      name: landlordPropertyName,
      propertyType: 'Single Family',
      ownershipType: 'Owned',
      ownerName: `${landlordUser.firstName} ${landlordUser.lastName}`,
      ownerEmail: landlordUser.email,
      ownerPhone: '+12025550102',
      ownerType: 'Individual',
      sourcePortal: 'landlord',
      address: {
        street: landlordStreet,
        city: 'Austin',
        state: 'TX',
        zip: '78702',
        country: 'USA',
      },
      unitDetails: [{
        unitName: 'Main Unit',
        unitType: 'Residential',
        squareFeet: 1500,
        bedRooms: 3,
        bathRoom: 2,
        amenities: ['Garage'],
      }],
      isDeleted: false,
    });
    console.log('  Created landlord property');
  }

  tenantUser.createdBy = landlordUser._id;
  tenantUser.landlordId = landlordUser._id;
  await tenantUser.save();

  let lease = await Lease.findOne({
    property_id: property._id,
    isDeleted: { $ne: true },
    'rentAndDepositDestribution.split.tenantId': String(tenantUser._id),
  });

  if (!lease) {
    const rentAmount = 1800;
    const depositAmount = 1800;
    const startDate = new Date();
    const endDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    lease = await Lease.create({
      property_id: property._id,
      unitName: 'Main Unit',
      leaseTerm: '12 months',
      lease_type: 'FixedTerm',
      start_date: startDate,
      end_date: endDate,
      switchMonthToMonth: false,
      auto_renew: false,
      rentDetails: {
        frequency: 'monthly',
        amount: rentAmount,
        dueOne: '1',
        firstRentalInvoiceDue: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      depositDetails: {
        amount: depositAmount,
        due: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        isDepositAlreadyCollected: false,
      },
      rentAndDepositDestribution: {
        isAllTenantsEquallyResponsible: true,
        isPartialPaymentAllowed: false,
        rentDistributionType: 'Equal',
        securityDepositDestributionType: 'Equal',
        split: [{
          tenantId: String(tenantUser._id),
          rentAmount,
          rentPercentage: 100,
          depositAmount,
          depositPercentage: 100,
          screening: [],
          inviteAcknowledged: true,
          inviteAcknowledgedAt: new Date(),
        }],
      },
      status: 'Submitted',
      isDeleted: false,
    });
    console.log('  Created tenant lease');
  }

  return { property, lease };
}

async function ensurePropertyManagerCompany({ User, pmUser }) {
  const {
    createCompanyForPropertyManager,
    assignCompanyRoleToUser,
    ensurePropertyManagerCompany,
  } = require('../src/shared/modules/company/helpers/companyCreation.helper');

  if (!pmUser.companyId || !pmUser.companyRoleId) {
    const company = await createCompanyForPropertyManager({
      firstName: pmUser.firstName,
      lastName: pmUser.lastName,
      email: pmUser.email,
      _id: pmUser._id,
    });
    await assignCompanyRoleToUser(pmUser, company);
    console.log('  Created property manager company');
  } else {
    await ensurePropertyManagerCompany(pmUser);
    console.log('  Verified property manager company');
  }
}

async function run() {
  if (!DB_URL) {
    console.error('DB_URL or MONGODB_URI is required');
    process.exit(1);
  }

  await mongoose.connect(DB_URL, { dbName: DB_NAME });
  console.log(`Connected to MongoDB (${DB_NAME})`);

  const db = mongoose.connection.db;
  const User = require('../src/shared/modules/users/models/user.model');
  const Company = require('../src/shared/modules/company/models/company.model');
  const HOA = require('../src/portals/hoa-board/modules/hoa/model/hoa.model');
  const HOAMembership = require('../src/portals/hoa-board/modules/hoa/model/hoaMembership.model');
  const LandlordProperty = require('../src/portals/landlord/modules/property/model/property.model');
  const Lease = require('../src/portals/landlord/modules/leasing/model/lease.model');

  const company = await Company.findOne({ name: 'PropMv', isDeleted: { $ne: true } });
  if (!company) {
    console.error('PropMv company not found. Run create-propmv-company-with-roles.js first.');
    process.exit(1);
  }

  const roleByName = Object.fromEntries(
    company.roles.filter((role) => role.isActive).map((role) => [role.name, role])
  );
  for (const suite of ACCOUNT_SUITES) {
    for (const spec of suite.accounts) {
      if (!roleByName[spec.role]) {
        console.error(`Missing active role: ${spec.role}`);
        process.exit(1);
      }
    }
  }

  const hashedPassword = await bcrypt.hash(PASSWORD, 10);
  const depositBankAccountId = await resolveDepositBankAccountId(db);

  logStep('Creating/updating reviewer and test accounts');
  const suiteUsers = {};
  for (const suite of ACCOUNT_SUITES) {
    console.log(`\n  Suite: ${suite.label}`);
    suiteUsers[suite.id] = {};
    const boardSpec = suite.accounts.find((spec) => spec.key === 'board');
    let suiteHoaId = null;
    if (boardSpec) {
      const HOA = require('../src/portals/hoa-board/modules/hoa/model/hoa.model');
      const existingHoa = await HOA.findOne({
        name: suite.hoaCommunityName,
        isDeleted: { $ne: true },
      }).select('_id createdBy').lean();
      if (existingHoa) suiteHoaId = existingHoa._id;
    }

    for (const spec of suite.accounts) {
      if (spec.role === 'Vendor') {
        const boardUser = suiteUsers[suite.id].board
          || (boardSpec && await User.findOne({ email: boardSpec.email.toLowerCase(), isDeleted: { $ne: true } }));
        suiteUsers[suite.id][spec.key] = await upsertVendorUser({
          User,
          spec,
          hashedPassword,
          boardUser,
          hoaId: suiteHoaId,
        });
        continue;
      }

      suiteUsers[suite.id][spec.key] = await upsertReviewerUser({
        User,
        company,
        role: roleByName[spec.role],
        spec,
        hashedPassword,
        assignPropMvCompany: spec.role !== 'Property Manager',
      });
    }
  }

  for (const suite of ACCOUNT_SUITES) {
    const users = suiteUsers[suite.id];
    logStep(`Provisioning ${suite.label} HOA board + owner sample data`);
    const { hoa } = await ensureHoaCommunity({
      HOA,
      HOAMembership,
      boardUser: users.board,
      ownerUser: users.owner,
      depositBankAccountId,
      db,
      hoaCommunityName: suite.hoaCommunityName,
      unitName: suite.unitName,
      hoaStreet: suite.hoaStreet,
    });

    if (users.vendor) {
      logStep(`Provisioning ${suite.label} vendor sample data`);
      await ensureVendorSampleData({
        vendorUser: users.vendor,
        boardUser: users.board,
        hoaId: hoa?._id,
      });
    }

    logStep(`Provisioning ${suite.label} landlord + tenant sample data`);
    await ensureLandlordSampleData({
      LandlordProperty,
      Lease,
      landlordUser: users.landlord,
      tenantUser: users.tenant,
      landlordPropertyName: suite.landlordPropertyName,
      landlordStreet: suite.landlordStreet,
    });

    logStep(`Provisioning ${suite.label} property manager company`);
    await ensurePropertyManagerCompany({ User, pmUser: users.propertyManager });
  }

  console.log('\n✅ Play Store reviewer and internal test accounts are ready.');
  console.log('\nCredentials (password for all accounts):');
  console.log(`  ${PASSWORD}`);
  console.log('\nAccounts:');
  for (const suite of ACCOUNT_SUITES) {
    console.log(`\n  ${suite.label}:`);
    for (const spec of suite.accounts) {
      console.log(`    - ${spec.role}: ${spec.email}`);
    }
  }
  console.log('\nEnable backend reviewer OTP with:');
  console.log('  PLAY_STORE_TEST_AUTH_ENABLED=true');
  console.log('  PLAY_STORE_TEST_OTP=000000');

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error('Seed failed:', err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
