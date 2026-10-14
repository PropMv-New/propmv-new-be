/**
 * ------------------------------------------------------------------
 * File: index.js
 * Module: Src Docs Api-schemas
 *
 * Purpose:
 * Backend utility/module providing helper functions for index.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// API Schemas for Swagger Documentation
// This file contains hardcoded request body schemas for all module APIs

const authSchemas = {
  "POST /api/v1/auth/signup": {
    schema: {
      type: "object",
      required: ["email", "password", "firstName", "lastName"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string", minLength: 10 },
        firstName: { type: "string", minLength: 1 },
        lastName: { type: "string", minLength: 1 },
        phone: { type: "string" },
        address: { type: "string" },
        state: { type: "string" },
        zipCode: { type: "string" },
        role: { type: "string" }
      },
      additionalProperties: false
    },
    example: {
      email: "user@domain.com",
      // pragma: allowlist secret - API doc example placeholder, not a real credential
      passphrase: "<your-passphrase-here>",
      firstName: "John",
      lastName: "Doe",
      phone: "+1-555-123-4567",
      address: "123 Main Street",
      state: "NY",
      zipCode: "10001",
      role: "landlord"
    }
  },
  "POST /api/v1/auth/login": {
    schema: {
      type: "object",
      required: ["email", "password"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string" }
      },
      additionalProperties: false
    },
    example: {
      email: "user@domain.com",
      // pragma: allowlist secret - API doc example placeholder, not a real credential
      passphrase: "<your-passphrase-here>"
    }
  },
  "POST /api/v1/auth/forgot-password": {
    schema: {
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string", format: "email" }
      },
      additionalProperties: false
    },
    example: {
      email: "user@domain.com"
    }
  },
  "PUT /api/v1/auth/verify-otp-reset-password": {
    schema: {
      type: "object",
      required: ["email", "otp", "newPassword", "confirmPassword"],
      properties: {
        email: { type: "string", format: "email" },
        otp: { type: "string" },
        newPassword: { type: "string" },
        confirmPassword: { type: "string" }
      },
      additionalProperties: false
    },
    example: {
      email: "user@domain.com",
      otp: "123456",
      newPassword: "<password>",
      confirmPassword: "<password>"
    }
  },
  "POST /api/v1/auth/refresh": {
    schema: {
      type: "object",
      required: ["refreshToken"],
      properties: {
        refreshToken: { type: "string" }
      },
      additionalProperties: false
    },
    example: {
      refreshToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
    }
  },
  "PUT /api/v1/auth/reset-password": {
    schema: {
      type: "object",
      required: ["currentPassword", "newPassword", "confirmPassword"],
      properties: {
        currentPassword: { type: "string" },
        newPassword: { type: "string" },
        confirmPassword: { type: "string" }
      },
      additionalProperties: false
    },
    example: {
      currentPassword: "<password>",
      newPassword: "<password>",
      confirmPassword: "<password>"
    }
  },
  "PUT /api/v1/auth/lock-account": {
    schema: {
      type: "object",
      required: ["userId"],
      properties: {
        userId: { type: "string" }
      },
      additionalProperties: false
    },
    example: {
      userId: "60f7a0b8c2a3f2b1c0d4e5f6"
    }
  },
  "PUT /api/v1/auth/unlock-account": {
    schema: {
      type: "object",
      required: ["userId"],
      properties: {
        userId: { type: "string" }
      },
      additionalProperties: false
    },
    example: {
      userId: "60f7a0b8c2a3f2b1c0d4e5f6"
    }
  }
};

const applicationSchemas = {
  "POST /api/v1/application": {
    schema: {
      type: "object",
      required: ["propertyId", "personalInformation", "addressInformation", "references", "emergencyContact"],
      properties: {
        propertyId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        personalInformation: {
          type: "object",
          required: ["firstName", "lastName", "mobileNumber", "email", "birthDate"],
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            mobileNumber: { type: "string" },
            email: { type: "string", format: "email" },
            birthDate: { type: "string", format: "date" }
          },
          additionalProperties: false
        },
        addressInformation: {
          type: "object",
          required: ["addressLine1", "city", "state", "zip"],
          properties: {
            addressLine1: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            zip: { type: "string" }
          },
          additionalProperties: false
        },
        references: {
          type: "object",
          required: ["firstName", "lastName", "mobileNumber", "email", "relation"],
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            mobileNumber: { type: "string" },
            email: { type: "string", format: "email" },
            relation: { type: "string" }
          },
          additionalProperties: false
        },
        emergencyContact: {
          type: "object",
          required: ["firstName", "lastName", "mobileNumber", "email"],
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            mobileNumber: { type: "string" },
            email: { type: "string", format: "email" }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    example: {
      propertyId: "60f7a0b8c2a3f2b1c0d4e5f6",
      personalInformation: {
        firstName: "Alice",
        lastName: "Johnson",
        mobileNumber: "+1-555-444-3333",
        email: "alice.johnson@example.com",
        birthDate: "1990-05-15"
      },
      addressInformation: {
        addressLine1: "456 Oak Avenue",
        city: "Boston",
        state: "MA",
        zip: "02101"
      },
      references: {
        firstName: "Bob",
        lastName: "Smith",
        mobileNumber: "+1-555-111-2222",
        email: "bob.smith@example.com",
        relation: "friend"
      },
      emergencyContact: {
        firstName: "Carol",
        lastName: "Johnson",
        mobileNumber: "+1-555-333-4444",
        email: "carol.johnson@example.com"
      }
    }
  },
  "PUT /api/v1/application/{id}": {
    schema: {
      type: "object",
      properties: {
        propertyId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        personalInformation: {
          type: "object",
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            mobileNumber: { type: "string" },
            email: { type: "string", format: "email" },
            birthDate: { type: "string", format: "date" }
          },
          additionalProperties: false
        },
        addressInformation: {
          type: "object",
          properties: {
            addressLine1: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            zip: { type: "string" }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    example: {
      personalInformation: {
        firstName: "Updated Name",
        email: "updated@example.com"
      }
    }
  }
};

const propertySchemas = {
  "POST /api/v1/property/properties": {
    schema: {
      type: "object",
      required: ["name", "propertyType", "ownershipType", "address", "ownerName", "ownerEmail", "ownerPhone", "ownerType", "unitDetails"],
      properties: {
        name: { type: "string" },
        propertyType: { type: "string" },
        description: { type: "string" },
        ownershipType: { type: "string" },
        address: {
          type: "object",
          required: ["street", "city", "state", "zip", "country"],
          properties: {
            street: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            zip: { type: "string" },
            country: { type: "string" }
          },
          additionalProperties: false
        },
        ownerName: { type: "string" },
        ownerEmail: { type: "string", format: "email" },
        ownerPhone: { type: "string" },
        ownerType: { type: "string" },
        unitDetails: {
          type: "array",
          items: {
            type: "object",
            required: ["unitName", "unitType", "squareFeet"],
            properties: {
              unitName: { type: "string" },
              unitType: { type: "string" },
              squareFeet: { type: "number" },
              bedRooms: { type: "number" },
              bathRoom: { type: "number" }
            },
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    example: {
      name: "Sunset Apartments",
      propertyType: "residential",
      description: "Beautiful apartment complex",
      ownershipType: "owned",
      address: {
        street: "123 Main Street",
        city: "New York",
        state: "NY",
        zip: "10001",
        country: "USA"
      },
      ownerName: "John Doe",
      ownerEmail: "owner@example.com",
      ownerPhone: "+1-555-123-4567",
      ownerType: "individual",
      unitDetails: [{
        unitName: "Unit 1A",
        unitType: "residential",
        squareFeet: 1200,
        bedRooms: 2,
        bathRoom: 1
      }]
    }
  }
};

module.exports = {
  ...authSchemas,
  ...applicationSchemas,
  ...propertySchemas
};