# AtlasFive Event-Driven Architecture - Service Trigger Instructions

## Overview

This file contains instructions for triggering any service in the AtlasFive Event-Driven Architecture system and tracking their execution through logs.

---

## Architecture Components

1. **SimpleAzureLogsMCP** - Log querying service for Azure Application Insights
   - Location: `C:\Users\DeepakKhimavathBB\source\repos\BlobEditorService\SimpleAzureLogsMCP`
   - Used to track event execution via correlation ID
   - Logs Endpoint: `http://localhost:5001/api/serviceflow/{correlationId}`
   - Track Endpoint: `http://localhost:5001/api/correlation/{correlationId}/track`

2. **BlobEditor API** - For downloading blob content
   - Endpoint: `http://localhost:5003/api/payload/get`
   - Method: POST
   - Content-Type: application/json

3. **AtlasFiveEventArchitecture** - Event-driven Azure Functions services
   - Location: `C:\Users\DeepakKhimavathBB\source\repos\AtlasFiveEventArchitecture`
   - Services: EliminationService, JEEnrichmentService, EvaluateService, ExceptionValidationService, etc.

4. **EliminationService HTTP Endpoint** (Local Development)
   - **CORRECT Endpoint: `http://localhost:7088/api/agt/eliminate`**
   - Accepts CloudEvent JSON format
   - **IMPORTANT: This is the correct endpoint, NOT port 5003!**

---

## How to Trigger EliminationService

### Step 1: Generate Proper GUID IDs

**CRITICAL: Always use proper GUID format for id and correlationid.**

- Use proper GUID format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
- Example: `22daa19b-52d4-46ff-8e06-93127981338a`
- Generate using PowerShell: `[guid]::NewGuid().ToString()`
- **NEVER use random 30-char strings** - they cause "Unrecognized Guid format" errors!
- **NEVER reuse IDs** - system rejects with "Duplicate event detected" error

### Step 2: Prepare the Wrapper (CloudEvent JSON)

Use this standard wrapper format:

```json
{
  "specversion": "1.0",
  "source": "/subscriptions/00000000-0000-0000-0000-000000000000/storageAccounts/stgeventarchitecturedev",
  "subject": "Enrichment",
  "type": "Microsoft.Storage.BlobCreated",
  "id": "22daa19b-52d4-46ff-8e06-93127981338a",
  "eventtype": "AghEnrichment",
  "data": {
    "tenant_Guid": "8ae5c894-cbd6-403e-b922-0bd4c319e4b9",
    "correlationid": "22daa19b-52d4-46ff-8e06-93127981338a",
    "bloburl": "https://stgeventarchitecturedev.blob.core.windows.net/blob-payloads-dev/3601718d-9803-4045-89ee-28558081efff.json",
    "blobname": "3601718d-9803-4045-89ee-28558081efff.json",
    "container": "blob-payloads-dev"
  }
}
```

### Step 3: Update the Wrapper

1. Replace `id` with a fresh GUID (use PowerShell: `[guid]::NewGuid().ToString()`)
2. Replace `correlationid` with the SAME GUID as id
3. Update `bloburl` and `blobname` with the blob you want to process

### Step 4: Trigger the Service

**CORRECT ENDPOINT: `http://localhost:7088/api/agt/eliminate`**

```bash
curl -X POST "http://localhost:7088/api/agt/eliminate" -H "Content-Type: application/json" -d "{...wrapper JSON...}"
```

---

## How to Track/Verify Execution via Logs

### Using SimpleAzureLogsMCP (Port 5001)

After triggering, query the logs:

1. **Service Flow Endpoint:**
   ```
   GET http://localhost:5001/api/serviceflow/{correlationId}
   ```

2. **Correlation Track Endpoint:**
   ```
   GET http://localhost:5001/api/correlation/{correlationId}/track
   ```

### What to Look for in Logs

- **EliminationService**: Should show blob processing, output blob creation, message enqueued
- **EventQueueProcessor**: Should show event pickup and downstream processing
- **EvaluateService**: Should show processing with any exceptions
- **TransactionService**: Transaction processing
- **JEPersistService**: Journal entry persistence
- **Errors**: Look for "ExceptionReason" field - if null, no errors

---

## How to Download Blob Content

### Using BlobEditor API (Port 5003)

```bash
curl -X POST "http://localhost:5003/api/payload/get" -H "Content-Type: application/json" -d "{\"data\":{\"tenant_Guid\":\"8ae5c894-cbd6-403e-b922-0bd4c319e4b9\",\"bloburl\":\"https://stgeventarchitecturedev.blob.core.windows.net/blob-payloads-dev/BLOB-NAME.json\"}}"
```

---

## Important Rules

1. **ALWAYS use proper GUID format** - Use `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, NOT random strings
2. **Use CORRECT endpoint** - `http://localhost:7088/api/agt/eliminate` (NOT port 5003!)
3. **Use CORRECT logs endpoint** - Port 5001, NOT 5000
4. **ALWAYS use unique IDs** - Never reuse `id` or `correlationid`
5. **Never skip log verification** - Always check logs after triggering
6. **Keep bloburl the same** - Unless explicitly told to change it
7. **Use the same wrapper format** - The structure stays consistent

---

## Quick Reference

| Item | Value |
|------|-------|
| **EliminationService Endpoint** | `http://localhost:7088/api/agt/eliminate` |
| **Logs Endpoint (Service Flow)** | `http://localhost:5001/api/serviceflow/{correlationId}` |
| **Logs Endpoint (Track)** | `http://localhost:5001/api/correlation/{correlationId}/track` |
| **Blob API Endpoint** | `http://localhost:5003/api/payload/get` |
| **Tenant GUID** | `8ae5c894-cbd6-403e-b922-0bd4c319e4b9` |

---

## Example Complete Trigger Flow

1. Generate GUID using PowerShell:
   ```powershell
   [guid]::NewGuid().ToString()
   ```

2. Example output: `22daa19b-52d4-46ff-8e06-93127981338a`

3. Use the same GUID for both `id` and `correlationid` in the wrapper

4. POST to `http://localhost:7088/api/agt/eliminate`

5. Wait 5-8 seconds for processing

6. Check logs at `http://localhost:5001/api/serviceflow/22daa19b-52d4-46ff-8e06-93127981338a`

7. Review the execution flow in the log response

---

## Common Errors and Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| "Unrecognized Guid format" | Using random string instead of GUID | Use proper GUID format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| "Duplicate event detected" | Reusing same ID | Generate new GUID for each trigger |
| "Invalid blob" | Blob has invalid data | Check blob content via port 5003 API |
| 404 on logs | Wrong port | Use port 5001, not 5000 |
