/**
 * Bulk Data Seed Script
 * Seeds 1000 records per collection for user: hiteshchavhan0811@gmail.com
 * DB: mongodb+srv://support_db_user:bCmGvGJJBywa9itS@propmv.nghqvlv.mongodb.net/?appName=PropMv
 *
 * Insertion order (dependency flow):
 * 1. Company (with roles)
 * 2. User (landlord - hiteshchavhan0811@gmail.com)
 * 3. Properties (1000)
 * 4. Tenants/Users (1000)
 * 5. Leases (1000, one per property)
 * 6. Invoices (1000)
 * 7. Listings (1000)
 * 8. MaintenanceRequests (1000)
 * 9. Expenses (1000)
 * 10. Applications (1000)
 */

require('../src/config/loadEnv');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const DB_URL = 'mongodb+srv://support_db_user:bCmGvGJJBywa9itS@propmv.nghqvlv.mongodb.net/?appName=PropMv';
const TARGET_EMAIL = 'hiteshchavhan0811@gmail.com';
const BATCH_SIZE = 100;
const TOTAL = 1000;

// ─── helpers ────────────────────────────────────────────────────────────────
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randFloat = (min, max) => parseFloat((Math.random() * (max - min) + min).toFixed(2));
const future = (days) => new Date(Date.now() + days * 86400000);
const past = (days) => new Date(Date.now() - days * 86400000);

const US_STATES = ['CA', 'TX', 'FL', 'NY', 'IL', 'PA', 'OH', 'GA', 'NC', 'MI'];
const CITIES = ['Los Angeles', 'Houston', 'Miami', 'New York', 'Chicago', 'Philadelphia', 'Columbus', 'Atlanta', 'Charlotte', 'Detroit'];
const STREETS = ['Main St', 'Oak Ave', 'Maple Dr', 'Cedar Ln', 'Pine Rd', 'Elm St', 'Park Blvd', 'Lake Dr', 'River Rd', 'Hill St'];
const PROPERTY_TYPES = ['Single Family', 'Multi Family', 'Condo', 'Townhouse', 'Apartment'];
const OWNERSHIP_TYPES = ['Owned', 'Managed'];
const OWNER_TYPES = ['Individual', 'LLC', 'Corporation'];
const MAINTENANCE_CATEGORIES = ['Plumbing', 'Electrical', 'HVAC', 'Appliance', 'Structural', 'Pest Control', 'Landscaping', 'Other'];
const MAINTENANCE_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const MAINTENANCE_STATUSES = ['Open', 'InProgress', 'Completed'];
const EXPENSE_CATEGORIES = ['Repairs', 'Utilities', 'Insurance', 'Taxes', 'Management', 'Landscaping', 'Cleaning', 'Other'];
// Correct enum values from constants
const LEASE_TYPES = ['FixedTerm', 'MonthToMonth'];
const PAYMENT_FREQUENCIES = ['monthly', 'bi-monthly', 'weekly', 'bi-weekly'];
const LISTING_STATUSES = ['Active', 'Inactive'];
const LISTING_LEASE_TYPES = ['Fixed Term', 'Month-to-Month', 'Short Term'];
const LISTING_PAYMENT_FREQUENCIES = ['Monthly', 'Weekly', 'Bi-weekly', 'Quarterly', 'Annually'];
const INVOICE_TYPES_LIST = ['Rent', 'Deposit', 'Miscellaneous', 'Other', 'Late Fee'];
const INVOICE_STATUSES = ['Pending', 'Paid', 'Partially Paid', 'Overdue'];
const APP_STATUSES = ['submitted', 'pending', 'approved', 'rejected'];

async function insertInBatches(Model, docs, label) {
  let inserted = 0;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    await Model.insertMany(batch, { ordered: false });
    inserted += batch.length;
    process.stdout.write(`\r  ${label}: ${inserted}/${docs.length}`);
  }
  console.log(`\r   ${label}: ${inserted} records inserted`);
}

