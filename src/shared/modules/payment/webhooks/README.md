# Straddle Payment Status Webhook API

Production-ready webhook endpoint for receiving Straddle payment/payout status updates based on official Straddle API documentation.

## Endpoint

```
POST /api/webhooks/straddle/payment-status
```

## Purpose

Receives `payout.event.v1` events from Straddle whenever a payment/payout status changes.

## Features

- Accepts application/json payloads
- Handles event_type = payout.event.v1
- Extracts complete payment details from payload.data (26 fields)
- Tracks all payment statuses: created, scheduled, pending, paid, failed, cancelled, on_hold, reversed
- Stores customer details, paykey details, status history
- Logs webhook payloads
- Stores payment status updates in MongoDB
- Prevents duplicate processing using event_id (unique index)
- Returns HTTP 200 after successful processing
- Updates existing StraddleTransaction records
- Production-ready error handling

## Request Format (Actual Straddle Structure)

```json
{
  "account_id": "857c679a-8e80-47f1-9334-39dd08ea801f",
  "event_id": "85df84c7-a298-44bc-8040-7bd2ae372cbf",
  "event_type": "payout.event.v1",
  "data": {
    "id": "26de0dc0-0ee9-418f-a890-4a42fc3f9a3d",
    "status": "paid",
    "amount": 50000,
    "currency": "usd",
    "description": "Rent payment",
    "paykey": "pk_123",
    "paykey_details": {
      "id": "033de251-fda3-4f86-90d7-2ce4000b2d51",
      "customer_id": "a773843f-e6f0-4ac0-b3df-b1dc720a4d57",
      "label": "Primary Account",
      "balance": 42
    },
    "customer_details": {
      "id": "03ece916-5d0e-46f7-a28a-e7f1aab1dbc3",
      "name": "John Doe",
      "email": "john@example.com",
      "phone": "+1234567890",
      "customer_type": "individual"
    },
    "status_details": {
      "changed_at": "2026-06-10T09:30:17.124318848",
      "code": "payment_completed",
      "message": "Payment processed successfully",
      "reason": "success",
      "source": "straddle"
    },
    "status_history": [
      {
        "status": "created",
        "changed_at": "2026-06-10T09:30:17.124323176",
        "code": "payment_initiated"
      },
      {
        "status": "paid",
        "changed_at": "2026-06-10T09:30:17.124323176",
        "code": "payment_completed"
      }
    ],
    "payment_rail": "ach",
    "consent_type": "web",
    "effective_at": "2026-06-10T09:30:17.124297865",
    "payment_date": "2026-06-10",
    "processed_at": "2026-06-10T09:30:17.124311905",
    "created_at": "2026-06-10T09:30:17.124288070",
    "updated_at": "2026-06-10T09:30:17.124327198",
    "external_id": "external_ref_123",
    "funding_ids": ["4ae34665-b77e-4319-b189-e8f8b46d15f2"],
    "related_payments": [
      {
        "id": "614c06b0-05cc-4d48-b4cb-a2badfb2d182",
        "payment_type": "charge",
        "relationship": "refund_of"
      }
    ],
    "is_refund": false,
    "is_resubmit": false,
    "has_resubmit": true,
    "metadata": {
      "tenantId": "tenant_123",
      "propertyId": "prop_456"
    },
    "config": {},
    "device": {
      "ip_address": "192.168.1.1"
    }
  }
}
```

## Response Format

Success:

```json
{
  "received": true
}
```

Duplicate:

```json
{
  "received": true,
  "message": "Duplicate event"
}
```

Error:

```json
{
  "error": "Missing event_id"
}
```

## Payment Statuses

| Status | Description |
| -------- | ------------- |
| `created` | Payment/payout has been created |
| `scheduled` | Payment/payout is scheduled for future processing |
| `pending` | Payment/payout is being processed |
| `paid` | Payment/payout completed successfully |
| `failed` | Payment/payout failed |
| `cancelled` | Payment/payout was cancelled |
| `on_hold` | Payment/payout is on hold |
| `reversed` | Payment/payout was reversed |

## Data Fields Stored

### Core Fields

