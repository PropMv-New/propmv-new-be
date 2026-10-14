/**
 * Seed dedicated QA accounts for HOA board / owner / vendor flows.
 *
 * Run:
 *   node scripts/seed-qa-accounts.js
 *   npm run seed:qa-accounts
 *
 * Required env (from .env.local):
 *   DB_URL or MONGODB_URI
 *   DB_NAME (default: PropMv)
 *
 * Optional:
 *   QA_TEST_PASSWORD (default: Admin#123456)
 *
 * Accounts created/updated:
 *   qa.board@propmv.com              - HOA Board Member (+ QA HOA community)
 *   qa.board2@propmv.com             - HOA Board Member (same QA HOA community)
 *   qa2.board@propmv.com             - HOA Board Member (+ QA2 TEST Community, separate HOA)
 *   qa2.owner@propmv.com             - HOA Owner (sole owner of QA2-Unit-Single, in QA2 TEST Community)
 *   qa.owner.single@propmv.com       - HOA Owner (sole owner of Unit-Single)
 *   qa.owner.co1@propmv.com          - HOA Owner (co-owner of Unit-CoOwned)
 *   qa.owner.co2@propmv.com          - HOA Owner (co-owner of Unit-CoOwned)
 *   qa.owner.co3@propmv.com          - HOA Owner (co-owner of Unit-CoOwned)
 *   qa.owner.unassigned@propmv.com   - HOA Owner (no unit assignment)
 *   qa.vendor@propmv.com             - Vendor (linked to QA HOA)
 *   qa.tenant@propmv.com             - Tenant (lease on QA Rental Home)
 *
 * OTP 000000 requires PLAY_STORE_TEST_AUTH_ENABLED=true and these emails in
 * PLAY_STORE_TEST_ACCOUNTS (see playStoreTestAuth.helper.js defaults).
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
const PASSWORD = process.env.QA_TEST_PASSWORD || 'Admin#123456';

const QA_HOA_NAME = 'QA Test Community';
const QA_HOA_STREET = '400 QA Lane';
const QA2_HOA_NAME = 'QA2 TEST Community';
const QA2_HOA_STREET = '401 QA2 Lane';
const SINGLE_UNIT_NAME = 'Unit-Single';
const CO_UNIT_NAME = 'Unit-CoOwned';
const QA2_UNIT_NAME = 'QA2-Unit-Single';
const QA_LANDLORD_PROPERTY_NAME = 'QA Rental Home';
const QA_LANDLORD_EMAIL = 'landlord@propmv.com';

const ACCOUNTS = [
  { key: 'board', email: 'qa.board@propmv.com', role: 'HOA Board Member', firstName: 'QA', lastName: 'Board' },
  { key: 'board2', email: 'qa.board2@propmv.com', role: 'HOA Board Member', firstName: 'QA', lastName: 'Board2' },
  { key: 'board3', email: 'qa2.board@propmv.com', role: 'HOA Board Member', firstName: 'QA2', lastName: 'Board' },
  { key: 'qa2Owner', email: 'qa2.owner@propmv.com', role: 'HOA Owner', firstName: 'QA2', lastName: 'Owner' },
  { key: 'ownerSingle', email: 'qa.owner.single@propmv.com', role: 'HOA Owner', firstName: 'QA', lastName: 'OwnerSingle' },
  { key: 'ownerCo1', email: 'qa.owner.co1@propmv.com', role: 'HOA Owner', firstName: 'QA', lastName: 'CoOwner1' },
  { key: 'ownerCo2', email: 'qa.owner.co2@propmv.com', role: 'HOA Owner', firstName: 'QA', lastName: 'CoOwner2' },
  { key: 'ownerCo3', email: 'qa.owner.co3@propmv.com', role: 'HOA Owner', firstName: 'QA', lastName: 'CoOwner3' },
  { key: 'ownerUnassigned', email: 'qa.owner.unassigned@propmv.com', role: 'HOA Owner', firstName: 'QA', lastName: 'Unassigned' },
  { key: 'vendor', email: 'qa.vendor@propmv.com', role: 'Vendor', firstName: 'QA', lastName: 'Vendor' },
  { key: 'tenant', email: 'qa.tenant@propmv.com', role: 'Tenant', firstName: 'QA', lastName: 'Tenant' },
  { key: 'landlord', email: 'qa.landlord@propmv.com', role: 'Landlord', firstName: 'QA', lastName: 'Landlord' },
];

function logStep(message) {
  console.log(`\n▶ ${message}`);
}

async function resolveDepositBankAccountId(db) {
  if (process.env.QA_DEPOSIT_BANK_ACCOUNT_ID) {
    return new mongoose.Types.ObjectId(process.env.QA_DEPOSIT_BANK_ACCOUNT_ID);
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

async function upsertUser({ User, company, role, spec, hashedPassword }) {
  const email = spec.email.toLowerCase();
  let user = await User.findOne({ email, isDeleted: { $ne: true } });
  const baseFields = {
    email,
    password: hashedPassword,
    firstName: spec.firstName,
    lastName: spec.lastName,
    phone: '+12025550199',
    status: 'Active',
    portalOnboardingStatus: 'active',
    emailVerifiedAt: new Date(),
    lockAccount: false,
    failedLoginAttempts: 0,
    lockUntil: null,
    mfaOtp: undefined,
    mfaOtpExpiresAt: undefined,
    mfaOtpAction: undefined,
    companyId: company._id,
    companyRoleId: role._id,
  };

  if (!user) {
    user = await User.create(baseFields);
    console.log(`  Created user: ${email} (${spec.role})`);
    return user;
  }

  Object.assign(user, baseFields);
  await user.save();
  console.log(`  Updated user: ${email} (${spec.role})`);
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
    phone: '+12025550198',
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
    console.log(`  Created user: ${email} (Vendor)`);
    return user;
  }

  Object.assign(user, baseFields);
  await assignVendorRoleFields(user);
  await user.save();
  console.log(`  Updated user: ${email} (Vendor)`);
  return user;
}

async function ensureBoardHoa({
  HOA,
  HOAMembership,
  boardUser,
  hoaName = QA_HOA_NAME,
  hoaStreet = QA_HOA_STREET,
}) {
  let hoa = await HOA.findOne({
    name: hoaName,
    isDeleted: { $ne: true },
  });

  if (!hoa) {
    hoa = await HOA.create({
      name: hoaName,
      createdBy: boardUser._id,
      numberOfUnits: 20,
      associationType: 'Condominium',
      propertyAddress: `${hoaStreet}, Austin, TX 78701`,
    });
    console.log(`  Created HOA: ${hoa.name}`);
  } else if (String(hoa.createdBy) !== String(boardUser._id)) {
    hoa.createdBy = boardUser._id;
    await hoa.save();
    console.log(`  Reassigned HOA creator to QA board: ${hoa.name}`);
  } else {
    console.log(`  Reused HOA: ${hoa.name}`);
  }

  boardUser.hoaInfo = {
    hoaId: hoa._id,
    communityName: hoaName,
    numberOfUnits: 20,
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
  } else {
    console.log('  Verified HOA board membership');
  }

  return hoa;
}

async function ensureAdditionalBoardMember({ HOAMembership, memberUser, hoa, invitedBy }) {
  memberUser.hoaInfo = {
    hoaId: hoa._id,
    communityName: QA_HOA_NAME,
    numberOfUnits: 20,
    associationType: 'Condominium',
    propertyAddress: `${QA_HOA_STREET}, Austin, TX 78701`,
  };
  await memberUser.save();

  const membership = await HOAMembership.findOne({ hoaId: hoa._id, email: memberUser.email });
  if (!membership) {
    await HOAMembership.create({
      hoaId: hoa._id,
      userId: memberUser._id,
      email: memberUser.email,
      role: 'admin',
      status: 'active',
      invitedBy: invitedBy?._id,
    });
    console.log('  Created HOA board membership for qa.board2');
  } else if (membership.status !== 'active' || !membership.userId) {
    membership.userId = memberUser._id;
    membership.status = 'active';
    membership.role = 'admin';
    await membership.save();
    console.log('  Reactivated HOA board membership for qa.board2');
  } else {
    console.log('  Verified HOA board membership for qa.board2');
  }
}

async function attachOwnerToHoa(ownerUser, boardUser, hoa, hoaName = QA_HOA_NAME) {
  ownerUser.hoaInfo = {
    hoaId: hoa._id,
    communityName: hoaName,
    numberOfUnits: 1,
    associationType: 'Condominium',
  };
  ownerUser.createdBy = boardUser._id;
  await ownerUser.save();
}

function buildOwnershipRecords(ownerUsers) {
  return ownerUsers.map((owner) => ({
    ownerId: owner._id,
    startDate: new Date(),
    endDate: null,
    financialHandling: 'FRESH',
  }));
}

/**
 * Mirrors the real Add-Owner API flow's write onto the owner's own `propertyIds` — this
 * script only ever set the Property doc's own `associatedOwnerIds`, never the reverse link,
 * so owners it created always failed the Owners list's Property/Unit filter
 * (`resolveOwnerPropertyScopeIds` matches against `User.propertyIds`, confirmed empty for
 * these fixtures live on staging — see docs/qa/test-data/OWN-WF-003.md).
 */
