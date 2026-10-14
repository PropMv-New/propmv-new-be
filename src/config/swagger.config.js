/**
 * ------------------------------------------------------------------
 * File: swagger.config.js
 * Module: Src Config
 *
 * Purpose:
 * Configuration settings, variables mapping, and constants definitions.
 *
 * Used By:
 * app
 * ------------------------------------------------------------------
 */


const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");
const path = require("path");
const fs = require('fs');
const Joi = require('joi');
const swaggerSchemas = require('../docs/swagger-schemas');
const completeApiSchemas = require('../docs/api-schemas/complete-api-schemas');
const logger = require('../common/logger');

// Use complete API schemas as primary source, fallback to existing schemas
const allSchemas = { ...swaggerSchemas, ...completeApiSchemas };

const swaggerDefinition = {
    "openapi": "3.0.3",
    "info": {
        "title": "PropMv - Property Management API",
        "version": "1.0.0",
        "description": "API for the PropMv property management platform.\n\nPortals and shared surfaces are mounted under `/api/v1`: `auth`, `users`, `hoa` (HOA board), `landlord`, `payments`, `documents`, `company`, and `address`.\n\nSuccessful JSON responses use one envelope: `{ message, statuscode, data }`. Send `Authorization: Bearer <accessToken>` except on the public auth, address autocomplete, marketing capture, health, and webhook routes.\n\nHOA module routes are grouped as `hoa-<module>` and landlord routes as `landlord-<module>`.",
        contact: {
            name: "PropMv Dev Team",
            email: "support@propmv.io",
        },
    },
    "servers": [
        {
            "url": "https://api.propmv.com",
            "description": "Production"
        },
        {
            "url": "http://localhost:5000",
            "description": "Local"
        }
    ],
    "paths": {
        "/api/v1/auth/login": {
            "post": {
                "tags": ["auth"],
                "summary": "User login",
                "security": [],
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["email", "password"],
                                "properties": {
                                    "email": { "type": "string", "format": "email" },
                                    "password": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "email": "user@domain.com",
                                "password": "<password>"
                            }
                        }
                    }
                },
                "responses": { "200": { "description": "Login successful" } }
            }
        },
        "/api/v1/auth/signup": {
            "post": {
                "tags": ["auth"],
                "summary": "User signup",
                "security": [],
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["email", "password", "firstName", "lastName"],
                                "properties": {
                                    "email": { "type": "string", "format": "email" },
                                    "password": { "type": "string" },
                                    "firstName": { "type": "string" },
                                    "lastName": { "type": "string" },
                                    "phone": { "type": "string" },
                                    "address": { "type": "string" },
                                    "state": { "type": "string" },
                                    "zipCode": { "type": "string" },
                                    "role": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "email": "user@domain.com",
                                "password": "<password>",
                                "firstName": "John",
                                "lastName": "Doe",
                                "phone": "+1-555-123-4567",
                                "address": "123 Main Street",
                                "state": "NY",
                                "zipCode": "10001",
                                "role": "landlord"
                            }
                        }
                    }
                },
                "responses": { "201": { "description": "User created" } }
            }
        },
        "/api/v1/property/properties": {
            "post": {
                "tags": ["property"],
                "summary": "Create property",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["name", "propertyType", "ownershipType", "address", "ownerName", "ownerEmail", "ownerPhone", "ownerType", "unitDetails"],
                                "properties": {
                                    "name": { "type": "string" },
                                    "propertyType": { "type": "string" },
                                    "description": { "type": "string" },
                                    "ownershipType": { "type": "string" },
                                    "address": {
                                        "type": "object",
                                        "required": ["street", "city", "state", "zip", "country"],
                                        "properties": {
                                            "street": { "type": "string" },
                                            "city": { "type": "string" },
                                            "state": { "type": "string" },
                                            "zip": { "type": "string" },
                                            "country": { "type": "string" }
                                        },
                                        "additionalProperties": false
                                    },
                                    "ownerName": { "type": "string" },
                                    "ownerEmail": { "type": "string", "format": "email" },
                                    "ownerPhone": { "type": "string" },
                                    "ownerType": { "type": "string" },
                                    "unitDetails": {
                                        "type": "array",
                                        "items": {
                                            "type": "object",
                                            "required": ["unitName", "unitType", "squareFeet"],
                                            "properties": {
                                                "unitName": { "type": "string" },
                                                "unitType": { "type": "string" },
                                                "squareFeet": { "type": "number" },
                                                "bedRooms": { "type": "number" },
                                                "bathRoom": { "type": "number" }
                                            },
                                            "additionalProperties": false
                                        }
                                    }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "name": "Sunset Apartments",
                                "propertyType": "residential",
                                "description": "Beautiful apartment complex",
                                "ownershipType": "owned",
                                "address": {
                                    "street": "123 Main Street",
                                    "city": "New York",
                                    "state": "NY",
                                    "zip": "10001",
                                    "country": "USA"
                                },
                                "ownerName": "John Doe",
                                "ownerEmail": "owner@example.com",
                                "ownerPhone": "+1-555-123-4567",
                                "ownerType": "individual",
                                "unitDetails": [{
                                    "unitName": "Unit 1A",
                                    "unitType": "residential",
                                    "squareFeet": 1200,
                                    "bedRooms": 2,
                                    "bathRoom": 1
                                }]
                            }
                        }
                    }
                },
                "responses": { "201": { "description": "Property created" } }
            }
        },
        "/api/v1/tenants": {
            "post": {
                "tags": ["tenants"],
                "summary": "Create tenant",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["firstName", "lastName", "email", "phone"],
                                "properties": {
                                    "firstName": { "type": "string" },
                                    "lastName": { "type": "string" },
                                    "email": { "type": "string", "format": "email" },
                                    "phone": { "type": "string" },
                                    "address": { "type": "string" },
                                    "dateOfBirth": { "type": "string", "format": "date" },
                                    "emergencyContact": {
                                        "type": "object",
                                        "properties": {
                                            "name": { "type": "string" },
                                            "phone": { "type": "string" },
                                            "relationship": { "type": "string" }
                                        },
                                        "additionalProperties": false
                                    }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "firstName": "Jane",
                                "lastName": "Smith",
                                "email": "jane.smith@example.com",
                                "phone": "+1-555-987-6543",
                                "address": "456 Oak Avenue",
                                "dateOfBirth": "1985-03-20",
                                "emergencyContact": {
                                    "name": "John Smith",
                                    "phone": "+1-555-111-2222",
                                    "relationship": "spouse"
                                }
                            }
                        }
                    }
                },
                "responses": { "201": { "description": "Tenant created" } }
            }
        },
        "/api/v1/maintenance/request": {
            "post": {
                "tags": ["maintenance"],
                "summary": "Create maintenance request",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["propertyId", "tenantId", "description", "priority"],
                                "properties": {
                                    "propertyId": { "type": "string" },
                                    "tenantId": { "type": "string" },
                                    "description": { "type": "string" },
                                    "priority": { "type": "string", "enum": ["low", "medium", "high", "urgent"] },
                                    "category": { "type": "string" },
                                    "location": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "propertyId": "60f7a0b8c2a3f2b1c0d4e5f6",
                                "tenantId": "60f7a0b8c2a3f2b1c0d4e5f7",
                                "description": "Leaky faucet in kitchen",
                                "priority": "medium",
                                "category": "plumbing",
                                "location": "kitchen"
                            }
                        }
                    }
                },
                "responses": { "201": { "description": "Maintenance request created" } }
            }
        },
        "/api/v1/expense": {
            "post": {
                "tags": ["expense"],
                "summary": "Create expense",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["category", "vendor", "amount", "totalAmount"],
                                "properties": {
                                    "category": { "type": "string" },
                                    "vendor": { "type": "string" },
                                    "vendorEmail": { "type": "string", "format": "email" },
                                    "propertyId": { "type": "string" },
                                    "amount": { "type": "number", "minimum": 0 },
                                    "tax": { "type": "number", "minimum": 0 },
                                    "totalAmount": { "type": "number", "minimum": 0 },
                                    "status": { "type": "string", "enum": ["pending", "paid", "unpaid", "overdue"] },
                                    "expenseDate": { "type": "string", "format": "date" },
                                    "memo": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "category": "maintenance",
                                "vendor": "ABC Plumbing Services",
                                "vendorEmail": "john@abcplumbing.com",
                                "propertyId": "60f7a0b8c2a3f2b1c0d4e5f6",
                                "amount": 250,
                                "tax": 25,
                                "totalAmount": 275,
                                "status": "pending",
                                "expenseDate": "2024-01-15",
                                "memo": "Fixed leaky faucet in kitchen"
                            }
                        }
                    }
                },
                "responses": { "201": { "description": "Expense created" } }
            }
        },
        "/api/v1/invoice": {
            "post": {
                "tags": ["invoice"],
                "summary": "Create invoice",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["tenantId", "propertyId", "amount", "dueDate", "description"],
                                "properties": {
                                    "tenantId": { "type": "string" },
                                    "propertyId": { "type": "string" },
                                    "amount": { "type": "number", "minimum": 0 },
                                    "dueDate": { "type": "string", "format": "date" },
                                    "description": { "type": "string" },
                                    "invoiceType": { "type": "string" },
                                    "status": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "tenantId": "60f7a0b8c2a3f2b1c0d4e5f7",
                                "propertyId": "60f7a0b8c2a3f2b1c0d4e5f6",
                                "amount": 1500,
                                "dueDate": "2024-02-01",
                                "description": "Monthly rent for January 2024",
                                "invoiceType": "rent",
                                "status": "pending"
                            }
                        }
                    }
                },
                "responses": { "201": { "description": "Invoice created" } }
            }
        },
        "/api/v1/leasing/lease": {
            "post": {
                "tags": ["leasing"],
                "summary": "Create lease",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["propertyId", "tenantId", "startDate", "endDate", "rentAmount"],
                                "properties": {
                                    "propertyId": { "type": "string" },
                                    "tenantId": { "type": "string" },
                                    "startDate": { "type": "string", "format": "date" },
                                    "endDate": { "type": "string", "format": "date" },
                                    "rentAmount": { "type": "number", "minimum": 0 },
                                    "securityDeposit": { "type": "number", "minimum": 0 },
                                    "terms": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "propertyId": "60f7a0b8c2a3f2b1c0d4e5f6",
                                "tenantId": "60f7a0b8c2a3f2b1c0d4e5f7",
                                "startDate": "2024-01-01",
                                "endDate": "2024-12-31",
                                "rentAmount": 1500,
                                "securityDeposit": 1500,
                                "terms": "Standard lease terms and conditions"
                            }
                        }
                    }
                },
                "responses": { "201": { "description": "Lease created" } }
            }
        },
        "/api/v1/auth/forgot-password": {
            "post": {
                "tags": ["auth"],
                "summary": "Forgot password",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["email"],
                                "properties": {
                                    "email": { "type": "string", "format": "email" }
                                },
                                "additionalProperties": false
                            },
                            "example": { "email": "user@example.com" }
                        }
                    }
                },
                "responses": { "200": { "description": "Reset email sent" } }
            }
        },
        "/api/v1/auth/verify-otp-reset-password": {
            "put": {
                "tags": ["auth"],
                "summary": "Verify OTP and reset password",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["email", "otp", "newPassword", "confirmPassword"],
                                "properties": {
                                    "email": { "type": "string", "format": "email" },
                                    "otp": { "type": "string" },
                                    "newPassword": { "type": "string" },
                                    "confirmPassword": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "email": "user@domain.com",
                                "otp": "123456",
                                "newPassphrase": "<new-password>",
                                "confirmPassphrase": "<new-password>"
                            }
                        }
                    }
                },
                "responses": { "200": { "description": "Password reset successful" } }
            }
        },
        "/api/v1/auth/reset-password": {
            "put": {
                "tags": ["auth"],
                "summary": "Reset password",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["currentPassword", "newPassword", "confirmPassword"],
                                "properties": {
                                    "currentPassword": { "type": "string" },
                                    "newPassword": { "type": "string" },
                                    "confirmPassword": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "currentPassphrase": "<current-password>",
                                "newPassphrase": "<new-password>",
                                "confirmPassphrase": "<new-password>"
                            }
                        }
                    }
                },
                "responses": { "200": { "description": "Password updated" } }
            }
        },
        "/api/v1/auth/refresh": {
            "post": {
                "tags": ["auth"],
                "summary": "Refresh token",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["refreshToken"],
                                "properties": {
                                    "refreshToken": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": { "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }
                        }
                    }
                },
                "responses": { "200": { "description": "Token refreshed" } }
            }
        },
        "/api/v1/auth/roles": {
            "post": {
                "tags": ["auth"],
                "summary": "Create role",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["name", "functions"],
                                "properties": {
                                    "name": { "type": "string" },
                                    "description": { "type": "string" },
                                    "functions": { "type": "array", "items": { "type": "string" } }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "name": "Property Manager",
                                "description": "Manages properties and tenants",
                                "functions": ["60f7a0b8c2a3f2b1c0d4e5f6", "60f7a0b8c2a3f2b1c0d4e5f7"]
                            }
                        }
                    }
                },
                "responses": { "201": { "description": "Role created" } }
            }
        },
        "/api/v1/auth/functions": {
            "post": {
                "tags": ["auth"],
                "summary": "Create function",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["name"],
                                "properties": {
                                    "name": { "type": "string" },
                                    "description": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "name": "Create Property",
                                "description": "Allows creating new properties"
                            }
                        }
                    }
                },
                "responses": { "201": { "description": "Function created" } }
            }
        },
        "/api/v1/tenants/setup": {
            "post": {
                "tags": ["tenants"],
                "summary": "Setup tenant account",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["tenantId", "password"],
                                "properties": {
                                    "tenantId": { "type": "string" },
                                    "password": { "type": "string" },
                                    "confirmPassword": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "tenantId": "60f7a0b8c2a3f2b1c0d4e5f6",
                                "password": "<password>",
                                "confirmPassword": "<password>"
                            }
                        }
                    }
                },
                "responses": { "200": { "description": "Tenant account setup" } }
            }
        },
        "/api/v1/tenants/resend-invite": {
            "post": {
                "tags": ["tenants"],
                "summary": "Resend tenant invite",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["tenantId"],
                                "properties": {
                                    "tenantId": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": { "tenantId": "60f7a0b8c2a3f2b1c0d4e5f6" }
                        }
                    }
                },
                "responses": { "200": { "description": "Invite resent" } }
            }
        },
        "/api/v1/leasing/template": {
            "post": {
                "tags": ["leasing"],
                "summary": "Create lease template",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["name", "content"],
                                "properties": {
                                    "name": { "type": "string" },
                                    "content": { "type": "string" },
                                    "description": { "type": "string" },
                                    "category": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "name": "Standard Lease Agreement",
                                "content": "This lease agreement is entered into...",
                                "description": "Standard residential lease template",
                                "category": "lease"
                            }
                        }
                    }
                },
                "responses": { "201": { "description": "Template created" } }
            }
        },
        "/api/v1/events/events": {
            "post": {
                "tags": ["events"],
                "summary": "Create event",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["title", "description", "startDate", "endDate"],
                                "properties": {
                                    "title": { "type": "string" },
                                    "description": { "type": "string" },
                                    "startDate": { "type": "string", "format": "date-time" },
                                    "endDate": { "type": "string", "format": "date-time" },
                                    "propertyId": { "type": "string" },
                                    "tenantId": { "type": "string" },
                                    "eventType": { "type": "string" },
                                    "location": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "title": "Property Inspection",
                                "description": "Annual property inspection",
                                "startDate": "2024-02-15T10:00:00Z",
                                "endDate": "2024-02-15T12:00:00Z",
                                "propertyId": "60f7a0b8c2a3f2b1c0d4e5f6",
                                "eventType": "inspection",
                                "location": "Unit 1A"
                            }
                        }
                    }
                },
                "responses": { "201": { "description": "Event created" } }
            }
        },
        "/api/v1/master/masterData": {
            "post": {
                "tags": ["master"],
                "summary": "Create master data",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["type", "value"],
                                "properties": {
                                    "type": { "type": "string" },
                                    "value": { "type": "string" },
                                    "description": { "type": "string" },
                                    "category": { "type": "string" },
                                    "isActive": { "type": "boolean" }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "type": "property_type",
                                "value": "apartment",
                                "description": "Multi-unit residential building",
                                "category": "property",
                                "isActive": true
                            }
                        }
                    }
                },
                "responses": { "201": { "description": "Master data created" } }
            }
        },
        "/api/v1/users/userProfile": {
            "put": {
                "tags": ["users"],
                "summary": "Update user profile",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "firstName": { "type": "string" },
                                    "lastName": { "type": "string" },
                                    "phone": { "type": "string" },
                                    "address": { "type": "string" },
                                    "state": { "type": "string" },
                                    "zipCode": { "type": "string" },
                                    "bio": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "firstName": "John",
                                "lastName": "Doe",
                                "phone": "+1-555-123-4567",
                                "address": "123 Main Street",
                                "state": "NY",
                                "zipCode": "10001",
                                "bio": "Experienced property manager"
                            }
                        }
                    }
                },
                "responses": { "200": { "description": "Profile updated" } }
            }
        },
        "/api/v1/application": {
            "post": {
                "tags": ["application"],
                "summary": "Create application",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["propertyId", "personalInformation", "addressInformation", "references", "emergencyContact"],
                                "properties": {
                                    "propertyId": { "type": "string" },
                                    "personalInformation": {
                                        "type": "object",
                                        "required": ["firstName", "lastName", "mobileNumber", "email", "birthDate"],
                                        "properties": {
                                            "firstName": { "type": "string" },
                                            "lastName": { "type": "string" },
                                            "mobileNumber": { "type": "string" },
                                            "email": { "type": "string", "format": "email" },
                                            "birthDate": { "type": "string", "format": "date" }
                                        },
                                        "additionalProperties": false
                                    },
                                    "addressInformation": {
                                        "type": "object",
                                        "required": ["addressLine1", "city", "state", "zip"],
                                        "properties": {
                                            "addressLine1": { "type": "string" },
                                            "city": { "type": "string" },
                                            "state": { "type": "string" },
                                            "zip": { "type": "string" }
                                        },
                                        "additionalProperties": false
                                    },
                                    "references": {
                                        "type": "object",
                                        "required": ["firstName", "lastName", "mobileNumber", "email", "relation"],
                                        "properties": {
                                            "firstName": { "type": "string" },
                                            "lastName": { "type": "string" },
                                            "mobileNumber": { "type": "string" },
                                            "email": { "type": "string", "format": "email" },
                                            "relation": { "type": "string" }
                                        },
                                        "additionalProperties": false
                                    },
                                    "emergencyContact": {
                                        "type": "object",
                                        "required": ["firstName", "lastName", "mobileNumber", "email"],
                                        "properties": {
                                            "firstName": { "type": "string" },
                                            "lastName": { "type": "string" },
                                            "mobileNumber": { "type": "string" },
                                            "email": { "type": "string", "format": "email" }
                                        },
                                        "additionalProperties": false
                                    }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "propertyId": "60f7a0b8c2a3f2b1c0d4e5f6",
                                "personalInformation": {
                                    "firstName": "Alice",
                                    "lastName": "Johnson",
                                    "mobileNumber": "+1-555-444-3333",
                                    "email": "alice.johnson@example.com",
                                    "birthDate": "1990-05-15"
                                },
                                "addressInformation": {
                                    "addressLine1": "456 Oak Avenue",
                                    "city": "Boston",
                                    "state": "MA",
                                    "zip": "02101"
                                },
                                "references": {
                                    "firstName": "Bob",
                                    "lastName": "Smith",
                                    "mobileNumber": "+1-555-111-2222",
                                    "email": "bob.smith@example.com",
                                    "relation": "friend"
                                },
                                "emergencyContact": {
                                    "firstName": "Carol",
                                    "lastName": "Johnson",
                                    "mobileNumber": "+1-555-333-4444",
                                    "email": "carol.johnson@example.com"
                                }
                            }
                        }
                    }
                },
                "responses": { "201": { "description": "Application created" } }
            },
            "get": {
                "tags": ["application"],
                "summary": "List applications",
                "responses": { "200": { "description": "Applications list" } }
            }
        },
        "/api/v1/application/{id}": {
            "get": {
                "tags": ["application"],
                "summary": "Get application by ID",
                "parameters": [{
                    "name": "id",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string" }
                }],
                "responses": { "200": { "description": "Application details" } }
            },
            "put": {
                "tags": ["application"],
                "summary": "Update application",
                "parameters": [{
                    "name": "id",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string" }
                }],
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "personalInformation": {
                                        "type": "object",
                                        "properties": {
                                            "firstName": { "type": "string" },
                                            "lastName": { "type": "string" },
                                            "mobileNumber": { "type": "string" },
                                            "email": { "type": "string", "format": "email" },
                                            "birthDate": { "type": "string", "format": "date" }
                                        },
                                        "additionalProperties": false
                                    },
                                    "addressInformation": {
                                        "type": "object",
                                        "properties": {
                                            "addressLine1": { "type": "string" },
                                            "city": { "type": "string" },
                                            "state": { "type": "string" },
                                            "zip": { "type": "string" }
                                        },
                                        "additionalProperties": false
                                    }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "personalInformation": {
                                    "firstName": "Updated Name",
                                    "email": "updated@example.com"
                                }
                            }
                        }
                    }
                },
                "responses": { "200": { "description": "Application updated" } }
            },
            "delete": {
                "tags": ["application"],
                "summary": "Delete application",
                "parameters": [{
                    "name": "id",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string" }
                }],
                "responses": { "200": { "description": "Application deleted" } }
            }
        },
        "/api/v1/application/{id}/screening": {
            "patch": {
                "tags": ["application"],
                "summary": "Update screening information",
                "parameters": [{
                    "name": "id",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string" },
                    "description": "Application ID",
                    "example": "60f7a0b8c2a3f2b1c0d4e5f6"
                }],
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "creditScore": { "type": "number", "minimum": 300, "maximum": 850 },
                                    "backgroundCheckStatus": { "type": "string", "enum": ["pending", "passed", "failed"] },
                                    "incomeVerified": { "type": "boolean" },
                                    "screeningNotes": { "type": "string" }
                                },
                                "additionalProperties": false
                            },
                            "example": {
                                "creditScore": 750,
                                "backgroundCheckStatus": "passed",
                                "incomeVerified": true,
                                "screeningNotes": "Excellent candidate"
                            }
                        }
                    }
                },
                "responses": { "200": { "description": "Screening updated" } }
            }
        },
        "/api/v1/property/properties": {
            "get": {
                "tags": ["property"],
                "summary": "Get properties with filters",
                "parameters": [
                    {
                        "name": "pageNumber",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "integer", "minimum": 1 },
                        "description": "Page number for pagination",
                        "example": 1
                    },
                    {
                        "name": "pageSize",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "integer", "minimum": 1 },
                        "description": "Number of items per page",
                        "example": 10
                    },
                    {
                        "name": "landlordId",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string" },
                        "description": "Filter by landlord ID",
                        "example": "60f7a0b8c2a3f2b1c0d4e5f6"
                    },
                    {
                        "name": "status",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string" },
                        "description": "Filter by property status",
                        "example": "active"
                    },
                    {
                        "name": "city",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string" },
                        "description": "Filter by city",
                        "example": "New York"
                    },
                    {
                        "name": "state",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string" },
                        "description": "Filter by state",
                        "example": "NY"
                    },
                    {
                        "name": "search",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string" },
                        "description": "Search term for properties",
                        "example": "apartment"
                    }
                ],
                "responses": { "200": { "description": "Properties retrieved successfully" } }
            }
        },
        "/api/v1/property/properties/{id}": {
            "get": {
                "tags": ["property"],
                "summary": "Get property by ID",
                "parameters": [{
                    "name": "id",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string" },
                    "description": "Property ID",
                    "example": "60f7a0b8c2a3f2b1c0d4e5f6"
                }],
                "responses": { "200": { "description": "Property details" } }
            }
        },
        "/api/v1/tenants": {
            "get": {
                "tags": ["tenants"],
                "summary": "Get tenants with filters",
                "parameters": [
                    {
                        "name": "pageNumber",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "integer", "minimum": 1 },
                        "description": "Page number for pagination",
                        "example": 1
                    },
                    {
                        "name": "pageSize",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "integer", "minimum": 1 },
                        "description": "Number of items per page",
                        "example": 10
                    },
                    {
                        "name": "propertyId",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string" },
                        "description": "Filter by property ID",
                        "example": "60f7a0b8c2a3f2b1c0d4e5f6"
                    },
                    {
                        "name": "search",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string" },
                        "description": "Search term for tenants",
                        "example": "john"
                    }
                ],
                "responses": { "200": { "description": "Tenants retrieved successfully" } }
            }
        },
        "/api/v1/tenants/{id}": {
            "get": {
                "tags": ["tenants"],
                "summary": "Get tenant by ID",
                "parameters": [{
                    "name": "id",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string" },
                    "description": "Tenant ID",
                    "example": "60f7a0b8c2a3f2b1c0d4e5f6"
                }],
                "responses": { "200": { "description": "Tenant details" } }
            }
        },
        "/api/v1/maintenance/request": {
            "get": {
                "tags": ["maintenance"],
                "summary": "Get maintenance requests",
                "parameters": [
                    {
                        "name": "pageNumber",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "integer", "minimum": 1 },
                        "description": "Page number for pagination",
                        "example": 1
                    },
                    {
                        "name": "pageSize",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "integer", "minimum": 1 },
                        "description": "Number of items per page",
                        "example": 10
                    },
                    {
                        "name": "propertyId",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string" },
                        "description": "Filter by property ID",
                        "example": "60f7a0b8c2a3f2b1c0d4e5f6"
                    },
                    {
                        "name": "status",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string", "enum": ["open", "in_progress", "completed", "cancelled"] },
                        "description": "Filter by status",
                        "example": "open"
                    },
                    {
                        "name": "priority",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string", "enum": ["low", "medium", "high", "urgent"] },
                        "description": "Filter by priority",
                        "example": "high"
                    }
                ],
                "responses": { "200": { "description": "Maintenance requests retrieved successfully" } }
            }
        },
        "/api/v1/maintenance/request/{id}": {
            "get": {
                "tags": ["maintenance"],
                "summary": "Get maintenance request by ID",
                "parameters": [{
                    "name": "id",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string" },
                    "description": "Maintenance request ID",
                    "example": "60f7a0b8c2a3f2b1c0d4e5f6"
                }],
                "responses": { "200": { "description": "Maintenance request details" } }
            }
        },
        "/api/v1/expense": {
            "get": {
                "tags": ["expense"],
                "summary": "Get expenses with filters",
                "parameters": [
                    {
                        "name": "pageNumber",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "integer", "minimum": 1 },
                        "description": "Page number for pagination",
                        "example": 1
                    },
                    {
                        "name": "pageSize",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "integer", "minimum": 1 },
                        "description": "Number of items per page",
                        "example": 10
                    },
                    {
                        "name": "propertyId",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string" },
                        "description": "Filter by property ID",
                        "example": "60f7a0b8c2a3f2b1c0d4e5f6"
                    },
                    {
                        "name": "category",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string" },
                        "description": "Filter by expense category",
                        "example": "maintenance"
                    },
                    {
                        "name": "status",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string", "enum": ["pending", "paid", "unpaid", "overdue"] },
                        "description": "Filter by expense status",
                        "example": "pending"
                    }
                ],
                "responses": { "200": { "description": "Expenses retrieved successfully" } }
            }
        },
        "/api/v1/expense/{id}": {
            "get": {
                "tags": ["expense"],
                "summary": "Get expense by ID",
                "parameters": [{
                    "name": "id",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string" },
                    "description": "Expense ID",
                    "example": "60f7a0b8c2a3f2b1c0d4e5f6"
                }],
                "responses": { "200": { "description": "Expense details" } }
            }
        },
        "/api/v1/invoice": {
            "get": {
                "tags": ["invoice"],
                "summary": "Get invoices with filters",
                "parameters": [
                    {
                        "name": "pageNumber",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "integer", "minimum": 1 },
                        "description": "Page number for pagination",
                        "example": 1
                    },
                    {
                        "name": "pageSize",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "integer", "minimum": 1 },
                        "description": "Number of items per page",
                        "example": 10
                    },
                    {
                        "name": "tenantId",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string" },
                        "description": "Filter by tenant ID",
                        "example": "60f7a0b8c2a3f2b1c0d4e5f6"
                    },
                    {
                        "name": "propertyId",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string" },
                        "description": "Filter by property ID",
                        "example": "60f7a0b8c2a3f2b1c0d4e5f6"
                    },
                    {
                        "name": "status",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string", "enum": ["pending", "paid", "overdue", "cancelled"] },
                        "description": "Filter by invoice status",
                        "example": "pending"
                    }
                ],
                "responses": { "200": { "description": "Invoices retrieved successfully" } }
            }
        },
        "/api/v1/invoice/{id}": {
            "get": {
                "tags": ["invoice"],
                "summary": "Get invoice by ID",
                "parameters": [{
                    "name": "id",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string" },
                    "description": "Invoice ID",
                    "example": "60f7a0b8c2a3f2b1c0d4e5f6"
                }],
                "responses": { "200": { "description": "Invoice details" } }
            }
        },
        "/api/v1/leasing/lease": {
            "get": {
                "tags": ["leasing"],
                "summary": "Get leases with filters",
                "parameters": [
                    {
                        "name": "pageNumber",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "integer", "minimum": 1 },
                        "description": "Page number for pagination",
                        "example": 1
                    },
                    {
                        "name": "pageSize",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "integer", "minimum": 1 },
                        "description": "Number of items per page",
                        "example": 10
                    },
                    {
                        "name": "propertyId",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string" },
                        "description": "Filter by property ID",
                        "example": "60f7a0b8c2a3f2b1c0d4e5f6"
                    },
                    {
                        "name": "tenantId",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string" },
                        "description": "Filter by tenant ID",
                        "example": "60f7a0b8c2a3f2b1c0d4e5f6"
                    },
                    {
                        "name": "status",
                        "in": "query",
                        "required": false,
                        "schema": { "type": "string", "enum": ["active", "expired", "terminated", "pending"] },
                        "description": "Filter by lease status",
                        "example": "active"
                    }
                ],
                "responses": { "200": { "description": "Leases retrieved successfully" } }
            }
        },
        "/api/v1/leasing/lease/{id}": {
            "get": {
                "tags": ["leasing"],
                "summary": "Get lease by ID",
                "parameters": [{
                    "name": "id",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string" },
                    "description": "Lease ID",
                    "example": "60f7a0b8c2a3f2b1c0d4e5f6"
                }],
                "responses": { "200": { "description": "Lease details" } }
            }
        },
    },
    "components": {
        "securitySchemes": {
            "bearerAuth": {
                "type": "http",
                "scheme": "bearer",
                "bearerFormat": "JWT"
            }
        },
        "schemas": {
            "Error": {
                "type": "object",
                "properties": {
                    "message": { "type": "string" }
                }
            },
            "ApiEnvelope": {
                "type": "object",
                "description": "Canonical JSON body written by responseFormatter for every API response.",
                "required": ["message", "statuscode"],
                "properties": {
                    "message": { "type": "string", "example": "Success" },
                    "statuscode": { "type": "integer", "example": 200 },
                    "data": { "description": "Operation payload. Null or omitted when there is nothing to return." }
                }
            },
            "User": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "name": { "type": "string" },
                    "email": { "type": "string" },
                    "phone": { "type": "string" },
                    "roles": {
                        "type": "array",
                        "items": { "type": "string" }
                    }
                }
            },
            "AuthResponse": {
                "type": "object",
                "properties": {
                    "accessToken": { "type": "string" },
                    "refreshToken": { "type": "string" },
                    "user": { "$ref": "#/components/schemas/User" }
                }
            },
            "Role": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "name": { "type": "string" },
                    "permissions": {
                        "type": "array",
                        "items": { "type": "string" }
                    }
                }
            },
            "Payment": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "amount": { "type": "number" },
                    "currency": { "type": "string" },
                    "status": { "type": "string" },
                    "tenantId": { "type": "string" },
                    "propertyId": { "type": "string" }
                }
            },
            "Lease": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "propertyId": { "type": "string" },
                    "tenantId": { "type": "string" },
                    "startDate": { "type": "string", "format": "date" },
                    "endDate": { "type": "string", "format": "date" },
                    "signed": { "type": "boolean" }
                }
            },
            "MaintenanceRequest": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "propertyId": { "type": "string" },
                    "tenantId": { "type": "string" },
                    "description": { "type": "string" },
                    "status": { "type": "string" },
                    "attachments": {
                        "type": "array",
                        "items": { "type": "string" }
                    }
                }
            },
            "Property": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "title": { "type": "string" },
                    "type": {
                        "type": "string",
                        "enum": ["residential", "student", "commercial", "affordable", "mobile_home"]
                    },
                    "address": { "type": "string" },
                    "managerId": { "type": "string" }
                }
            },
            "Lead": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "propertyId": { "type": "string" },
                    "name": { "type": "string" },
                    "contact": { "type": "string" },
                    "status": { "type": "string" }
                }
            },
            "Article": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "title": { "type": "string" },
                    "slug": { "type": "string" },
                    "content": { "type": "string" },
                    "tags": {
                        "type": "array",
                        "items": { "type": "string" }
                    }
                }
            }
        }
    },
    "security": [{ "bearerAuth": [] }]
};

