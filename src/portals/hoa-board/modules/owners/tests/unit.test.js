const request = require('supertest');
const app = require('../../../app');

describe('Unit API Tests', () => {
  describe('POST /api/v1/owners/units', () => {
    it('should create a unit with all required fields', async () => {
      const unitData = {
        title: 'Premium Unit',
        address: {
          line1: '456 Oak Avenue',
          line2: 'Apt 2B',
          city: 'Springfield',
          state: 'IL',
          zipCode: '62701'
        },
        startingBalance: 500,
        balanceAsOf: '2025-01-15',
        depositBankAccountId: '507f1f77bcf86cd799439012',
        tags: ['luxury', 'downtown'],
        images: [
          {
            url: 'https://example.com/image1.jpg',
            type: 'uploaded'
          }
        ],
        includeStreetView: true,
        ownerIds: ['507f1f77bcf86cd799439013']
      };

      const response = await request(app)
        .post('/api/v1/owners/units')
        .send(unitData)
        .expect(201);

      expect(response.body.statuscode).toBe(201);
      expect(response.body.message).toBe('Unit created successfully');
      expect(response.body.data.unit).toBeDefined();
      expect(response.body.data.unit.title).toBe(unitData.title);
      expect(response.body.data.unit.address.city).toBe(unitData.address.city);
    });

    it('should fail when exceeding maximum images limit', async () => {
      const unitData = {
        title: 'Unit with too many images',
        address: {
          line1: '789 Pine St',
          city: 'Somewhere',
          state: 'TX',
          zipCode: '75001'
        },
        balanceAsOf: '2025-01-01',
        depositBankAccountId: '507f1f77bcf86cd799439012',
        images: [
          { url: 'https://example.com/1.jpg', type: 'uploaded' },
          { url: 'https://example.com/2.jpg', type: 'uploaded' },
          { url: 'https://example.com/3.jpg', type: 'uploaded' },
          { url: 'https://example.com/4.jpg', type: 'uploaded' },
          { url: 'https://example.com/5.jpg', type: 'uploaded' },
          { url: 'https://example.com/6.jpg', type: 'uploaded' } // Exceeds limit of 5
        ]
      };

      const response = await request(app)
        .post('/api/v1/owners/units')
        .send(unitData)
        .expect(400);

      expect(response.body.message).toContain('5');
    });

    it('should handle negative starting balance', async () => {
      const unitData = {
        title: 'Unit with debt',
        address: {
          line1: '321 Elm St',
          city: 'Testville',
          state: 'NY',
          zipCode: '10001'
        },
        startingBalance: -1500,
        balanceAsOf: '2025-01-01',
        depositBankAccountId: '507f1f77bcf86cd799439012'
      };

      const response = await request(app)
        .post('/api/v1/owners/units')
        .send(unitData)
        .expect(201);

      expect(response.body.data.unit.startingBalance).toBe(-1500);
    });
  });
});

module.exports = {};