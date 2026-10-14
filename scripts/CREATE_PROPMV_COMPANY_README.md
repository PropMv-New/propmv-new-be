# Create PropMv Company with Roles and Privileges

## Overview

This script creates a **PropMv** company in the database with 5 roles, each configured with the appropriate privileges based on the application's route configurations.

## Roles Created

### 1. Landlord

**Description**: Landlord user role with full property management access

**Privileges** (28 total):

- Dashboard: VIEW_DASHBOARD
- Property: VIEW, CREATE, EDIT, DELETE
- Tenants: VIEW, CREATE, EDIT, DELETE
- Applications: VIEW, CREATE, EDIT, DELETE
- Leases: VIEW, CREATE, EDIT, DELETE
- Income: VIEW, CREATE, EDIT, DELETE
- Expenses: VIEW, CREATE, EDIT, DELETE
- Maintenance: VIEW, CREATE, EDIT, DELETE
- Listings: VIEW, CREATE, EDIT, DELETE
- Messaging: VIEW, SEND, VIEW_MESSAGING
- Email: VIEW, COMPOSE
- Reports: VIEW, EXPORT
- Settings: VIEW, EDIT
- Users: VIEW, CREATE, EDIT, DELETE
- Payment Management: VIEW

---

### 2. Tenant

**Description**: Tenant user role with limited access

**Privileges** (9 total):

- Dashboard: VIEW_DASHBOARD
- Leases: VIEW
- Maintenance: VIEW, CREATE
- Messaging: VIEW, SEND, VIEW_MESSAGING
- Documents: VIEW
- Settings: VIEW

---

### 3. Property Manager

**Description**: Property manager user role with comprehensive management access

**Privileges** (33 total):

- All Landlord privileges PLUS:
- Roles: VIEW, CREATE, EDIT, DELETE, ASSIGN

---

### 4. HOA Board Member

**Description**: HOA board member role with HOA management access

**Privileges** (23 total):

- Dashboard: VIEW_DASHBOARD
- Property: VIEW, CREATE, EDIT, DELETE
- Owners: VIEW, CREATE, EDIT, DELETE
- Income: VIEW, CREATE, EDIT, DELETE
- Expenses: VIEW, CREATE, EDIT, DELETE
- Maintenance: VIEW, CREATE, EDIT, DELETE
- Messaging: VIEW, SEND, VIEW_MESSAGING
- Community: VIEW, MANAGE
- Documents: VIEW, CREATE, EDIT, DELETE
- Reports: VIEW, EXPORT
- Settings: VIEW, EDIT

---

### 5. HOA Owner

**Description**: HOA property owner role with limited access

**Privileges** (8 total):

- Dashboard: VIEW_DASHBOARD
- Documents: VIEW
- Income: VIEW
- Maintenance: VIEW, CREATE
- Messaging: VIEW, SEND, VIEW_MESSAGING
- Reports: VIEW
- Settings: VIEW

---

## Usage

### Prerequisites

- Node.js installed
- MongoDB connection configured in `.env.local` or `.env`
- Required environment variables:

  ```
  MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/
  DB_NAME=PropMv
  ```

### Run the Script

```bash
cd d:\propmv\propmv
node scripts/create-propmv-company-with-roles.js
```

### Expected Output

```
══════════════════════════════════════════════════════════════════════
  Create PropMv Company with Roles and Privileges
══════════════════════════════════════════════════════════════════════

📡 Connecting to MongoDB...
Connected to MongoDB

🔧 Creating roles with privileges...

   ✓ Landlord: 28 privileges
   ✓ Tenant: 9 privileges
   ✓ Property Manager: 33 privileges
   ✓ HOA Board Member: 23 privileges
   ✓ HOA Owner: 8 privileges

🏢 Creating PropMv company...
PropMv company created successfully!

══════════════════════════════════════════════════════════════════════
  Summary
══════════════════════════════════════════════════════════════════════

Company ID: 507f1f77bcf86cd799439011
Company Name: PropMv
Total Roles: 5

Roles and Privileges:

1. Landlord
   Role ID: 507f1f77bcf86cd799439012
   Description: Landlord user role with full property management access
   Privileges: 28
   Active: true

...

══════════════════════════════════════════════════════════════════════
Setup completed successfully!
══════════════════════════════════════════════════════════════════════

Disconnected from MongoDB
```