async function main() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(DB_URL);
  console.log(' Connected\n');

  // ── Load models ──────────────────────────────────────────────────────────
  const User = require('../src/shared/modules/users/models/user.model');
  const Company = require('../src/shared/modules/company/models/company.model');
  const Property = require('../src/portals/landlord/modules/property/model/property.model');
  const Lease = require('../src/portals/landlord/modules/leasing/model/lease.model');
  const Invoice = require('../src/portals/landlord/modules/invoice/model/invoice.model');
  const Listing = require('../src/portals/landlord/modules/listing/models/listing.model');
  const MaintenanceRequest = require('../src/shared/modules/maintenance/model/maintenanceRequest.model');
  const Expense = require('../src/portals/hoa-board/modules/expense/model/expense.model');
  const Application = require('../src/portals/landlord/modules/application/models/application.model');

  // ── 1. Company ───────────────────────────────────────────────────────────
  console.log('📦 Step 1: Creating company...');
  let company = await Company.findOne({ name: 'Hitesh Property Management', isDeleted: { $ne: true } });
  if (!company) {
    company = await Company.create({
      name: 'Hitesh Property Management',
      description: 'Property management company for bulk seed',
      roles: [
        { name: 'Administrator', description: 'Full access', privileges: ['*'], isActive: true },
        { name: 'Tenant', description: 'Tenant access', privileges: ['VIEW_PROPERTY'], isActive: true },
        { name: 'Property Manager', description: 'PM access', privileges: ['VIEW_PROPERTY', 'CREATE_PROPERTY'], isActive: true },
      ],
      isActive: true,
    });
    console.log('   Company created:', company._id);
  } else {
    console.log('  ℹ️  Company already exists:', company._id);
  }

  const adminRole = company.roles.find(r => r.name === 'Administrator' && r.isActive);
  const tenantRole = company.roles.find(r => r.name === 'Tenant' && r.isActive);

  // ── 2. Landlord user ─────────────────────────────────────────────────────
  console.log('\n📦 Step 2: Creating landlord user...');
  let landlord = await User.findOne({ email: TARGET_EMAIL });
  if (!landlord) {
    const hashed = await bcrypt.hash('Password@123', 10);
    landlord = await User.create({
      email: TARGET_EMAIL,
      password: hashed,
      firstName: 'Hitesh',
      lastName: 'Chavhan',
      phone: '9876543210',
      status: 'Active',
      companyId: company._id,
      companyRoleId: adminRole._id,
    });
    console.log('   Landlord created:', landlord._id);
  } else {
    // Ensure company is assigned
    if (!landlord.companyId) {
      landlord.companyId = company._id;
      landlord.companyRoleId = adminRole._id;
      await landlord.save();
    }
    console.log('  ℹ️  Landlord already exists:', landlord._id);
  }
  const landlordId = landlord._id;

  // ── 3. Properties ────────────────────────────────────────────────────────
  console.log('\n📦 Step 3: Seeding properties...');
  const existingPropCount = await Property.countDocuments({ createdBy: landlordId, isDeleted: { $ne: true } });
  let propertyIds = [];

  if (existingPropCount >= TOTAL) {
    console.log(`  ℹ️  ${existingPropCount} properties already exist, fetching IDs...`);
    const props = await Property.find({ createdBy: landlordId, isDeleted: { $ne: true } }).select('_id').limit(TOTAL).lean();
    propertyIds = props.map(p => p._id);
  } else {
    const needed = TOTAL - existingPropCount;
    const propertyDocs = Array.from({ length: needed }, (_, i) => {
      const idx = existingPropCount + i + 1;
      const stateIdx = i % US_STATES.length;
      const unitId = new mongoose.Types.ObjectId();
      return {
        createdBy: landlordId,
        name: `Property ${idx}`,
        propertyType: rand(PROPERTY_TYPES),
        ownershipType: rand(OWNERSHIP_TYPES),
        ownerName: 'Hitesh Chavhan',
        ownerEmail: TARGET_EMAIL,
        ownerPhone: `+1${randInt(2000000000, 9999999999)}`,
        ownerType: rand(OWNER_TYPES),
        address: {
          street: `${randInt(100, 9999)} ${rand(STREETS)}`,
          city: CITIES[stateIdx],
          state: US_STATES[stateIdx],
          zip: `${randInt(10000, 99999)}`,
          country: 'USA',
        },
        unitDetails: [{
          _id: unitId,
          unitName: `Unit ${idx}-A`,
          unitType: 'Residential',
          squareFeet: randInt(500, 3000),
          bedRooms: randInt(1, 5),
          bathRoom: randInt(1, 3),
          amenities: ['Parking', 'Laundry'],
        }],
        isDeleted: false,
        isArchieved: false,
      };
    });

    await insertInBatches(Property, propertyDocs, 'Properties');
    const allProps = await Property.find({ createdBy: landlordId, isDeleted: { $ne: true } }).select('_id').limit(TOTAL).lean();
    propertyIds = allProps.map(p => p._id);
  }
  console.log(`  📊 Total property IDs available: ${propertyIds.length}`);

  // ── 4. Tenant users ──────────────────────────────────────────────────────
  console.log('\n📦 Step 4: Seeding tenant users...');
  const existingTenantCount = await User.countDocuments({
    createdBy: landlordId,
    companyId: company._id,
    companyRoleId: tenantRole._id,
    isDeleted: { $ne: true },
  });
  let tenantIds = [];

  if (existingTenantCount >= TOTAL) {
    console.log(`  ℹ️  ${existingTenantCount} tenants already exist, fetching IDs...`);
    const tenants = await User.find({ createdBy: landlordId, companyId: company._id, companyRoleId: tenantRole._id, isDeleted: { $ne: true } }).select('_id').limit(TOTAL).lean();
    tenantIds = tenants.map(t => t._id);
  } else {
    const needed = TOTAL - existingTenantCount;
    const hashedPwd = await bcrypt.hash('Tenant@123', 10);
    const tenantDocs = Array.from({ length: needed }, (_, i) => {
      const idx = existingTenantCount + i + 1;
      return {
        email: `tenant.seed.${idx}.${Date.now()}@propmv-seed.com`,
        password: hashedPwd,
        firstName: `TenantFirst${idx}`,
        lastName: `TenantLast${idx}`,
        phone: `+1${randInt(2000000000, 9999999999)}`,
        address: `${randInt(100, 9999)} ${rand(STREETS)}`,
        state: rand(US_STATES),
        zipCode: `${randInt(10000, 99999)}`,
        status: 'Active',
        createdBy: landlordId,
        companyId: company._id,
        companyRoleId: tenantRole._id,
        isDeleted: false,
      };
    });

    await insertInBatches(User, tenantDocs, 'Tenants');
    const allTenants = await User.find({ createdBy: landlordId, companyId: company._id, companyRoleId: tenantRole._id, isDeleted: { $ne: true } }).select('_id').limit(TOTAL).lean();
    tenantIds = allTenants.map(t => t._id);
  }
  console.log(`  📊 Total tenant IDs available: ${tenantIds.length}`);

  // ── 5. Leases ────────────────────────────────────────────────────────────
  console.log('\n📦 Step 5: Seeding leases...');
  const existingLeaseCount = await Lease.countDocuments({
    property_id: { $in: propertyIds },
    isDeleted: { $ne: true },
  });

  let leaseIds = [];
  if (existingLeaseCount >= TOTAL) {
    console.log(`  ℹ️  ${existingLeaseCount} leases already exist, fetching IDs...`);
    const leases = await Lease.find({ property_id: { $in: propertyIds }, isDeleted: { $ne: true } }).select('_id').limit(TOTAL).lean();
    leaseIds = leases.map(l => l._id);
  } else {
    const needed = TOTAL - existingLeaseCount;
    const leaseDocs = Array.from({ length: needed }, (_, i) => {
      const propId = propertyIds[i % propertyIds.length];
      const tenantId = tenantIds[i % tenantIds.length];
      const startDate = past(randInt(30, 365));
      const endDate = future(randInt(30, 365));
      const rentAmount = randFloat(800, 5000);
      const depositAmount = randFloat(800, 5000);
      return {
        property_id: propId,
        unitName: `Unit ${i + 1}-A`,
        leaseTerm: '12 months',
        lease_type: rand(LEASE_TYPES),   // 'FixedTerm' | 'MonthToMonth'
        start_date: startDate,
        end_date: endDate,
        switchMonthToMonth: false,
        auto_renew: false,
        rentDetails: {
          frequency: rand(PAYMENT_FREQUENCIES),  // 'monthly' | 'bi-monthly' | ...
          amount: rentAmount,
          dueOne: '1',
          firstRentalInvoiceDue: future(randInt(1, 30)),
        },
        depositDetails: {
          amount: depositAmount,
          due: future(randInt(1, 15)),
          isDepositAlreadyCollected: false,
        },
        rentAndDepositDestribution: {
          isAllTenantsEquallyResponsible: true,
          isPartialPaymentAllowed: false,
          rentDistributionType: 'Equal',
          securityDepositDestributionType: 'Equal',
          split: [{
            tenantId: String(tenantId),
            rentAmount,
            rentPercentage: 100,
            depositAmount,
            depositPercentage: 100,
            screening: [],
            inviteAcknowledged: false,
          }],
        },
        status: 'Submitted',
        isDeleted: false,
      };
    });

    await insertInBatches(Lease, leaseDocs, 'Leases');
    const allLeases = await Lease.find({ property_id: { $in: propertyIds }, isDeleted: { $ne: true } }).select('_id').limit(TOTAL).lean();
    leaseIds = allLeases.map(l => l._id);
  }
  console.log(`  📊 Total lease IDs available: ${leaseIds.length}`);

  // ── 6. Invoices ──────────────────────────────────────────────────────────
  console.log('\n📦 Step 6: Seeding invoices...');
  const existingInvoiceCount = await Invoice.countDocuments({
    propertyId: { $in: propertyIds },
    isDeleted: { $ne: true },
  });

  if (existingInvoiceCount < TOTAL) {
    const needed = TOTAL - existingInvoiceCount;
    // Use correct enum values: INVOICE_TYPES_LIST and INVOICE_STATUSES defined at top

    const invoiceDocs = Array.from({ length: needed }, (_, i) => {
      const propId = propertyIds[i % propertyIds.length];
      const tenantId = tenantIds[i % tenantIds.length];
      const leaseId = leaseIds[i % leaseIds.length];
      const amount = randFloat(500, 5000);
      const alreadyPaid = rand([0, randFloat(0, amount)]);
      const balanceDue = parseFloat((amount - alreadyPaid).toFixed(2));
      const uniqueSuffix = `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`;
      return {
        invoiceId: `INV-SEED-${uniqueSuffix}`,
        type: rand(INVOICE_TYPES_LIST),   // 'Rent'|'Deposit'|'Miscellaneous'|'Other'|'Late Fee'
        status: rand(INVOICE_STATUSES),    // 'Pending'|'Paid'|'Partially Paid'|'Overdue'
        lease_id: leaseId,
        propertyId: propId,
        propertyName: `Property ${i + 1}`,
        unit: `Unit ${i + 1}-A`,
        term: `${new Date().getFullYear()}-${String(randInt(1, 12)).padStart(2, '0')}`,
        tenants: [tenantId],
        invoiceItemDetails: [{
          invoiceItem: 'Rent',
          description: 'Monthly rent',
          quantity: 1,
          rate: amount,
          amount,
        }],
        subAmount: amount,
        alreadyPaid,
        balanceDue,
        isPartialPaymentAllowed: false,
        dueDate: future(randInt(-30, 60)),
        createdBy: landlordId,
        isDeleted: false,
      };
    });

    await insertInBatches(Invoice, invoiceDocs, 'Invoices');
  } else {
    console.log(`  ℹ️  ${existingInvoiceCount} invoices already exist, skipping`);
  }

  // ── 7. Listings ──────────────────────────────────────────────────────────
  console.log('\n📦 Step 7: Seeding listings...');
  const existingListingCount = await Listing.countDocuments({
    propertyId: { $in: propertyIds },
    isDeleted: { $ne: true },
  });

  if (existingListingCount < TOTAL) {
    const needed = TOTAL - existingListingCount;
    const listingDocs = Array.from({ length: needed }, (_, i) => {
      const propId = propertyIds[i % propertyIds.length];
      const stateIdx = i % US_STATES.length;
      return {
        propertyId: propId,
        propertyName: `Property ${i + 1}`,
        propertyType: rand(PROPERTY_TYPES),
        address: `${randInt(100, 9999)} ${rand(STREETS)}`,
        city: CITIES[stateIdx],
        state: US_STATES[stateIdx],
        zip: `${randInt(10000, 99999)}`,
        unitName: `Unit ${i + 1}-A`,
        bedrooms: randInt(1, 5),
        bathrooms: randInt(1, 3),
        area: randInt(500, 3000),
        listingHeadline: `Beautiful ${randInt(1, 5)} Bed Property ${i + 1}`,
        description: `Spacious and well-maintained property available for rent. Property ${i + 1} features modern amenities and great location.`,
        rentalAmount: randFloat(800, 5000),
        securityDeposit: randFloat(800, 5000),
        paymentFrequency: rand(LISTING_PAYMENT_FREQUENCIES),  // 'Monthly'|'Weekly'|'Bi-weekly'|'Quarterly'|'Annually'
        availableDate: future(randInt(1, 90)),
        leaseType: rand(LISTING_LEASE_TYPES),  // 'Fixed Term'|'Month-to-Month'|'Short Term'
        petPolicies: rand([['No Pets'], ['Cats Allowed'], ['Dogs Allowed'], ['Pets Allowed']]),
        utilitiesIncluded: rand([['Water'], ['Water', 'Trash'], ['None'], []]),
        amenities: ['Parking', 'Laundry', 'Air Conditioning'],
        isAcceptingApplications: true,
        status: rand(LISTING_STATUSES),  // 'Active'|'Inactive'
        isDeleted: false,
      };
    });

    await insertInBatches(Listing, listingDocs, 'Listings');
  } else {
    console.log(`  ℹ️  ${existingListingCount} listings already exist, skipping`);
  }

  // ── 8. Maintenance Requests ──────────────────────────────────────────────
  console.log('\n📦 Step 8: Seeding maintenance requests...');
  const existingMaintCount = await MaintenanceRequest.countDocuments({
    property_id: { $in: propertyIds },
    isDeleted: { $ne: true },
  });

  if (existingMaintCount < TOTAL) {
    const needed = TOTAL - existingMaintCount;
    const maintDocs = Array.from({ length: needed }, (_, i) => {
      const propId = propertyIds[i % propertyIds.length];
      const tenantId = tenantIds[i % tenantIds.length];
      const category = rand(MAINTENANCE_CATEGORIES);
      const uniqueSuffix = `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`;
      return {
        property_id: propId,
        units: `Unit ${i + 1}-A`,
        title: `${category} Issue ${i + 1}`,
        description: `Maintenance request for ${category.toLowerCase()} issue in unit ${i + 1}. Requires immediate attention.`,
        category,
        priority: rand(MAINTENANCE_PRIORITIES),
        isUrgent: Math.random() > 0.8,
        requestedBy: [tenantId],
        notifyTenant: true,
        request_date: past(randInt(1, 90)),
        status: rand(MAINTENANCE_STATUSES),
        estimatedCost: randFloat(50, 2000),
        actualCost: randFloat(0, 2000),
        createdBy: landlordId,
        ticketNumber: `MNT-SEED-${uniqueSuffix}`,
        isDeleted: false,
      };
    });

    await insertInBatches(MaintenanceRequest, maintDocs, 'Maintenance Requests');
  } else {
    console.log(`  ℹ️  ${existingMaintCount} maintenance requests already exist, skipping`);
  }

  // ── 9. Expenses ──────────────────────────────────────────────────────────
  console.log('\n📦 Step 9: Seeding expenses...');
  const existingExpenseCount = await Expense.countDocuments({
    property: { $in: propertyIds },
    isDeleted: { $ne: true },
  });

  if (existingExpenseCount < TOTAL) {
    const needed = TOTAL - existingExpenseCount;
    const expenseDocs = Array.from({ length: needed }, (_, i) => {
      const propId = propertyIds[i % propertyIds.length];
      const expDate = past(randInt(1, 180));
      const dueDate = future(randInt(1, 60));
      const amount = randFloat(100, 5000);
      return {
        taxableEntity: 'Hitesh Chavhan',
        bankAccount: 'Primary Checking',
        property: propId,
        unit: `Unit ${i + 1}-A`,
        payees: [{ name: `Vendor ${i + 1}`, contact: `vendor${i + 1}@example.com` }],
        expenseItems: [{
          date: expDate,
          category: rand(EXPENSE_CATEGORIES),
          description: `Expense item for property ${i + 1}`,
          amount,
        }],
        total: amount,
        expenseDate: expDate,
        dueDate,
        status: 'pending',  // correct lowercase enum value
        createdBy: landlordId,
        isDeleted: false,
      };
    });

    await insertInBatches(Expense, expenseDocs, 'Expenses');
  } else {
    console.log(`  ℹ️  ${existingExpenseCount} expenses already exist, skipping`);
  }

  // ── 10. Applications ─────────────────────────────────────────────────────
  console.log('\n📦 Step 10: Seeding applications...');
  const existingAppCount = await Application.countDocuments({
    landlord_id: landlordId,
    isDeleted: { $ne: true },
  });

  if (existingAppCount < TOTAL) {
    const needed = TOTAL - existingAppCount;
    // APP_STATUSES defined at top with correct lowercase enum values
    const appDocs = Array.from({ length: needed }, (_, i) => {
      const propId = propertyIds[i % propertyIds.length];
      const tenantId = tenantIds[i % tenantIds.length];
      const leaseId = leaseIds[i % leaseIds.length];
      const idx = existingAppCount + i + 1;
      return {
        property_id: propId,
        tenant_id: tenantId,
        lease_id: leaseId,
        landlord_id: landlordId,
        createdBy: landlordId,
        personalInformation: {
          firstName: `AppFirst${idx}`,
          lastName: `AppLast${idx}`,
          mobileNumber: `+1${randInt(2000000000, 9999999999)}`,
          email: `applicant.${idx}.${Date.now()}@propmv-seed.com`,
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
          titleOrPosition: 'Software Engineer',
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
        status: rand(APP_STATUSES),  // 'submitted'|'pending'|'approved'|'rejected'
        isDeleted: false,
      };
    });

    await insertInBatches(Application, appDocs, 'Applications');
  } else {
    console.log(`  ℹ️  ${existingAppCount} applications already exist, skipping`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n📊 Final counts:');
  const counts = await Promise.all([
    Property.countDocuments({ createdBy: landlordId, isDeleted: { $ne: true } }),
    User.countDocuments({ createdBy: landlordId, companyId: company._id, companyRoleId: tenantRole._id, isDeleted: { $ne: true } }),
    Lease.countDocuments({ property_id: { $in: propertyIds }, isDeleted: { $ne: true } }),
    Invoice.countDocuments({ propertyId: { $in: propertyIds }, isDeleted: { $ne: true } }),
    Listing.countDocuments({ propertyId: { $in: propertyIds }, isDeleted: { $ne: true } }),
    MaintenanceRequest.countDocuments({ property_id: { $in: propertyIds }, isDeleted: { $ne: true } }),
    Expense.countDocuments({ property: { $in: propertyIds }, isDeleted: { $ne: true } }),
    Application.countDocuments({ landlord_id: landlordId, isDeleted: { $ne: true } }),
  ]);

  const labels = ['Properties', 'Tenants', 'Leases', 'Invoices', 'Listings', 'Maintenance Requests', 'Expenses', 'Applications'];
  labels.forEach((label, i) => console.log(`  ${label}: ${counts[i]}`));

  console.log('\n Bulk seed completed successfully!');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\n Seed failed:', err.message);
  console.error(err.stack);
  mongoose.disconnect();
  process.exit(1);
});
