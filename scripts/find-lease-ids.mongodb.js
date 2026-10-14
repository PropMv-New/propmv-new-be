/**
 * ------------------------------------------------------------------
 * File: find-lease-ids.mongodb.js
 * Module: Admin Scripts
 *
 * Purpose:
 * Administrative script for database sync, testing, or system maintenance tasks.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// MongoDB Shell Script to Find Valid Lease and Tenant IDs
// Run this in MongoDB Compass or mongo shell

// Connect to your database first
// use propmv

// Find the first 5 leases
print("=== Finding Leases ===\n");

db.leases.find({}).limit(5).forEach(function(lease) {
    print("Lease ID: " + lease._id);
    print("Status: " + (lease.status || "N/A"));
    print("Property ID: " + (lease.property_id || "N/A"));
    
    if (lease.rentAndDepositDestribution && lease.rentAndDepositDestribution.split) {
        print("Tenants:");
        lease.rentAndDepositDestribution.split.forEach(function(s, idx) {
            var tenantId = s.tenantId;
            print("  Tenant " + (idx + 1) + " ID: " + tenantId);
        });
        
        // Generate screening URL
        var firstTenantId = lease.rentAndDepositDestribution.split[0].tenantId;
        print("\nScreening URL:");
        print("http://localhost:8080/application/screening?leaseId=" + lease._id + "&tenantId=" + firstTenantId);
    }
    print("\n" + "=".repeat(50) + "\n");
});

// Count total leases
var totalLeases = db.leases.countDocuments();
print("Total leases in database: " + totalLeases);

if (totalLeases === 0) {
    print("\n No leases found!");
    print("You need to create a lease first through the application.");
}
