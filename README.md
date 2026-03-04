## Solar Oracle

**Solar Oracle** is an Aptos-based oracle that periodically fetches solar irradiance data from the NREL API for a set of geographic locations, pushes the encoded values on-chain, and optionally stores structured oracle snapshots in Shelby blob storage and on disk as JSON.

The project has:

- **Move module** (`sources/solar_oracle.move`) that defines the on-chain `solar_oracle::SolarRegistry` and the `update_solar_data` entry function.
- **TypeScript server** (`server/src/index.ts`) that:
  - Calls the NREL API for each configured location.
  - Encodes and submits values to Aptos using `@aptos-labs/ts-sdk`.
  - Persists oracle results as JSON files in `server/data/`.
  - Integrates with `@shelby-protocol/sdk` to upload those JSON files as blobs to Shelby.

### Architecture Overview

- **On-chain (Move)**
  - Package name: `solar_oracle` (see `Move.toml`).
  - Deployed address: `0x3894481b4dab10b691e954de7836b39fab6ea587861a613792aabd2f21008747`.
  - Core entry function:  
    - `solar_oracle::update_solar_data` – records encoded latitude/longitude and solar metrics for a given location.
  - State:
    - `SolarRegistry` resource holds a registry of locations and their latest solar readings on-chain.

- **Off-chain (Node/TypeScript)**
  - Entry file: `server/src/index.ts`.
  - Uses `@aptos-labs/ts-sdk` for transaction building, signing, and submission.
  - Uses `axios` to query NREL’s `solar_resource` API.
  - Uses `@shelby-protocol/sdk` (Node target) to upload JSON snapshots as blobs to Shelby.

### Data Flow

1. **Fetch from NREL**
   - For each configured location (`LOCATIONS` array in `server/src/index.ts`):
     - Calls:
       - `https://developer.nrel.gov/api/solar/solar_resource/v1.json`
     - Passes:
       - `lat`, `lon`
       - `api_key` = `NREL_API_KEY` from `.env`
   - Response is mapped into:
     - Direct Normal Irradiance (`dni`)
     - Global Horizontal Irradiance (`ghi`)
     - Latitude-tilt irradiance (`lat_tilt`)
   - Values are scaled to integers (×100) and lat/lon are encoded with:
     - `encodeLatitude(lat)` and `encodeLongitude(lon)`.

2. **Push to Aptos**
   - The server builds a transaction via:
     - `aptos.transaction.build.simple` with:
       - `function`: ``${MODULE_ADDRESS}::solar_oracle::update_solar_data``  
       - `functionArguments`: encoded latitude, longitude, `dni`, `ghi`, `lat_tilt`, and `timestamp`.
   - It signs and submits using `oracleAccount` (derived from `ORACLE_PRIVATE_KEY`).
   - After confirmation, the code logs and returns the **`transactionHash`**:
     - Logged to stdout:
       - `✅ Transaction committed: <transactionHash>`
     - Stored in each JSON snapshot under:
       - `metadata.tx_hash`

3. **Persist to Shelby and Disk**
   - For each location, `pushToShelby` constructs a `ShelbyOracleData` object:
     - `location.lat`, `location.lon`
     - `location.encoded_lat`, `location.encoded_lon`
     - `solar.dni`, `solar.ghi`, `solar.lat_tilt` (scaled back to floating values)
     - `metadata.timestamp`
     - **`metadata.tx_hash`** – the on-chain transaction hash returned from Aptos.
     - `metadata.oracle_address` – the module address.
   - It writes a per-location JSON file to:
     - `server/data/solar_<lat>_<lon>.json`
   - It then uploads that file to Shelby as a blob using `ShelbyClient.upload`, with:
     - `blobData`: file bytes
     - `signer`: `oracleAccount`
     - `blobName`: `data/solar_<lat>_<lon>.json`
     - `expirationMicros`: 24 hours from “now”.
   - After all locations are processed, `storeAggregatedData` builds a single aggregated JSON:
     - `server/data/oracle-data-<timestamp>.json`
     - Contains:
       - `timestamp`
       - `total_locations`
       - `oracle_address`
       - `network`
       - `locations`: array of all `ShelbyOracleData` entries, each with its own **`metadata.tx_hash`**.
   - The aggregated JSON is also uploaded to Shelby with `ShelbyClient.batchUpload`.  
     - If uploads fail due to insufficient ShelbyUSD or Shelby RPC 5xx errors, the JSON remains available locally.

