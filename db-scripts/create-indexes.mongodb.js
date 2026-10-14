/**
 * ------------------------------------------------------------------
 * File: create-indexes.mongodb.js
 * Module: Db-scripts
 *
 * Purpose:
 * Backend utility/module providing helper functions for create-indexes.mongodb.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// MongoDB Shell Script - Copy and paste this entire file into MongoDB Shell or mongosh
// This will create all required indexes for optimal performance

// Switch to your database (update database name if different)
use("PropMv");

// Leases Collection - CRITICAL
db.leases.createIndex({ "property_id": 1 });
db.leases.createIndex({ "property_id": 1, "status": 1 });
db.leases.createIndex({ "property_id": 1, "unitName": 1 });

// Invoices Collection - CRITICAL
db.invoices.createIndex({ "lease_id": 1 });
db.invoices.createIndex({ "lease_id": 1, "status": 1, "type": 1 });
db.invoices.createIndex({ "propertyId": 1 });
db.invoices.createIndex({ "propertyId": 1, "isDeleted": 1, "dueDate": 1 });
db.invoices.createIndex({ "propertyId": 1, "isDeleted": 1, "status": 1, "dueDate": 1 });
db.invoices.createIndex({ "propertyId": 1, "isDeleted": 1, "status": 1, "balanceDue": 1, "dueDate": 1 });
db.invoices.createIndex({ "propertyId": 1, "isDeleted": 1, "balanceDue": 1, "dueDate": 1 });
// Optimizes list/stats filter: { propertyId: $in, isDeleted, generatedFrom }
db.invoices.createIndex({ "propertyId": 1, "isDeleted": 1, "generatedFrom": 1, "dueDate": 1 });
// Optimizes getInvoiceById prior-outstanding query
db.invoices.createIndex({ "propertyId": 1, "isDeleted": 1, "status": 1, "balanceDue": 1 });
db.invoices.createIndex({ "hoaId": 1, "isDeleted": 1, "dueDate": 1 });
db.invoices.createIndex({ "hoaId": 1, "isDeleted": 1, "status": 1, "dueDate": 1 });
db.invoices.createIndex({ "tenants": 1, "isDeleted": 1, "dueDate": -1 });
db.invoices.createIndex({ "createdBy": 1, "isDeleted": 1, "dueDate": -1 });

// Maintenance Requests Collection
db.maintenancerequests.createIndex({ "property_id": 1 });
db.maintenancerequests.createIndex({ "property_id": 1, "status": 1 });

// Listings Collection
db.listings.createIndex({ "propertyId": 1 });
db.listings.createIndex({ "propertyId": 1, "status": 1 });
db.listings.createIndex({ "propertyId": 1, "unitName": 1, "status": 1 });

// Properties Collection
db.properties.createIndex({ "landlord_id": 1 });
db.properties.createIndex({ "landlord_id": 1, "status": 1 });
db.properties.createIndex({ "hoaId": 1, "isDeleted": 1, "isArchieved": 1 });
db.properties.createIndex({ "hoaId": 1, "landlord_id": 1, "isDeleted": 1, "isArchieved": 1 });
db.properties.createIndex({ "associatedOwnerIds": 1, "isDeleted": 1 });
db.properties.createIndex({ "landlord_id": 1, "isDeleted": 1, "isArchieved": 1 });

// HOAMembership Collection
db.hoamemberships.createIndex({ "userId": 1, "status": 1 });
db.hoamemberships.createIndex({ "hoaId": 1, "userId": 1, "status": 1 });
db.hoamemberships.createIndex({ "hoaId": 1, "status": 1 });

// Users Collection
db.users.createIndex({ "isDeleted": 1 });
db.users.createIndex({ "companyId": 1, "companyRoleId": 1, "isDeleted": 1 });

// Verify indexes were created
print("\n=== Verification ===");
print("Leases indexes: " + db.leases.getIndexes().length);
print("Invoices indexes: " + db.invoices.getIndexes().length);
print("Maintenance indexes: " + db.maintenancerequests.getIndexes().length);
print("Listings indexes: " + db.listings.getIndexes().length);
print("Properties indexes: " + db.properties.getIndexes().length);
print("HOAMemberships indexes: " + db.hoamemberships.getIndexes().length);
print("Users indexes: " + db.users.getIndexes().length);
print("\nAll indexes created successfully!");