async function ensurePropertyIdsLinked({ User, ownerUsers, propertyId }) {
  const ownerIds = ownerUsers.map((u) => u._id);
  await User.updateMany(
    { _id: { $in: ownerIds } },
    { $addToSet: { propertyIds: propertyId } }
  );
}

async function ensureUnit({
  HOAProperty,
  User,
  boardUser,
  hoa,
  unitName,
  ownerUsers,
  depositBankAccountId,
  ownerLabel,
  hoaName = QA_HOA_NAME,
  hoaStreet = QA_HOA_STREET,
  propertyName,
}) {
  const resolvedPropertyName = propertyName || hoaName;
  const primary = ownerUsers[0] || null;
  let unit = await HOAProperty.findOne({
    hoaId: hoa._id,
    'unitDetails.unitName': unitName,
    isDeleted: { $ne: true },
  });

  const ownerIds = ownerUsers.map((u) => u._id);
  const unitId = unit?.unitDetails?.[0]?._id || new mongoose.Types.ObjectId();

  if (!unit) {
    unit = await HOAProperty.create({
      landlord_id: boardUser._id,
      hoaId: hoa._id,
      name: resolvedPropertyName,
      propertyType: 'Condo',
      ownershipType: 'Owned',
      ownerName: primary ? `${primary.firstName} ${primary.lastName}` : ownerLabel,
      ownerEmail: primary?.email || undefined,
      ownerPhone: '+12025550197',
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
        squareFeet: 1100,
        bedRooms: 2,
        bathRoom: 2,
        amenities: ['Parking'],
      }],
      depositBankAccountId,
      depositBankAccountName: `${hoaName} Checking`,
      associatedOwnerIds: ownerIds,
      ownershipRecords: buildOwnershipRecords(ownerUsers),
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
            street: QA_HOA_STREET,
            city: 'Austin',
            state: 'TX',
            zip: '78701',
          },
        },
      },
      isDeleted: false,
      isArchieved: false,
    });
    await ensurePropertyIdsLinked({ User, ownerUsers, propertyId: unit._id });
    console.log(`  Created unit ${unitName} with ${ownerIds.length} owner(s)`);
    return unit;
  }

  unit.name = resolvedPropertyName;
  unit.associatedOwnerIds = ownerIds;
  unit.ownershipRecords = buildOwnershipRecords(ownerUsers);
  if (primary) {
    unit.ownerName = `${primary.firstName} ${primary.lastName}`;
    unit.ownerEmail = primary.email;
  }
  await unit.save();
  await ensurePropertyIdsLinked({ User, ownerUsers, propertyId: unit._id });
  console.log(`  Synced unit ${unitName} owners (${ownerIds.length})`);
  return unit;
}