const options = {
    swaggerDefinition,
    apis: [
        // Route files live under portals/, shared/, privileges/, and integrations/.
        // The old src/modules glob matched nothing, so @swagger blocks were dropped.
        path.join(__dirname, "../**/*.routes.js").replace(/\\/g, "/"),
        path.join(__dirname, "../docs/swagger.yaml"),
    ],
};

const swaggerSpec = swaggerJsdoc(options);

function mountPathFromLayer(layer) {
    if (!layer || !layer.regexp || !layer.regexp.source) return '';
    const source = layer.regexp.source;
    // Express middleware mounted with no path matches every URL. Do not treat that as a prefix.
    if (source === '^\\/?(?=\\/|$)' || source === '^\\/?$') return '';
    let mountPath = source
        .replace('^', '')
        .replace('\\/?', '')
        .replace('(?=\\/|$)', '')
        .replace(/\\\//g, '/')
        .replace(/\\/g, '')
        .replace(/\$$/, '');
    if (!mountPath || mountPath === '/' || mountPath === '/?') return '';
    if (!mountPath.startsWith('/')) mountPath = '/' + mountPath;
    return mountPath.replace(/\/+$/, '');
}

function joinRoutePaths(base, child) {
    if (!child || child === '/') return base || '/';
    const left = (base || '').replace(/\/+$/, '');
    const right = child.startsWith('/') ? child : `/${child}`;
    const full = `${left}${right}`.replace(/\/+/g, '/');
    return full.startsWith('/') ? full : `/${full}`;
}

function collectMountedRoutes(stack, prefix, routes) {
    if (!stack) return;
    stack.forEach((layer) => {
        if (layer.route && layer.route.path) {
            const routePaths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
            const methods = Object.keys(layer.route.methods || {}).filter((method) => method !== '_all');
            if (!methods.length) return;
            routePaths.forEach((routePath) => {
                routes.push({ path: joinRoutePaths(prefix, routePath), methods: methods.slice() });
            });
            return;
        }
        if (layer.name === 'router' && layer.handle && layer.handle.stack) {
            collectMountedRoutes(layer.handle.stack, joinRoutePaths(prefix, mountPathFromLayer(layer)), routes);
        }
    });
}

// Helper: extract mounted routes (path + methods) from express app, including nested routers.
function getMountedRoutes(app) {
    const routes = [];
    if (!app || !app._router || !app._router.stack) return routes;
    collectMountedRoutes(app._router.stack, '', routes);
    const seen = new Set();
    return routes.filter((route) => {
        const key = `${route.path}|${route.methods.slice().sort().join(',')}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

const HTTP_VERBS = { get: 'Get', post: 'Create', put: 'Replace', patch: 'Update', delete: 'Delete' };

const PUBLIC_OPERATIONS = new Set([
    'GET /health',
    'POST /api/v1/auth/login',
    'POST /api/v1/auth/signup',
    'GET /api/v1/auth/config',
    'GET /api/v1/auth/check-identity',
    'GET /api/v1/auth/portal-invite/validate',
    'POST /api/v1/auth/portal-invite/complete',
    'POST /api/v1/auth/forgot-password',
    'POST /api/v1/auth/verify-reset-otp',
    'PUT /api/v1/auth/verify-otp-reset-password',
    'POST /api/v1/auth/send-mfa-otp',
    'POST /api/v1/auth/verify-mfa-otp',
    'POST /api/v1/auth/refresh',
    'GET /api/v1/auth/public/masterdata',
    'POST /api/v1/marketing/email-subscriptions',
    'GET /api/v1/address/provider',
    'GET /api/v1/address/autocomplete',
    'POST /api/v1/address/usage',
    'GET /api/v1/zillow/callback',
    'POST /api/v1/zillow/callback',
    'GET /api/v1/zillow/config',
]);

function shouldDocumentPath(openApiPath) {
    return openApiPath === '/health'
        || openApiPath.startsWith('/api/v1/')
        || openApiPath.startsWith('/api/webhooks');
}

function tagForPath(openApiPath) {
    const parts = openApiPath.split('/').filter(Boolean);
    if (openApiPath === '/health') return 'system';
    if (parts[0] === 'api' && parts[1] === 'webhooks') return 'webhooks';
    if (parts[0] === 'api' && parts[1] === 'v1' && parts[2]) {
        if ((parts[2] === 'hoa' || parts[2] === 'landlord') && parts[3] && !parts[3].startsWith('{')) {
            return `${parts[2]}-${parts[3]}`;
        }
        return parts[2];
    }
    return parts[0] || 'system';
}

function tagDescription(tagName) {
    if (tagName === 'system') return 'Process health checks.';
    if (tagName === 'webhooks') return 'Inbound provider callbacks. These routes do not use the user bearer token.';
    if (tagName.startsWith('hoa-')) {
        return `HOA board portal endpoints for ${tagName.slice(4).replace(/-/g, ' ')}.`;
    }
    if (tagName.startsWith('landlord-')) {
        return `Landlord portal endpoints for ${tagName.slice(9).replace(/-/g, ' ')}.`;
    }
    return `Endpoints mounted under /api/v1/${tagName}.`;
}

function operationSummary(method, openApiPath) {
    const verb = HTTP_VERBS[method] || method.toUpperCase();
    const parts = openApiPath.split('/').filter((part) => part && part !== 'api' && part !== 'v1');
    const resource = parts
        .map((part) => (part.startsWith('{') ? part : part.replace(/-/g, ' ')))
        .join(' ');
    return `${verb} ${resource}`.replace(/\s+/g, ' ').trim();
}

function envelopeResponse(description) {
    return {
        description,
        content: {
            'application/json': {
                schema: { $ref: '#/components/schemas/ApiEnvelope' },
            },
        },
    };
}

function standardResponses() {
    return {
        200: envelopeResponse('Success. The body is { message, statuscode, data }.'),
        400: envelopeResponse('The request failed validation.'),
        401: envelopeResponse('The bearer token is missing or no longer valid.'),
        403: envelopeResponse('The caller is authenticated but is not allowed to perform this action.'),
        404: envelopeResponse('The requested record does not exist.'),
        500: envelopeResponse('The server could not complete the request.'),
    };
}

function findMatchingParen(source, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < source.length; i += 1) {
        const char = source[i];
        if (char === '(') depth += 1;
        else if (char === ')') {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function listRouteSourceFiles(dir, acc) {
    if (!fs.existsSync(dir)) return acc;
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            listRouteSourceFiles(full, acc);
            return;
        }
        if (entry.name.endsWith('.routes.js') || entry.name.endsWith('.route.js')) acc.push(full);
    });
    return acc;
}

function parseSchemaImports(source, file) {
    const imports = {};
    const pattern = /(?:const|let|var)\s+(?:\{\s*([^}]+)\s*\}|([A-Za-z0-9_]+))\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match = pattern.exec(source);
    while (match) {
        const required = match[3];
        if (!/validator/i.test(required)) {
            match = pattern.exec(source);
            continue;
        }
        let abs = path.resolve(path.dirname(file), required);
        if (!fs.existsSync(abs) && fs.existsSync(`${abs}.js`)) abs = `${abs}.js`;
        const names = match[1]
            ? match[1].split(',').map((part) => part.trim()).filter(Boolean)
            : [match[2]];
        names.forEach((rawName) => {
            const alias = rawName.split(':').map((part) => part.trim());
            const exportName = alias.length === 2 ? alias[0] : rawName;
            const localName = alias.length === 2 ? alias[1] : rawName;
            if (!localName) return;
            imports[localName] = { abs, exportName: match[1] ? exportName : null };
        });
        match = pattern.exec(source);
    }
    return imports;
}

const schemaModuleCache = new Map();

function loadJoiSchema(spec) {
    if (!spec || !spec.abs || !fs.existsSync(spec.abs)) return null;
    try {
        if (!schemaModuleCache.has(spec.abs)) {
            schemaModuleCache.set(spec.abs, require(spec.abs));
        }
        const loaded = schemaModuleCache.get(spec.abs);
        const schema = spec.exportName ? loaded && loaded[spec.exportName] : loaded;
        if (schema && typeof schema.describe === 'function') return schema;
    } catch (err) {
        logger.warn('Swagger could not load validator', { file: spec.abs, error: err.message });
    }
    return null;
}

function namedSchema(imports, name) {
    if (!name || !imports[name]) return null;
    return loadJoiSchema(imports[name]);
}

function inlineJoiSchema(args, helperName) {
    const marker = `${helperName}(`;
    const start = args.indexOf(marker);
    if (start < 0) return null;
    const open = start + marker.length - 1;
    const close = findMatchingParen(args, open);
    if (close < 0) return null;
    const inner = args.slice(open + 1, close).trim();
    if (!inner.startsWith('Joi.object')) return null;
    try {
        const schema = new Function('Joi', `return (${inner});`)(Joi);
        if (schema && typeof schema.describe === 'function') return schema;
    } catch (err) {
        return null;
    }
    return null;
}

function schemasFromLocalHelpers(source, args, imports) {
    const found = {};
    const names = args.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    names.forEach((name) => {
        if (/^(validateBody|validateQuery|validateParams|validateMultipart|validate|router|authMiddleware|csrfProtection|authorize|lockCheckMiddleware|req|res|next)$/i.test(name)) return;
        const declaration = source.match(new RegExp(`(?:function\\s+${name}\\s*\\(|const\\s+${name}\\s*=\\s*(?:async\\s*)?\\()`));
        if (!declaration) return;
        const chunk = source.slice(declaration.index, declaration.index + 1800);
        const bodyName = chunk.match(/validateBody\s*\(\s*([A-Za-z0-9_]+)/);
        const queryName = chunk.match(/validateQuery\s*\(\s*([A-Za-z0-9_]+)/);
        const paramsName = chunk.match(/validateParams\s*\(\s*([A-Za-z0-9_]+)/);
        if (bodyName && !found.body) found.body = namedSchema(imports, bodyName[1]);
        if (queryName && !found.query) found.query = namedSchema(imports, queryName[1]);
        if (paramsName && !found.params) found.params = namedSchema(imports, paramsName[1]);
    });
    return found;
}

function schemasFromRouteArgs(args, imports, source) {
    const result = {};
    const body = args.match(/validateBody\s*\(\s*([A-Za-z0-9_]+)/);
    const query = args.match(/validateQuery\s*\(\s*([A-Za-z0-9_]+)/);
    const params = args.match(/validateParams\s*\(\s*([A-Za-z0-9_]+)/);
    const multipart = args.match(/validateMultipart\s*\(\s*([A-Za-z0-9_]+)/);
    if (body) result.body = namedSchema(imports, body[1]);
    if (query) result.query = namedSchema(imports, query[1]);
    if (params) result.params = namedSchema(imports, params[1]);
    if (multipart) {
        result.body = namedSchema(imports, multipart[1]);
        result.multipart = true;
    }
    const combined = args.match(/validate\s*\(\s*\{([\s\S]*?)\}\s*\)/);
    if (combined) {
        const bodyName = combined[1].match(/body\s*:\s*([A-Za-z0-9_]+)/);
        const queryName = combined[1].match(/query\s*:\s*([A-Za-z0-9_]+)/);
        const paramsName = combined[1].match(/params\s*:\s*([A-Za-z0-9_]+)/);
        if (bodyName) result.body = namedSchema(imports, bodyName[1]);
        if (queryName) result.query = namedSchema(imports, queryName[1]);
        if (paramsName) result.params = namedSchema(imports, paramsName[1]);
    }
    if (!result.query) result.query = inlineJoiSchema(args, 'validateQuery');
    if (!result.body) result.body = inlineJoiSchema(args, 'validateBody');
    if (result.body && /upload/i.test(args)) result.multipart = true;
    if (source) {
        const fromHelpers = schemasFromLocalHelpers(source, args, imports);
        if (!result.body && fromHelpers.body) result.body = fromHelpers.body;
        if (!result.query && fromHelpers.query) result.query = fromHelpers.query;
        if (!result.params && fromHelpers.params) result.params = fromHelpers.params;
    }
    return result;
}

let routeCatalog = null;

function getRouteCatalog() {
    if (routeCatalog) return routeCatalog;
    routeCatalog = [];
    listRouteSourceFiles(path.join(__dirname, '..'), []).forEach((file) => {
        const source = fs.readFileSync(file, 'utf8');
        const imports = parseSchemaImports(source, file);
        const pattern = /router\.(get|post|put|patch|delete)\s*\(/gi;
        let match = pattern.exec(source);
        while (match) {
            const method = match[1].toLowerCase();
            const open = match.index + match[0].length - 1;
            const close = findMatchingParen(source, open);
            if (close > open) {
                const args = source.slice(open + 1, close);
                const pathMatch = args.match(/^\s*['"`]([^'"`]+)['"`]/);
                if (pathMatch) {
                    const localPath = pathMatch[1].startsWith('/') ? pathMatch[1] : `/${pathMatch[1]}`;
                    routeCatalog.push({
                        method,
                        localPath,
                        file,
                        schemas: schemasFromRouteArgs(args, imports, source),
                    });
                }
            }
            match = pattern.exec(source);
        }
    });
    return routeCatalog;
}

function routeFileWeight(file) {
    const normalized = file.replace(/\\/g, '/');
    if (normalized.includes('/portals/') || normalized.includes('/shared/modules/') || normalized.includes('/shared/messaging/') || normalized.includes('/integrations/')) {
        return 4;
    }
    if (normalized.includes('/privileges/')) return 1;
    return 2;
}

function routeMatchScore(fullPath, entry) {
    const full = (fullPath || '').replace(/\/+$/, '') || '/';
    const local = entry.localPath === '' ? '/' : entry.localPath.replace(/\/+$/, '') || '/';
    const fileHint = entry.file.replace(/\\/g, '/').toLowerCase();
    const segments = full.toLowerCase().split('/').filter((segment) => segment && !segment.startsWith(':'));
    const lastSegment = segments[segments.length - 1] || '';
    const lastSingular = lastSegment.endsWith('s') ? lastSegment.slice(0, -1) : lastSegment;
    const fileMatchesSegment = (segment) => {
        if (!segment) return false;
        const singular = segment.endsWith('s') ? segment.slice(0, -1) : segment;
        return fileHint.includes(`/${segment}/`)
            || fileHint.includes(`/${segment}.`)
            || fileHint.includes(`/${singular}/`)
            || fileHint.includes(`/${singular}.`);
    };
    const suffixMatches = local === '/'
        ? true
        : full === local || full.endsWith(local);
    if (!suffixMatches) return -1;
    const prefix = local === '/'
        ? full
        : full.slice(0, full.length - local.length).replace(/\/$/, '');
    const prefixLast = prefix.split('/').filter(Boolean).pop() || '';
    if (prefixLast && !fileMatchesSegment(prefixLast)) return -1;
    let score = local === '/' ? 1 : local.split('/').filter(Boolean).length * 10;
    segments.forEach((segment) => {
        if (segment.startsWith(':') || segment.startsWith('{')) return;
        const singular = segment.endsWith('s') ? segment.slice(0, -1) : segment;
        if (fileHint.includes(`/${segment}/`) || fileHint.includes(`/${segment}.`) || fileHint.includes(`/${singular}/`) || fileHint.includes(`/${singular}.`)) {
            score += 6;
        }
    });
    const baseName = path.basename(entry.file).toLowerCase();
    if (lastSegment && (baseName.startsWith(lastSegment) || (lastSingular && baseName.startsWith(lastSingular)))) {
        score += 8;
    }
    score += routeFileWeight(entry.file);
    return score;
}

function findValidatorsForRoute(openApiPath, method) {
    const expressPath = openApiPath.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
    let best = null;
    let bestScore = -1;
    getRouteCatalog().forEach((entry) => {
        if (entry.method !== method) return;
        const score = routeMatchScore(expressPath, entry);
        if (score > bestScore) {
            best = entry;
            bestScore = score;
        }
    });
    if (!best || bestScore < 1) return {};
    return best.schemas || {};
}

function schemaHasFields(media) {
    const schema = media && media.schema;
    if (!schema) return false;
    if (schema.$ref) return true;
    return !!(schema.properties && Object.keys(schema.properties).length);
}

function applyValidatorDocumentation(op, validators) {
    if (!op || !validators) return;
    if (validators.body && typeof validators.body.describe === 'function') {
        const desc = validators.body.describe();
        const schema = joiDescToOpenApi(desc);
        const example = joiDescToExample(desc);
        if (validators.multipart) {
            const alreadyDetailed = op.requestBody
                && op.requestBody.content
                && op.requestBody.content['multipart/form-data']
                && schemaHasFields(op.requestBody.content['multipart/form-data']);
            if (!alreadyDetailed) {
                op.requestBody = {
                    required: true,
                    content: {
                        'multipart/form-data': {
                            schema: {
                                type: 'object',
                                required: ['data'],
                                properties: {
                                    data: {
                                        type: 'string',
                                        description: 'JSON string of the request body validated by the server.',
                                    },
                                },
                            },
                            example: { data: JSON.stringify(example) },
                        },
                        'application/json': { schema, example },
                    },
                };
            }
        } else {
            const jsonMedia = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'];
            const joiKeys = Object.keys(schema.properties || {});
            const existingKeys = jsonMedia && jsonMedia.schema && jsonMedia.schema.properties
                ? Object.keys(jsonMedia.schema.properties)
                : [];
            const covered = joiKeys.length > 0 && joiKeys.every((key) => existingKeys.includes(key));
            if (!covered) {
                op.requestBody = {
                    required: true,
                    content: {
                        'application/json': { schema, example },
                    },
                };
            }
        }
    }

    if (!validators.query && !validators.params) return;
    const parameters = Array.isArray(op.parameters) ? op.parameters.slice() : [];
    const addParam = (name, location, joiDesc) => {
        if (parameters.some((param) => param.name === name && param.in === location)) return;
        const schema = joiDescToOpenApi(joiDesc);
        parameters.push({
            name,
            in: location,
            required: !!(joiDesc.flags && joiDesc.flags.presence === 'required'),
            schema,
            description: (joiDesc.flags && joiDesc.flags.description) || `${name} ${location} parameter`,
            example: joiDescToExample(joiDesc, name),
        });
    };
    if (validators.query && typeof validators.query.describe === 'function') {
        const described = validators.query.describe();
        Object.entries(described.keys || {}).forEach(([name, joiDesc]) => addParam(name, 'query', joiDesc));
    }
    if (validators.params && typeof validators.params.describe === 'function') {
        const described = validators.params.describe();
        Object.entries(described.keys || {}).forEach(([name, joiDesc]) => addParam(name, 'path', joiDesc));
    }
    if (parameters.length) op.parameters = parameters;
}

// Convert Joi description to OpenAPI schema (basic)
function joiDescToOpenApi(desc) {
    if (!desc) return { type: 'object' };
    switch (desc.type) {
        case 'object': {
            const props = {};
            const required = [];
            const keys = desc.keys || {};
            for (const [k, v] of Object.entries(keys)) {
                props[k] = joiDescToOpenApi(v);
                if (v.flags && v.flags.presence === 'required') required.push(k);
            }
            const schema = { type: 'object', properties: props };
            if (required.length) schema.required = required;
            return schema;
        }
        case 'array': {
            const items = desc.items && desc.items[0] ? joiDescToOpenApi(desc.items[0]) : { type: 'string' };
            const schema = { type: 'array', items };
            if (desc.rules) {
                for (const r of desc.rules) {
                    if (r.name === 'min') schema.minItems = r.arg;
                    if (r.name === 'max') schema.maxItems = r.arg;
                }
            }
            return schema;
        }
        case 'string': {
            const s = { type: 'string' };
            if (desc.rules) {
                for (const r of desc.rules) {
                    if (r.name === 'pattern' && r.arg) {
                        s.pattern = r.arg.toString().replace(/^\//, '').replace(/\/[gimuy]*$/, '');
                    }
                    if (r.name === 'min') s.minLength = r.arg;
                    if (r.name === 'max') s.maxLength = r.arg;
                    if (r.name === 'email') s.format = 'email';
                }
            }
            if (desc.allow && desc.allow.includes(null)) {
                s.nullable = true;
            }
            if (desc.valids && desc.valids.length) {
                const vals = desc.valids.filter(v => v !== undefined && v !== null && typeof v !== 'object');
                if (vals.length) s.enum = vals;
            }
            return s;
        }
        case 'number': {
            const s = { type: 'number' };
            if (desc.rules) {
                for (const r of desc.rules) {
                    if (r.name === 'min') s.minimum = r.arg;
                    if (r.name === 'max') s.maximum = r.arg;
                    if (r.name === 'integer') s.type = 'integer';
                }
            }
            return s;
        }
        case 'date': return { type: 'string', format: 'date' };
        case 'boolean': return { type: 'boolean' };
        case 'alternatives': {
            // try first match
            if (desc.matches && desc.matches.length) {
                const m = desc.matches[0];
                if (m.schema) return joiDescToOpenApi(m.schema);
            }
            return { type: 'string' };
        }
        default: return { type: 'string' };
    }
}

/**
 * joi Desc To Example
 *
 * Performs logic operations for joiDescToExample.
 *
 * @param desc - Request/input argument
 * @param fieldName - Request/input argument
 * @returns Operations result
 */
function joiDescToExample(desc, fieldName = '') {
    if (!desc) return {};
    switch (desc.type) {
        case 'object': {
            const obj = {};
            const keys = desc.keys || {};
            for (const [k, v] of Object.entries(keys)) {
                obj[k] = joiDescToExample(v, k);
            }
            return obj;
        }
        case 'array': {
            const item = desc.items && desc.items[0] ? joiDescToExample(desc.items[0], fieldName) : '';
            return [item];
        }
        case 'string': {
            if (desc.valids && desc.valids.length) {
                const v = desc.valids.find(x => typeof x === 'string');
                if (v) return v;
            }
            // Check for email format
            if (desc.rules && desc.rules.find(r => r.name === 'email')) return 'user@example.com';
            // pattern that looks like objectId
            if (desc.rules && desc.rules.find(r => r.name === 'pattern')) {
                const pattern = desc.rules.find(r => r.name === 'pattern');
                if (pattern && pattern.arg && pattern.arg.toString().includes('24')) {
                    return '60f7a0b8c2a3f2b1c0d4e5f6';
                }
                if (pattern && pattern.arg && pattern.arg.toString().includes('phone')) {
                    return '+1-555-123-4567';
                }
            }
            // Generate meaningful examples based on field names
            const name = fieldName.toLowerCase();
            if (name.includes('email')) return 'user@domain.com';
            if (name.includes('password')) return '<password>';
            if (name.includes('phone')) return '+1-555-123-4567';
            if (name.includes('name')) return 'Example Name';
            if (name.includes('address') || name.includes('street')) return '123 Main Street';
            if (name.includes('city')) return 'New York';
            if (name.includes('state')) return 'NY';
            if (name.includes('zip')) return '10001';
            if (name.includes('country')) return 'USA';
            if (name.includes('description')) return 'Example description';
            if (name.includes('type')) return 'residential';
            if (name === 'id' || name.includes('id')) return '60f7a0b8c2a3f2b1c0d4e5f6';
            if (name.includes('page')) return 1;
            if (name.includes('size')) return 10;
            if (name.includes('sort')) return 'name';
            if (name.includes('order')) return 'asc';
            if (name.includes('status')) return 'active';
            if (name.includes('search')) return 'search term';
            return 'example_value';
        }
        case 'number': {
            const name = fieldName.toLowerCase();
            if (name.includes('amount') || name.includes('fee')) return 100;
            if (name.includes('room') || name.includes('bed')) return 2;
            if (name.includes('feet') || name.includes('area')) return 1200;
            if (name.includes('period') || name.includes('day')) return 5;
            if (name.includes('page')) return 1;
            if (name.includes('size')) return 10;
            if (name.includes('limit')) return 10;
            if (name.includes('offset')) return 0;
            return 0;
        }
        case 'boolean': {
            const name = fieldName.toLowerCase();
            if (name.includes('active') || name.includes('enabled')) return true;
            return false;
        }
        case 'date': return new Date().toISOString().split('T')[0];
        default: return null;
    }
}

const setupSwagger = (app) => {
    // Merge any mounted express routes into the swaggerSpec so endpoints without
    // JSDoc or YAML entries still appear in Swagger UI for testing.
    try {
        const mounted = getMountedRoutes(app);
        // ensure tags array exists
        swaggerSpec.tags = swaggerSpec.tags || [];
        const existingTagNames = new Set((swaggerSpec.tags || []).map((t) => t.name));

        mounted.forEach((r) => {
            // convert express-style params (:id) to OpenAPI style {id}
            const openApiPath = (r.path || '').replace(/:([A-Za-z0-9_]+)/g, '{$1}');

            if (!shouldDocumentPath(openApiPath)) {
                return;
            }

            if (!swaggerSpec.paths[openApiPath]) swaggerSpec.paths[openApiPath] = {};

            const tagName = tagForPath(openApiPath);

            if (!existingTagNames.has(tagName)) {
                swaggerSpec.tags.push({ name: tagName, description: tagDescription(tagName) });
                existingTagNames.add(tagName);
            }

            // derive path parameters from the template
            const pathParams = [];
            const paramMatches = [...openApiPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)];
            paramMatches.forEach((m) => {
                const name = m[1];
                pathParams.push({ name, in: 'path', required: true, schema: { type: 'string' } });
            });

            r.methods.forEach((m) => {
                const method = m.toLowerCase();
                if (!swaggerSpec.paths[openApiPath][method]) {
                    const summary = operationSummary(method, openApiPath);
                    const isPublic = PUBLIC_OPERATIONS.has(`${method.toUpperCase()} ${openApiPath}`)
                        || openApiPath.startsWith('/api/webhooks');
                    swaggerSpec.paths[openApiPath][method] = {
                        summary,
                        description: `${summary}. ${isPublic
                            ? 'This route does not require a user bearer token.'
                            : 'Requires Authorization: Bearer <accessToken>.'} The JSON body uses { message, statuscode, data }.`,
                        tags: [tagName],
                        responses: standardResponses(),
                        ...(isPublic ? { security: [] } : {}),
                    };
                }

                const op = swaggerSpec.paths[openApiPath][method];
                if (pathParams.length) {
                    const parameters = Array.isArray(op.parameters) ? op.parameters.slice() : [];
                    pathParams.forEach((param) => {
                        if (!parameters.some((item) => item.name === param.name && item.in === 'path')) {
                            parameters.push({
                                ...param,
                                description: `${param.name} parameter`,
                                example: /id$/i.test(param.name) ? '60f7a0b8c2a3f2b1c0d4e5f6' : 'example_value',
                            });
                        }
                    });
                    op.parameters = parameters;
                }

                let validators = {};
                try {
                    validators = findValidatorsForRoute(openApiPath, method) || {};
                } catch (err) {
                    logger.warn('Swagger validator lookup failed', { path: openApiPath, method, error: err.message });
                }
                try {
                    applyValidatorDocumentation(op, validators);
                } catch (err) {
                    logger.warn('Swagger schema conversion failed', { path: openApiPath, method, error: err.message });
                }

                const jsonMedia = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'];
                if (!schemaHasFields(jsonMedia) && !validators.multipart && ['post', 'put', 'patch'].includes(method) && !op.requestBody) {
                    op.requestBody = {
                        required: false,
                        content: {
                            'application/json': { schema: { type: 'object' } },
                        },
                    };
                }
            });
        });
    } catch (err) {
        // non-fatal - continue to serve whatever spec was generated
        logger.warn('Failed to merge mounted routes into swagger spec:', err.message);
    }

    app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
    setupSwaggerJsonRoute(app);
};

// Optional helper route that returns the generated OpenAPI JSON for tooling/CI.
// This will be mounted when `setupSwagger(app)` is called so it reflects any
// merged auto-generated routes.
function setupSwaggerJsonRoute(app) {
    try {
        app.get('/api/docs/swagger.json', (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.send(swaggerSpec);
        });
    } catch (e) {
        // ignore
    }
}

// Exported for programmatic inspection in tests/tools
module.exports = { setupSwagger, swaggerSpec, setupSwaggerJsonRoute };

// Normalize schemas and add examples where missing so Swagger UI shows usable example bodies
function generateExampleFromSchema(schema, fieldName = '') {
    if (!schema) return {};
    if (schema.example !== undefined) return schema.example;
    if (schema['$ref']) return {};
    switch (schema.type) {
        case 'object': {
            const out = {};
            const props = schema.properties || {};
            for (const [k, v] of Object.entries(props)) {
                out[k] = generateExampleFromSchema(v, k);
            }
            return out;
        }
        case 'array': {
            const item = schema.items ? generateExampleFromSchema(schema.items, fieldName) : null;
            return item === null ? [] : [item];
        }
        case 'string': {
            if (schema.enum && schema.enum.length) return schema.enum[0];
            const name = fieldName.toLowerCase();
            if (name.includes('email') || (schema.format === 'email')) return 'user@domain.com';
            if (name.includes('password')) return '<password>';
            if (name.includes('date') || schema.format === 'date') return new Date().toISOString().split('T')[0];
            if (name === 'id' || name.includes('id') || /id$/i.test(name) || (schema.pattern && schema.pattern.length > 10)) return '60f7a0b8c2a3f2b1c0d4e5f6';
            if (name.includes('phone')) return '+1-555-123-4567';
            if (name.includes('name')) return 'Example Name';
            if (name.includes('address') || name.includes('street')) return '123 Main Street';
            if (name.includes('city')) return 'New York';
            if (name.includes('state')) return 'NY';
            if (name.includes('zip')) return '10001';
            if (name.includes('country')) return 'USA';
            if (name.includes('description')) return 'Example description';
            if (name.includes('type')) return 'residential';
            if (name.includes('page')) return '1';
            if (name.includes('size') || name.includes('limit')) return '10';
            if (name.includes('sort')) return 'name';
            if (name.includes('order')) return 'asc';
            if (name.includes('status')) return 'active';
            if (name.includes('search')) return 'search term';
            return 'example_value';
        }
        case 'number': case 'integer': {
            const name = fieldName.toLowerCase();
            if (name.includes('amount') || name.includes('fee')) return 100;
            if (name.includes('room') || name.includes('bed')) return 2;
            if (name.includes('feet') || name.includes('area')) return 1200;
            if (name.includes('period') || name.includes('day')) return 5;
            if (name.includes('page')) return 1;
            if (name.includes('size') || name.includes('limit')) return 10;
            if (name.includes('offset')) return 0;
            return 0;
        }
        case 'boolean': {
            const name = fieldName.toLowerCase();
            if (name.includes('active') || name.includes('enabled')) return true;
            return false;
        }
        default:
            // best-effort: if schema has properties assume object
            if (schema.properties) return generateExampleFromSchema(Object.assign({ type: 'object' }, schema), fieldName);
            return {};
    }
}

/**
 * normalize Spec Examples
 *
 * Performs logic operations for normalizeSpecExamples.
 *
 * @param spec - Request/input argument
 * @returns Operations result
 */
function normalizeSpecExamples(spec) {
    if (!spec || !spec.paths) return;
    for (const path of Object.keys(spec.paths)) {
        const ops = spec.paths[path];
        for (const method of Object.keys(ops)) {
            if (method === 'parameters') continue;
            const op = ops[method];
            if (!op) continue;
            // requestBody
            if (op.requestBody && op.requestBody.content) {
                for (const mt of Object.keys(op.requestBody.content)) {
                    const media = op.requestBody.content[mt];
                    if (media && media.schema) {
                        // ensure object type when properties present
                        if (!media.schema.type && media.schema.properties) media.schema.type = 'object';
                        // generate example if missing
                        if (media.example === undefined) {
                            try {
                                const ex = generateExampleFromSchema(media.schema, '');
                                media.example = ex;
                            } catch (e) {
                                // ignore
                            }
                        }
                        // also set schema.example for UI that reads it
                        if (media.schema && media.schema.example === undefined) {
                            try {
                                media.schema.example = generateExampleFromSchema(media.schema, '');
                            } catch (e) { }
                        }
                    }
                }
            }
        }
    }
}

// Normalize right away for the generated spec so UI shows examples
try { normalizeSpecExamples(swaggerSpec); } catch (e) { /* ignore */ }