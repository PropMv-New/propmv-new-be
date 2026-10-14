/**
 * ------------------------------------------------------------------
 * File: verify-indexes.mongodb.js
 * Module: Db-scripts
 *
 * Purpose:
 * Backend utility/module providing helper functions for verify-indexes.mongodb.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Verify indexes exist - paste this in MongoDB Shell
use("PropMv");

print("\n=== Checking Indexes ===\n");

print("Leases indexes:");
db.leases.getIndexes().forEach(idx => print("  - " + JSON.stringify(idx.key)));

print("\nInvoices indexes:");
db.invoices.getIndexes().forEach(idx => print("  - " + JSON.stringify(idx.key)));

print("\nMaintenance indexes:");
db.maintenancerequests.getIndexes().forEach(idx => print("  - " + JSON.stringify(idx.key)));

print("\nProperties indexes:");
db.properties.getIndexes().forEach(idx => print("  - " + JSON.stringify(idx.key)));

print("\n=== Testing Query Performance ===\n");

// Test if indexes are being used
var explain = db.leases.find({ property_id: ObjectId("6942e9cea817d70dc11b5e8e") }).explain("executionStats");
print("Leases query stage: " + explain.executionStats.executionStages.stage);
print("Documents examined: " + explain.executionStats.totalDocsExamined);
print("Documents returned: " + explain.executionStats.nReturned);

if (explain.executionStats.executionStages.stage === "IXSCAN") {
    print("\nIndexes are working!");
} else {
    print("\n Indexes NOT being used - still doing COLLSCAN!");
}