async function ensureVendorLinked({ vendorUser, boardUser, hoaId }) {
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
    console.log('  Linked vendor to QA HOA');
  } else {
    console.log('  Verified vendor HOA association');
  }
}

async function ensureQaTenantSampleData({ User, company, roleByName, hashedPassword, tenantUser }) {
  const LandlordProperty = require('../src/portals/landlord/modules/property/model/property.model');
  const Lease = require('../src/portals/landlord/modules/leasing/model/lease.model');

  let landlordUser = await User.findOne({ email: QA_LANDLORD_EMAIL, isDeleted: { $ne: true } });
  if (!landlordUser) {
    const landlordRole = roleByName.Landlord;
    if (!landlordRole) {
      throw new Error('Landlord role not found; cannot provision QA tenant sample data');
    }
    landlordUser = await upsertUser({
      User,
      company,
      role: landlordRole,
      spec: {
        email: QA_LANDLORD_EMAIL,
        role: 'Landlord',
        firstName: 'Play Store',
        lastName: 'Landlord',
      },
      hashedPassword,
    });
    console.log(`  Ensured landlord host account: ${QA_LANDLORD_EMAIL}`);
  }

  let property = await LandlordProperty.findOne({
    createdBy: landlordUser._id,
    name: QA_LANDLORD_PROPERTY_NAME,
    isDeleted: { $ne: true },
  });

  if (!property) {
    property = await LandlordProperty.create({
      createdBy: landlordUser._id,
      name: QA_LANDLORD_PROPERTY_NAME,
      propertyType: 'Single Family',
      ownershipType: 'Owned',
      ownerName: `${landlordUser.firstName || 'QA'} ${landlordUser.lastName || 'Landlord'}`,
      ownerEmail: landlordUser.email,
      ownerPhone: '+12025550102',
      ownerType: 'Individual',
      sourcePortal: 'landlord',
      address: {
        street: '500 QA Avenue',
        city: 'Austin',
        state: 'TX',
        zip: '78703',
        country: 'USA',
      },
      unitDetails: [{
        unitName: 'Main Unit',
        unitType: 'Residential',
        squareFeet: 1400,
        bedRooms: 3,
        bathRoom: 2,
        amenities: ['Garage'],
      }],
      isDeleted: false,
    });
    console.log(`  Created landlord property: ${QA_LANDLORD_PROPERTY_NAME}`);
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
    const rentAmount = 1650;
    const depositAmount = 1650;
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
        rentDistributionType: 'equal',
        securityDepositDestributionType: 'equal',
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
    console.log('  Created QA tenant lease');
  } else {
    console.log('  Verified QA tenant lease');
  }

  return { landlordUser, property, lease };
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
  const HOAProperty = require('../src/portals/hoa-board/modules/property/model/property.model');

  const company = await Company.findOne({ name: 'PropMv', isDeleted: { $ne: true } });
  if (!company) {
    console.error('PropMv company not found. Run create-propmv-company-with-roles.js first.');
    process.exit(1);
  }

  const roleByName = Object.fromEntries(
    company.roles.filter((role) => role.isActive).map((role) => [role.name, role])
  );
  for (const spec of ACCOUNTS) {
    if (spec.role === 'Vendor') continue;
    if (!roleByName[spec.role]) {
      console.error(`Missing active role: ${spec.role}`);
      process.exit(1);
    }
  }

  const hashedPassword = await bcrypt.hash(PASSWORD, 10);
  const depositBankAccountId = await resolveDepositBankAccountId(db);
  const users = {};

  logStep('Creating/updating QA users');
  for (const spec of ACCOUNTS) {
    if (spec.role === 'Vendor') continue;
    users[spec.key] = await upsertUser({
      User,
      company,
      role: roleByName[spec.role],
      spec,
      hashedPassword,
    });
  }

  logStep('Provisioning QA HOA community for board');
  const hoa = await ensureBoardHoa({
    HOA,
    HOAMembership,
    boardUser: users.board,
  });

  logStep('Attaching second board member to QA HOA');
  await ensureAdditionalBoardMember({
    HOAMembership,
    memberUser: users.board2,
    hoa,
    invitedBy: users.board,
  });

  logStep('Provisioning QA2 HOA community for second board account');
  const qa2Hoa = await ensureBoardHoa({
    HOA,
    HOAMembership,
    boardUser: users.board3,
    hoaName: QA2_HOA_NAME,
    hoaStreet: QA2_HOA_STREET,
  });

  logStep(`Attaching qa2.owner to ${QA2_HOA_NAME}`);
  await attachOwnerToHoa(users.qa2Owner, users.board3, qa2Hoa, QA2_HOA_NAME);
  console.log(`  Linked ${users.qa2Owner.email} to ${QA2_HOA_NAME}`);

  logStep(`Provisioning QA2 single-owner unit (${QA2_UNIT_NAME})`);
  await ensureUnit({
    HOAProperty,
    User,
    boardUser: users.board3,
    hoa: qa2Hoa,
    unitName: QA2_UNIT_NAME,
    ownerUsers: [users.qa2Owner],
    depositBankAccountId,
    ownerLabel: 'QA2 Owner',
    hoaName: QA2_HOA_NAME,
    hoaStreet: QA2_HOA_STREET,
    propertyName: 'QA2 Property 1',
  });

  logStep('Attaching owners to QA HOA');
  for (const key of ['ownerSingle', 'ownerCo1', 'ownerCo2', 'ownerCo3', 'ownerUnassigned']) {
    await attachOwnerToHoa(users[key], users.board, hoa);
    console.log(`  Linked ${users[key].email} to ${QA_HOA_NAME}`);
  }

  logStep(`Provisioning single-owner unit (${SINGLE_UNIT_NAME})`);
  await ensureUnit({
    HOAProperty,
    User,
    boardUser: users.board,
    hoa,
    unitName: SINGLE_UNIT_NAME,
    ownerUsers: [users.ownerSingle],
    depositBankAccountId,
    ownerLabel: 'QA Owner Single',
    propertyName: 'QA Property 1',
  });

  logStep(`Provisioning co-owned unit (${CO_UNIT_NAME})`);
  await ensureUnit({
    HOAProperty,
    User,
    boardUser: users.board,
    hoa,
    unitName: CO_UNIT_NAME,
    ownerUsers: [users.ownerCo1, users.ownerCo2, users.ownerCo3],
    depositBankAccountId,
    ownerLabel: 'QA Co-Owners',
    propertyName: 'QA Property 2',
  });

  logStep('Ensuring unassigned owner has no unit association');
  const unassignedId = String(users.ownerUnassigned._id);
  const unitsWithUnassigned = await HOAProperty.find({
    hoaId: hoa._id,
    associatedOwnerIds: users.ownerUnassigned._id,
    isDeleted: { $ne: true },
  });
  for (const unit of unitsWithUnassigned) {
    unit.associatedOwnerIds = (unit.associatedOwnerIds || []).filter((id) => String(id) !== unassignedId);
    unit.ownershipRecords = (unit.ownershipRecords || []).filter(
      (rec) => String(rec.ownerId) !== unassignedId
    );
    await unit.save();
    console.log(`  Removed unassigned owner from ${unit.unitDetails?.[0]?.unitName || unit._id}`);
  }
  if (!unitsWithUnassigned.length) {
    console.log('  Confirmed: qa.owner.unassigned has no unit');
  }

  logStep('Creating/updating QA vendor');
  users.vendor = await upsertVendorUser({
    User,
    spec: ACCOUNTS.find((a) => a.key === 'vendor'),
    hashedPassword,
    boardUser: users.board,
    hoaId: hoa._id,
  });
  await ensureVendorLinked({
    vendorUser: users.vendor,
    boardUser: users.board,
    hoaId: hoa._id,
  });

  logStep('Provisioning QA tenant sample data');
  await ensureQaTenantSampleData({
    User,
    company,
    roleByName,
    hashedPassword,
    tenantUser: users.tenant,
  });

  console.log('\n✅ QA accounts are ready.');
  console.log(`\nHOA community: ${QA_HOA_NAME}`);
  console.log(`HOA community: ${QA2_HOA_NAME}`);
  console.log(`Password (all accounts): ${PASSWORD}`);
  console.log('OTP (when test auth enabled): 000000');
  console.log('\nAccounts:');
  for (const spec of ACCOUNTS) {
    console.log(`  - ${spec.role.padEnd(18)} ${spec.email}`);
  }
  console.log('\nUnit setup:');
  console.log(`  - ${SINGLE_UNIT_NAME}: qa.owner.single@propmv.com`);
  console.log(`  - ${CO_UNIT_NAME}: qa.owner.co1 / co2 / co3@propmv.com`);
  console.log('  - qa.owner.unassigned@propmv.com: no unit');
  console.log(`  - qa.tenant@propmv.com: lease on ${QA_LANDLORD_PROPERTY_NAME} (landlord ${QA_LANDLORD_EMAIL})`);
  console.log(`  - qa.board2@propmv.com: second board member on ${QA_HOA_NAME}`);
  console.log(`  - qa2.board@propmv.com: board member on ${QA2_HOA_NAME}`);
  console.log(`  - qa2.owner@propmv.com: sole owner of ${QA2_UNIT_NAME} on ${QA2_HOA_NAME}`);
  console.log('\nEnsure backend OTP bypass includes these emails:');
  console.log('  PLAY_STORE_TEST_AUTH_ENABLED=true');
  console.log('  PLAY_STORE_TEST_OTP=000000');
  console.log('  PLAY_STORE_TEST_ACCOUNTS=...qa.tenant@propmv.com,...');

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error('QA seed failed:', err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
