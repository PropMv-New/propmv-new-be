/**
 * Test file for Tenant Listing API
 * This file contains sample test cases for the new tenant listing endpoint
 */

const request = require('supertest');
const app = require('../../../app'); // Adjust path as needed

describe('Tenant Listing API', () => {
  let authToken;
  let testTenantId;
  let testPropertyId;

  beforeAll(async () => {
    // Setup authentication token
    // This would typically involve logging in and getting a JWT token
    // authToken = await getAuthToken();
  });

  describe('GET /api/v1/tenants/list-with-details', () => {
    test('should return paginated tenant list', async () => {
      const response = await request(app)
        .get('/api/v1/tenants/list-with-details')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          pageSize: 10,
          page: 1
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('data');
      expect(response.body.data).toHaveProperty('total');
      expect(response.body.data).toHaveProperty('page');
      expect(response.body.data).toHaveProperty('pageSize');
      expect(Array.isArray(response.body.data.data)).toBe(true);
    });

    test('should filter by property ID', async () => {
      const response = await request(app)
        .get('/api/v1/tenants/list-with-details')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          propertyId: testPropertyId,
          pageSize: 10
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      
      // All returned tenants should be associated with the specified property
      response.body.data.data.forEach(tenant => {
        expect(tenant).toHaveProperty('propertyName');
        expect(tenant).toHaveProperty('unitName');
      });
    });

    test('should filter by tenant ID', async () => {
      const response = await request(app)
        .get('/api/v1/tenants/list-with-details')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          tenantId: testTenantId
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.data.length).toBeLessThanOrEqual(1);
      
      if (response.body.data.data.length > 0) {
        expect(response.body.data.data[0].tenantId).toBe(testTenantId);
      }
    });

    test('should return correct response structure', async () => {
      const response = await request(app)
        .get('/api/v1/tenants/list-with-details')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ pageSize: 1 });

      expect(response.status).toBe(200);
      
      if (response.body.data.data.length > 0) {
        const tenant = response.body.data.data[0];
        expect(tenant).toHaveProperty('tenantId');
        expect(tenant).toHaveProperty('name');
        expect(tenant).toHaveProperty('propertyName');
        expect(tenant).toHaveProperty('unitName');
        expect(tenant).toHaveProperty('address');
        expect(tenant).toHaveProperty('accountStatus');
        expect(tenant).toHaveProperty('tenantStatus');
        expect(tenant).toHaveProperty('rent');
        expect(tenant).toHaveProperty('roommates');
        
        // Validate data types
        expect(typeof tenant.tenantId).toBe('string');
        expect(typeof tenant.name).toBe('string');
        expect(typeof tenant.propertyName).toBe('string');
        expect(typeof tenant.unitName).toBe('string');
        expect(typeof tenant.address).toBe('string');
        expect(typeof tenant.accountStatus).toBe('string');
        expect(typeof tenant.tenantStatus).toBe('string');
        expect(typeof tenant.rent).toBe('number');
        expect(typeof tenant.roommates).toBe('number');
      }
    });

    test('should handle invalid ObjectId format', async () => {
      const response = await request(app)
        .get('/api/v1/tenants/list-with-details')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          tenantId: 'invalid-id'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    test('should handle pagination correctly', async () => {
      const page1Response = await request(app)
        .get('/api/v1/tenants/list-with-details')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          pageSize: 5,
          page: 1
        });

      const page2Response = await request(app)
        .get('/api/v1/tenants/list-with-details')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          pageSize: 5,
          page: 2
        });

      expect(page1Response.status).toBe(200);
      expect(page2Response.status).toBe(200);
      
      expect(page1Response.body.data.page).toBe(1);
      expect(page2Response.body.data.page).toBe(2);
      
      expect(page1Response.body.data.pageSize).toBe(5);
      expect(page2Response.body.data.pageSize).toBe(5);
    });
  });
});

// Helper function to get authentication token
async function getAuthToken() {
  // Implementation would depend on your authentication system
  // This is just a placeholder
  return 'mock-jwt-token';
}

module.exports = {
  getAuthToken
};