### Project Layout

- `Move.toml` – Move package manifest, including module address configuration and Aptos framework dependency.
- `sources/solar_oracle.move` – Move module implementing the on-chain oracle logic.
- `server/`
  - `src/index.ts` – main oracle script (NREL fetch, Aptos transactions, Shelby integration).
  - `data/`
    - `solar_<lat>_<lon>.json` – per-location oracle snapshots, each including `metadata.tx_hash`.
    - `oracle-data-<timestamp>.json` – aggregated oracle data across all locations, including every location’s `metadata.tx_hash`.
  - `package.json` – Node/TypeScript project metadata and scripts.
  - `tsconfig.json` – TypeScript configuration.
  - `nodemon.json` – nodemon configuration (watches `src` only).

### Environment Variables

Create `server/.env` with:

```bash
NREL_API_KEY=<your_nrel_api_key>
ORACLE_PRIVATE_KEY=<ed25519_private_key_for_oracle_account>
MODULE_ADDRESS=0x3894481b4dab10b691e954de7836b39fab6ea587861a613792aabd2f21008747
NETWORK=devnet
SHELBY_API_KEY=<your_shelby_api_key>
```

- **`ORACLE_PRIVATE_KEY`** must correspond to the account that owns the `solar_oracle` module.
- **`SHELBY_API_KEY`** is used both for blob uploads and for interacting with ShelbyNet endpoints.

### Running the Oracle Locally

From the `server` directory:

```bash
npm install

# Development mode (auto-restart on code changes)
npm run dev

# One-shot run (no nodemon)
npx ts-node src/index.ts
```

During a run you should see logs of:

- NREL API calls for each location.
- Successful Aptos submissions with **transaction hashes**:
  - `✅ Transaction committed: 0x...`
- Per-location Shelby publish attempts.
- Aggregated data storage and upload attempts.

### Consuming the JSON Output

- **Per-location files** (`server/data/solar_<lat>_<lon>.json`) – ideal if your frontend or another service wants direct access to each location’s latest values and its **`transactionHash`**:
  - `metadata.tx_hash` – on-chain transaction hash for that location update.
  - `metadata.oracle_address` – Move module/oracle owner address.
  - `metadata.timestamp` – Unix timestamp (seconds).

- **Aggregated files** (`server/data/oracle-data-<timestamp>.json`) – ideal if you want one endpoint/file to represent the entire oracle state:
  - `locations` array, each item containing its **`metadata.tx_hash`** and associated data.

These JSON files can be:

- Served directly from a backend endpoint.
- Uploaded to a CDN or object storage.
- Indexed by your frontend to display on-chain update history.

### Shelby Integration and Funding Notes

- The oracle uses `ShelbyClient` with `network: Network.SHELBYNET` for blob uploads.
- Before uploads, it calls `fundAccountWithShelbyUSD` (via `ensureShelbyUSDBalance`) to ensure the oracle account has enough **ShelbyUSD** to pay blob storage costs.
- If:
  - Funding fails (e.g. faucet limits), or
  - The storage transaction fails with `E_INSUFFICIENT_FUNDS`, or
  - Shelby RPC returns 500/`Internal Server Error`,
  the script:
  - **Keeps** the JSON data locally in `server/data/`.
  - Logs a clear explanation so you can:
    - Manually fund the oracle with ShelbyUSD.
    - Retry later once Shelby services are healthy.

### Transaction Hash (`transactionHash`) Summary

- On-chain submission:
  - After `update_solar_data` is executed, the Aptos client logs:
    - `✅ Transaction committed: <transactionHash>`
- In JSON files:
  - Per-location file: `metadata.tx_hash` equals the `transactionHash` of the corresponding Aptos transaction.
  - Aggregated file: each entry in `locations` contains `metadata.tx_hash` for that location’s last update.

Use these `transactionHash` values to:

- Link frontend views to Aptos explorers.
- Prove data provenance (tie the JSON payload back to the exact on-chain transaction).
