# Tenant Listing API

## Overview
This API provides tenant listing functionality with advanced filtering, pagination, and property/lease data integration.

## Endpoint
`GET /api/v1/tenants/list-with-details`

## Authentication
Requires authentication middleware, authorization, and lock check.

## Query Parameters

### Filtering Parameters
- `tenantId` (optional): Filter by specific tenant ID (ObjectId format)
- `propertyId` (optional): Filter by specific property ID (ObjectId format)
- `unit` (optional): Filter by unit name (applicable only when propertyId is provided)
- `status` (optional): Filter by tenant status
- `landlordId` (optional): Filter by landlord ID (ObjectId format)

### Pagination Parameters
- `pageNumber` or `page` (optional): Page number (default: 1, minimum: 1)
- `pageSize` (optional): Number of items per page (default: 10, minimum: 0)

## Response Format

### Success Response (200)
```json
{
  "success": true,
  "message": "Tenants fetched successfully",
  "data": {
    "data": [
      {
        "tenantId": "ObjectId",
        "name": "John Doe",
        "propertyName": "Sunset Apartments",
        "unitName": "Unit 101",
        "address": "123 Main St, City, State 12345",
        "accountStatus": "",
        "tenantStatus": "active",
        "rent": 1200,
        "roommates": 1
      }
    ],
    "total": 25,
    "page": 1,
    "pageSize": 10
  }
}
```

### Response Fields
- `tenantId`: Unique identifier for the tenant
- `name`: Full name of the tenant (firstName + lastName)
- `propertyName`: Name of the property where tenant resides
- `unitName`: Name/number of the unit
- `address`: Full address of the property (or tenant address if no property)
- `accountStatus`: Account status (currently blank as requested)
- `tenantStatus`: Status from the lease (draft, active, etc.)
- `rent`: Rent amount assigned to this tenant from lease split
- `roommates`: Number of other tenants in the same lease (total tenants - 1)

### Error Response (4xx/5xx)
```json
{
  "success": false,
  "message": "Error description",
  "data": null
}
```

## Usage Examples

### Basic Listing
```
GET /api/v1/tenants/list-with-details?pageSize=20
```

### Filter by Property
```
GET /api/v1/tenants/list-with-details?propertyId=64a1b2c3d4e5f6789012345&pageSize=10
```

### Filter by Property and Unit
```
GET /api/v1/tenants/list-with-details?propertyId=64a1b2c3d4e5f6789012345&unit=Unit%20101
```

### Filter by Tenant ID
```
GET /api/v1/tenants/list-with-details?tenantId=64a1b2c3d4e5f6789012346
```

## Implementation Details

### Data Sources
- **Tenant Data**: Retrieved from User collection with Tenant role
- **Property Data**: Retrieved from Property collection via lease relationships
- **Lease Data**: Retrieved from Lease collection to get rent splits and roommate counts
- **Address**: Prioritizes property address over tenant address

### Filtering Logic
1. Base query filters tenants by role and deletion status
2. Additional filters applied based on query parameters
3. Property and unit filters are applied post-query by checking lease relationships
4. Pagination is applied at the database level for efficiency

### Performance Considerations
- Uses lean queries for better performance
- Implements proper indexing on frequently queried fields
- Batches related data queries to minimize database calls
- Uses lookup maps to efficiently join data from multiple collections

## Error Handling
- Validates all ObjectId parameters
- Returns appropriate HTTP status codes
- Provides descriptive error messages
- Handles missing relationships gracefully (returns 'N/A' for missing data)