- `eventId` - Unique event identifier (indexed)
- `eventType` - Event type (payout.event.v1)
- `accountId` - Straddle account ID (indexed)
- `payoutId` - Payout/payment ID (indexed)
- `status` - Payment status (indexed, enum)
- `amount` - Payment amount in cents
- `currency` - Currency code (default: usd)
- `description` - Payment description

### Paykey & Customer

- `paykey` - Paykey identifier (indexed)
- `paykeyDetails` - Full paykey object (id, customer_id, label, balance)
- `customerDetails` - Full customer object (id, name, email, phone, customer_type)

### Status Tracking

- `statusDetails` - Current status details (changed_at, code, message, reason, source)
- `statusHistory` - Array of status changes with timestamps

### Payment Details

- `paymentRail` - Payment rail (ach, etc.)
- `consentType` - Consent type
- `effectiveAt` - Effective date
- `paymentDate` - Payment date
- `processedAt` - Processing timestamp

### Related Data

- `externalId` - External reference ID
- `fundingIds` - Array of funding IDs
- `relatedPayments` - Array of related payment objects

### Flags

- `isRefund` - Boolean flag for refunds
- `isResubmit` - Boolean flag for resubmissions
- `hasResubmit` - Boolean flag indicating if resubmit exists

### Additional

- `metadata` - Custom metadata object
- `rawPayload` - Complete raw webhook payload

## Architecture

```
webhooks/
├── controller/webhook.controller.js    # HTTP request handling
├── service/webhook.service.js          # Business logic
├── middleware/webhook.middleware.js    # Payload validation
├── model/paymentStatus.model.js        # MongoDB schema
├── routes/webhook.routes.js            # Route definitions
├── webhooks/types.ts                   # TypeScript interfaces
├── webhooks/test-webhook.js            # Test script
└── webhooks/README.md                  # This file
```

## Configuration in Straddle

1. Log into Straddle Dashboard
2. Navigate to Webhooks
3. Add webhook endpoint: `https://your-domain.com/api/webhooks/straddle/payment-status`
4. Select event: `payout.event.v1`
5. Save configuration

## Testing

### Using Node.js Test Script

```bash
cd src/shared/modules/payment/webhooks
node test-webhook.js
```

### Using cURL

```bash
curl -X POST http://localhost:3000/api/webhooks/straddle/payment-status \
  -H "Content-Type: application/json" \
  -d '{
    "account_id": "857c679a-8e80-47f1-9334-39dd08ea801f",
    "event_id": "evt_test_123",
    "event_type": "payout.event.v1",
    "data": {
      "id": "payout_test_456",
      "status": "paid",
      "amount": 10000,
      "currency": "usd"
    }
  }'
```

### Using Postman

Import: `docs/Straddle_Webhook.postman_collection.json`

## Database Schema

**Collection:** `paymentstatuses`

**Indexes:**

- `eventId` (unique) - Prevents duplicate processing
- `payoutId` - Fast lookups by payout
- `accountId` - Fast lookups by account
- `paykey` - Fast lookups by paykey
- `status` - Filter by status
- `payoutId + status` - Compound index
- `accountId + status` - Compound index
- `createdAt` (descending) - Chronological queries

## Security

- No authentication required (webhook endpoints are publicly accessible by design)
- Payload validation ensures data integrity
- Duplicate event detection prevents replay attacks
- All events logged for audit trail
- Unique constraint on event_id prevents duplicate processing

## Monitoring

All webhook events are logged with:

- Event ID
- Account ID
- Payout ID
- Status
- Amount
- Paykey
- Processing result

Check logs for:

```
[Webhook] Payment status received
[Webhook] Payment status processed
[Webhook] Duplicate event ignored
[Webhook] Transaction updated
[Webhook] Processing failed
```

## Error Handling

The webhook handles:

- Missing required fields (400 Bad Request)
- Invalid payload structure (400 Bad Request)
- Duplicate events (200 OK with duplicate message)
- Database errors (500 Internal Server Error)
- All errors are logged with full context

## Production Considerations

- Idempotent processing (safe to retry)
- Comprehensive logging for debugging
- Database indexes for performance
- Validation middleware
- Error recovery
- Status synchronization with transactions
- Complete data capture for audit trail
