# Module Setup Script

## Overview

This script automatically creates module documents in the database with their associated functions based on the system privileges.

## What It Does

1. Parses all system privileges (e.g., VIEW_PROPERTY, CREATE_TENANT)
2. Groups them by module (PROPERTY, TENANT, etc.)
3. Extracts functions for each module (VIEW, CREATE, EDIT, DELETE)
4. Creates module documents in the database
5. Verifies the data was inserted correctly

## Files

- `setup-modules.js` - Main script (requires .env file)
- `setup-modules-standalone.js` - Standalone script (hardcoded connection string)

## Prerequisites

- Node.js installed
- MongoDB connection access
- mongoose package installed

## Installation

```bash
cd d:\propmv\propmv
npm install mongoose
```

## Usage

### Option 1: Using Standalone Script (Recommended)

This script has the MongoDB connection string hardcoded.

```bash
node scripts/setup-modules-standalone.js
```

### Option 2: Using Main Script (Requires .env)

This script reads from environment variables.

```bash
# Make sure MONGODB_URI is set in .env file
node scripts/setup-modules.js
```

## Expected Output

```
═══════════════════════════════════════════════════════════════════════════════
🚀 MODULE SETUP SCRIPT
═══════════════════════════════════════════════════════════════════════════════

📡 Connecting to MongoDB...
Connected to MongoDB successfully

📊 Parsing privileges...
Found 13 unique modules

📝 Modules to be created:
────────────────────────────────────────────────────────────────────────────────

📦 PROPERTY
   Functions (4): CREATE, DELETE, EDIT, VIEW

📦 TENANTS
   Functions (4): CREATE, DELETE, EDIT, VIEW

📦 APPLICATION
   Functions (4): CREATE, DELETE, EDIT, VIEW

📦 LEASE
   Functions (4): CREATE, DELETE, EDIT, VIEW

📦 INCOME
   Functions (4): CREATE, DELETE, EDIT, VIEW

📦 EXPENSE
   Functions (4): CREATE, DELETE, EDIT, VIEW

📦 MAINTENANCE
   Functions (4): CREATE, DELETE, EDIT, VIEW

📦 LISTINGS
   Functions (4): CREATE, DELETE, EDIT, VIEW

📦 MESSAGE
   Functions (2): SEND, VIEW

📦 EMAIL
   Functions (2): COMPOSE, VIEW

📦 DASHBOARD
   Functions (1): VIEW

📦 USERS
   Functions (4): CREATE, DELETE, EDIT, VIEW

📦 ROLE
   Functions (5): ASSIGN, CREATE, DELETE, EDIT, VIEW

────────────────────────────────────────────────────────────────────────────────

🗑️  Clearing existing modules...
Deleted X existing modules

💾 Inserting modules into database...
Successfully inserted 13 modules

🔍 Verifying inserted data...

═══════════════════════════════════════════════════════════════════════════════
📊 VERIFICATION RESULTS
═══════════════════════════════════════════════════════════════════════════════

✓ APPLICATION
  ID: 507f1f77bcf86cd799439011
  Functions: CREATE, DELETE, EDIT, VIEW

✓ DASHBOARD
  ID: 507f1f77bcf86cd799439012
  Functions: VIEW

... (all modules listed)

═══════════════════════════════════════════════════════════════════════════════
📈 STATISTICS
═══════════════════════════════════════════════════════════════════════════════
Modules created: 13
Total privileges: 46
Original privileges: 46
Match: YES
═══════════════════════════════════════════════════════════════════════════════

🎉 SUCCESS! All modules created correctly!

👋 Database connection closed

Script completed successfully
```

## Modules Created

The script will create the following modules:

| Module | Functions | Description |
| -------- | ----------- | ------------- |
| PROPERTY | VIEW, CREATE, EDIT, DELETE | Property management module |
| TENANTS | VIEW, CREATE, EDIT, DELETE | Tenant management module |
| APPLICATION | VIEW, CREATE, EDIT, DELETE | Application management module |
| LEASE | VIEW, CREATE, EDIT, DELETE | Lease management module |
| INCOME | VIEW, CREATE, EDIT, DELETE | Income management module |
| EXPENSE | VIEW, CREATE, EDIT, DELETE | Expense management module |
| MAINTENANCE | VIEW, CREATE, EDIT, DELETE | Maintenance management module |
| LISTINGS | VIEW, CREATE, EDIT, DELETE | Listings management module |
| MESSAGE | VIEW, SEND | Messaging module |
| EMAIL | VIEW, COMPOSE | Email module |
| DASHBOARD | VIEW | Dashboard module |
| USERS | VIEW, CREATE, EDIT, DELETE | User management module |
| ROLE | VIEW, CREATE, EDIT, DELETE, ASSIGN | Role management module |

## Generated Privileges

After running the script, the system will be able to generate these privileges:

```
ASSIGN_ROLE
COMPOSE_EMAIL
CREATE_APPLICATION
CREATE_EXPENSE
CREATE_INCOME
CREATE_LEASE
CREATE_LISTINGS
CREATE_MAINTENANCE
CREATE_PROPERTY
CREATE_ROLE
CREATE_TENANTS
CREATE_USERS
DELETE_APPLICATION
DELETE_EXPENSE
DELETE_INCOME
DELETE_LEASE
DELETE_LISTINGS
DELETE_MAINTENANCE
DELETE_PROPERTY
DELETE_ROLE
DELETE_TENANTS
DELETE_USERS
EDIT_APPLICATION
EDIT_EXPENSE
EDIT_INCOME
EDIT_LEASE
EDIT_LISTINGS
EDIT_MAINTENANCE
EDIT_PROPERTY
EDIT_ROLE
EDIT_TENANTS
EDIT_USERS
SEND_MESSAGE
VIEW_APPLICATION
VIEW_DASHBOARD
VIEW_EMAIL
VIEW_EXPENSE
VIEW_INCOME
VIEW_LEASE
VIEW_LISTINGS
VIEW_MAINTENANCE
VIEW_MESSAGE
VIEW_PROPERTY
VIEW_ROLE
VIEW_TENANTS
VIEW_USERS
```

## Troubleshooting

### Connection Error

If you get a connection error:

1. Check if the MongoDB URI is correct
2. Verify network access to MongoDB Atlas
3. Ensure IP address is whitelisted in MongoDB Atlas

### Duplicate Key Error

If you get a duplicate key error:

- The script will automatically delete existing modules before inserting
- If error persists, manually delete modules from the database

### Module Count Mismatch

If the privilege count doesn't match:

1. Check the console output for warnings
2. Verify all privileges follow the FUNCTION_MODULE format
3. Review the generated privileges list

## Verification

After running the script, verify in MongoDB:

```javascript
// Connect to MongoDB and run:
db.modules.find().pretty()

// Should return 13 module documents
```

## Notes

- The script will DELETE all existing modules before inserting new ones
- Make sure to backup your database if you have important module data
- The script is idempotent - you can run it multiple times safely
- All timestamps (createdAt, updatedAt) will be automatically generated

## Support

If you encounter any issues:

1. Check the console output for detailed error messages
2. Verify MongoDB connection string
3. Ensure mongoose package is installed
4. Check database permissions
