# PropMv Company - Quick Reference Card

## 🏢 Company Information
```
Company Name: PropMv
Company ID:   6a24563f1cda7ba2581d6e79
Status:       Active 
Created:      June 6, 2026
```

## 📊 Roles at a Glance

| Role | ID | Privileges | Use Case |
|------|----|-----------:|----------|
| 🏠 Landlord | `6a24563f1cda7ba2581d6e7a` | 47 | Property owners managing rentals |
| 👤 Tenant | `6a24563f1cda7ba2581d6e7b` | 9 | Renters with limited access |
| 🏢 Property Manager | `6a24563f1cda7ba2581d6e7c` | 52 | Full administrative access |
| 👥 HOA Board Member | `6a24563f1cda7ba2581d6e7d` | 34 | HOA community management |
| 🏘️ HOA Owner | `6a24563f1cda7ba2581d6e7e` | 10 | HOA property owners |

## ⚡ Quick Commands

### Create Company
```bash
cd d:\propmv\propmv
node scripts/create-propmv-company-with-roles.js
```

### Verify Company
```bash
node scripts/verify-propmv-company.js
```

### Check Company in MongoDB
```javascript
db.companies.findOne({ name: "PropMv" })
```

### Get Role by Name
```javascript
db.companies.findOne(
  { name: "PropMv" },
  { "roles.$": 1 }
).where({ "roles.name": "Landlord" })
```

## 🎯 Common Privilege Patterns

### Everyone Can:
- VIEW_DASHBOARD
- VIEW_MESSAGE, SEND_MESSAGE
- VIEW_SETTINGS

### Only Property Managers Can:
- VIEW_ROLE, CREATE_ROLE, EDIT_ROLE, DELETE_ROLE, ASSIGN_ROLE

### Landlords & Property Managers Can:
- Full CRUD on: Properties, Tenants, Applications, Leases
- Full access to Income, Expenses, Listings
- Email compose and send
- User management

### HOA Board Members Can:
- Manage owners, not tenants
- Community management
- Documents management
- Income/Expense tracking

### Tenants & HOA Owners Can:
- View dashboard
- Create maintenance requests
- Send messages
- View documents

## 📝 Role Assignment Example

```javascript
// Assign user to Landlord role
await User.findByIdAndUpdate(userId, {
  companyId: "6a24563f1cda7ba2581d6e79",
  roleId: "6a24563f1cda7ba2581d6e7a" // Landlord role ID
});

// Check user privileges
const company = await Company.findById(user.companyId);
const role = company.roles.id(user.roleId);
const hasPrivilege = role.privileges.includes("VIEW_PROPERTY");
```

## 🔒 Privilege Check Example

```javascript
// Middleware usage
const { checkPrivilege } = require('./middleware/privilegeCheck');

router.get('/properties', 
  authenticate,
  checkPrivilege('VIEW_PROPERTY'),
  propertyController.getAll
);

router.post('/properties',
  authenticate, 
  checkPrivilege('CREATE_PROPERTY'),
  propertyController.create
);
```

## 🎨 Frontend Role Check

```javascript
// React/Vue component example
const userPrivileges = user.role.privileges;

// Show create button only if user has privilege
{userPrivileges.includes('CREATE_PROPERTY') && (
  <Button onClick={createProperty}>Create Property</Button>
)}

// Show menu item based on privilege
{userPrivileges.includes('VIEW_TENANTS') && (
  <MenuItem to="/tenants">Tenants</MenuItem>
)}
```

## 📋 Privilege Categories

### Property Management (4 privileges each)
- PROPERTY: VIEW, CREATE, EDIT, DELETE
- TENANTS: VIEW, CREATE, EDIT, DELETE
- OWNER: VIEW, CREATE, EDIT, DELETE

### Financial (4 privileges each)
- INCOME: VIEW, CREATE, EDIT, DELETE
- EXPENSE: VIEW, CREATE, EDIT, DELETE

### Operations (4 privileges each)
- MAINTENANCE: VIEW, CREATE, EDIT, DELETE
- LISTINGS: VIEW, CREATE, EDIT, DELETE
- APPLICATION: VIEW, CREATE, EDIT, DELETE
- LEASE: VIEW, CREATE, EDIT, DELETE

### Communication (3 privileges)
- MESSAGE: VIEW, SEND
- MESSAGING: VIEW

### Documents & Reports
- DOCUMENTS: VIEW, CREATE, EDIT, DELETE
- REPORTS: VIEW, EXPORT

### Administration
- USERS: VIEW, CREATE, EDIT, DELETE
- ROLE: VIEW, CREATE, EDIT, DELETE, ASSIGN
- SETTINGS: VIEW, EDIT

## 🔄 Role Migration Script

If you need to update privileges:

```javascript
const company = await Company.findOne({ name: 'PropMv' });
const role = company.roles.find(r => r.name === 'Landlord');

// Add new privilege
role.privileges.push('NEW_PRIVILEGE');

// Remove privilege
role.privileges = role.privileges.filter(p => p !== 'OLD_PRIVILEGE');

await company.save();
```

## 🐛 Troubleshooting

**Company not found?**
```bash
# Run creation script
node scripts/create-propmv-company-with-roles.js
```

**Role missing privileges?**
```bash
# Verify current setup
node scripts/verify-propmv-company.js
```

**Need to recreate?**
```javascript
// Delete existing company
db.companies.deleteOne({ name: 'PropMv' });

// Run creation script again
node scripts/create-propmv-company-with-roles.js
```

## 📊 Privilege Count by Role

```
Property Manager ████████████████████████████████████████████████ 52
Landlord        █████████████████████████████████████████████    47
HOA Board       ██████████████████████████████████             34
HOA Owner       ██████████                                     10
Tenant          █████████                                       9
```

## 🎯 Role Selection Guide

**Choose Landlord when:**
- User owns rental properties
- Needs to manage tenants and leases
- Handles income and expenses
- No role management needed

**Choose Tenant when:**
- User is renting a property
- Only needs to view their lease
- Submit maintenance requests
- Minimal access required

**Choose Property Manager when:**
- User manages properties for others
- Needs role management capabilities
- Full administrative access required
- Managing multiple landlords

**Choose HOA Board Member when:**
- Managing HOA community
- Dealing with homeowners (not tenants)
- Community and document management
- HOA financial oversight

**Choose HOA Owner when:**
- Homeowner in HOA community
- View HOA documents and financials
- Submit maintenance requests
- Minimal owner access

## 📞 Files Reference

| File | Purpose | Location |
|------|---------|----------|
| Creation Script | Create company | `scripts/create-propmv-company-with-roles.js` |
| Verification | Verify setup | `scripts/verify-propmv-company.js` |
| README | Full documentation | `scripts/CREATE_PROPMV_COMPANY_README.md` |
| Summary | Execution report | `scripts/PROPMV_COMPANY_SUMMARY.md` |
| Quick Ref | This file | `scripts/PROPMV_QUICK_REFERENCE.md` |

## 🎉 Success Indicators

- [x] Company exists in database
- [x] 5 roles with correct privilege counts
- [x] All roles marked as active
- [x] No duplicate privileges
- [x] Privilege checks working in routes
- [x] Frontend shows/hides based on privileges

---

**Last Updated:** June 6, 2026  
**Version:** 1.0.0  
**Status:** Production Ready 