## What the Script Does

1. **Connects to MongoDB** using environment configuration
2. **Checks for existing PropMv company** - exits if already exists
3. **Creates 5 embedded roles** with privileges based on application routes
4. **Creates PropMv company** with all roles embedded
5. **Displays summary** of created company and roles
6. **Verifies creation** and disconnects

## Features

- All privileges mapped from application route configurations
- Role-based access control (RBAC) ready
- Embedded roles in company document
- Active/inactive role support
- Comprehensive privilege assignment
- Safe execution (checks for existing company)

## Privileges Reference

All privileges used in the application:

**Property Management**

- VIEW_PROPERTY, CREATE_PROPERTY, EDIT_PROPERTY, DELETE_PROPERTY

**Tenant Management**

- VIEW_TENANTS, CREATE_TENANTS, EDIT_TENANTS, DELETE_TENANTS

**Application Management**

- VIEW_APPLICATION, CREATE_APPLICATION, EDIT_APPLICATION, DELETE_APPLICATION

**Lease Management**

- VIEW_LEASE, CREATE_LEASE, EDIT_LEASE, DELETE_LEASE

**Income Management**

- VIEW_INCOME, CREATE_INCOME, EDIT_INCOME, DELETE_INCOME

**Expense Management**

- VIEW_EXPENSE, CREATE_EXPENSE, EDIT_EXPENSE, DELETE_EXPENSE

**Maintenance Management**

- VIEW_MAINTENANCE, CREATE_MAINTENANCE, EDIT_MAINTENANCE, DELETE_MAINTENANCE

**Listings Management**

- VIEW_LISTINGS, CREATE_LISTINGS, EDIT_LISTINGS, DELETE_LISTINGS

**Messaging**

- VIEW_MESSAGE, SEND_MESSAGE, VIEW_MESSAGING

**Email**

- VIEW_EMAIL, COMPOSE_EMAIL

**Dashboard**

- VIEW_DASHBOARD

**Owner Management**

- VIEW_OWNER, CREATE_OWNER, EDIT_OWNER, DELETE_OWNER

**Community**

- VIEW_COMMUNITY, MANAGE_COMMUNITY

**Documents**

- VIEW_DOCUMENTS, CREATE_DOCUMENTS, EDIT_DOCUMENTS, DELETE_DOCUMENTS

**Reports**

- VIEW_REPORTS, EXPORT_REPORTS

**Settings**

- VIEW_SETTINGS, EDIT_SETTINGS

**Users**

- VIEW_USERS, CREATE_USERS, EDIT_USERS, DELETE_USERS

**Roles**

- VIEW_ROLE, CREATE_ROLE, EDIT_ROLE, DELETE_ROLE, ASSIGN_ROLE

**Payment Management**

- VIEW_PAYMENT_MANAGEMENT

## Notes

- The script is **idempotent** - it will not create duplicate companies
- All roles are created as **active** by default
- The company is configured with **enterprise subscription**
- Privileges are stored as strings in the `privileges` array
- To recreate, delete the existing PropMv company first

## Troubleshooting

**Company already exists**

- Delete existing company: `db.companies.deleteOne({name: 'PropMv'})`
- Or use MongoDB Compass to remove it manually

**Connection failed**

- Check `.env.local` or `.env` file
- Verify MONGODB_URI is correct
- Ensure network/firewall allows MongoDB connection

**Missing privileges**

- Review `src/common/constants/privileges.js`
- Check route files in `src/portals/landlord/privileges/`
- Update PRIVILEGES object in script if needed
