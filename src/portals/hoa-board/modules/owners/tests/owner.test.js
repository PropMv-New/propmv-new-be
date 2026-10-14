const request = require('supertest');
const app = require('../../../app');

describe('Owner API Tests', () => {
  describe('POST /api/v1/owners', () => {
    it('should create a new owner successfully', async () => {
      const ownerData = {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john.doe@example.com',
        phone: '+1234567890',
        hasUnits: false,
        sendInvite: true
      };

      const response = await request(app)
        .post('/api/v1/owners')
        .send(ownerData)
        .expect(201);

      expect(response.body.message).toBe('Owner created successfully');
      expect(response.body.data.owner).toBeDefined();
      expect(response.body.data.owner.email).toBe(ownerData.email);
    });

    it('should fail with missing required fields', async () => {
      const ownerData = {
        email: 'john.doe@example.com'
        // Missing firstName and lastName
      };

      const response = await request(app)
        .post('/api/v1/owners')
        .send(ownerData)
        .expect(400);

      expect(response.body.message).toContain('required');
    });
  });

  describe('POST /api/v1/owners/units', () => {
    it('should create a new unit successfully', async () => {
      const unitData = {
        title: 'Unit A-101',
        address: {
          line1: '123 Main St',
          city: 'Anytown',
          state: 'CA',
          zipCode: '12345'
        },
        startingBalance: -200,
        balanceAsOf: '2025-01-01',
        depositBankAccountId: '507f1f77bcf86cd799439012',
        tags: ['corner', 'premium']
      };

      const response = await request(app)
        .post('/api/v1/owners/units')
        .send(unitData)
        .expect(201);

      expect(response.body.message).toBe('Unit created successfully');
      expect(response.body.data.unit).toBeDefined();
      expect(response.body.data.unit.title).toBe(unitData.title);
    });

    it('should fail with missing required address fields', async () => {
      const unitData = {
        title: 'Unit A-101',
        address: {
          line1: '123 Main St'
          // Missing city, state, zipCode
        },
        balanceAsOf: '2025-01-01',
        depositBankAccountId: '507f1f77bcf86cd799439012'
      };

      const response = await request(app)
        .post('/api/v1/owners/units')
        .send(unitData)
        .expect(400);

      expect(response.body.message).toContain('required');
    });
  });
});

module.exports = {};