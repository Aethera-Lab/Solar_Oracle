import { Aptos, AptosConfig, Network, Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";
import axios from "axios";
import * as dotenv from "dotenv";
import dns from "dns";
import http from "http";
import https from "https";
import { ShelbyClient } from "@shelby-protocol/sdk/node";
import fs from "fs";

dns.setServers(["1.1.1.1", "8.8.8.8"]);
dns.setDefaultResultOrder('ipv4first');
dotenv.config();

// Configuration
const NREL_API_KEY = process.env.NREL_API_KEY!;
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY!;
const MODULE_ADDRESS = process.env.MODULE_ADDRESS!;
const NETWORK = process.env.NETWORK || "devnet";
const SHELBY_API_KEY = process.env.SHELBY_API_KEY!;

const httpAgent = new http.Agent({ 
  keepAlive: true, 
  family: 4,
  timeout: 60000,
});

const httpsAgent = new https.Agent({ 
  keepAlive: true, 
  family: 4,
  timeout: 60000,
  rejectUnauthorized: true,
});

const config = new AptosConfig({ network: NETWORK as Network });
const aptos = new Aptos(config);

const privateKey = new Ed25519PrivateKey(ORACLE_PRIVATE_KEY);
const oracleAccount = Account.fromPrivateKey({ privateKey });

console.log(`🔑 Oracle Address: ${oracleAccount.accountAddress.toString()}`);

interface NRELResponse {
  outputs: {
    avg_dni: { annual: number };
    avg_ghi: { annual: number };
    avg_lat_tilt: { annual: number };
  };
}

interface SolarData {
  latitude: number;
  longitude: number;
  dni: number;
  ghi: number;
  lat_tilt: number;
  timestamp: number;
}

interface ShelbyOracleData {
  location: {
    lat: number;
    lon: number;
    encoded_lat: number;
    encoded_lon: number;
  };
  solar: {
    dni: number;
    ghi: number;
    lat_tilt: number;
  };
  metadata: {
    timestamp: number;
    tx_hash: string;
    oracle_address: string;
  };
}

/** Amount to request from ShelbyUSD faucet (smallest units; 100_000_000 = 100 ShelbyUSD) */
const SHELBYUSD_FUND_AMOUNT = 100_000_000;

/**
 * Ensure the oracle account has ShelbyUSD on ShelbyNet for blob storage payments.
 * Call once per run when Shelby integration is enabled.
 */
async function ensureShelbyUSDBalance(): Promise<void> {
  try {
    const shelby = new ShelbyClient({
      apiKey: SHELBY_API_KEY,
      network: Network.SHELBYNET,
    });
    const address = oracleAccount.accountAddress.toString();
    await shelby.fundAccountWithShelbyUSD({
      address,
      amount: SHELBYUSD_FUND_AMOUNT,
    });
    console.log(`✅ Oracle funded with ShelbyUSD for blob storage`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Failed to fund") || msg.includes("faucet")) {
      console.warn(
        `⚠️ ShelbyUSD funding skipped or failed. If blob upload fails, fund manually: https://docs.shelby.xyz/apis/faucet/shelbyusd`
      );
    } else {
      console.warn(`⚠️ ShelbyUSD pre-fund check:`, msg);
    }
  }
}

function encodeLatitude(lat: number): number {
  return Math.floor((lat + 90) * 1000000);
}

function encodeLongitude(lon: number): number {
  return Math.floor((lon + 180) * 1000000);
}

async function fetchSolarData(lat: number, lon: number): Promise<SolarData> {
  console.log(`📡 Fetching NREL data for lat: ${lat}, lon: ${lon}`);
  console.log(`🔑 Using API key: ${NREL_API_KEY ? NREL_API_KEY.substring(0, 8) + '...' : 'NOT SET'}`);
  
  try {
    const response = await axios.get<NRELResponse>(
      "https://developer.nrel.gov/api/solar/solar_resource/v1.json",
      {
        params: { api_key: NREL_API_KEY, lat, lon },
        timeout: 60000,
        httpAgent,
        httpsAgent,
        proxy: false,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      }
    );

    const outputs = response.data.outputs;
    
    const solarData: SolarData = {
      latitude: encodeLatitude(lat),
      longitude: encodeLongitude(lon),
      dni: Math.floor(outputs.avg_dni.annual * 100),
      ghi: Math.floor(outputs.avg_ghi.annual * 100),
      lat_tilt: Math.floor(outputs.avg_lat_tilt.annual * 100),
      timestamp: Math.floor(Date.now() / 1000),
    };

    console.log(`✅ NREL Data:`, {
      dni: `${outputs.avg_dni.annual} kWh/m²/day`,
      ghi: `${outputs.avg_ghi.annual} kWh/m²/day`,
      lat_tilt: `${outputs.avg_lat_tilt.annual} kWh/m²/day`,
    });

    return solarData;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(`❌ NREL API Error:`, {
        code: error.code,
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
      throw new Error(`NREL API Error (${error.code}): ${error.message}`);
    }
    throw error;
  }
}

async function pushToChain(data: SolarData): Promise<string> {
  try {
    console.log(`📤 Pushing to Aptos blockchain...`);

    const transaction = await aptos.transaction.build.simple({
      sender: oracleAccount.accountAddress,
      data: {
        function: `${MODULE_ADDRESS}::solar_oracle::update_solar_data`,
        functionArguments: [
          data.latitude,
          data.longitude,
          data.dni,
          data.ghi,
          data.lat_tilt,
          data.timestamp,
        ],
      },
    });

    const committedTxn = await aptos.signAndSubmitTransaction({
      signer: oracleAccount,
      transaction,
    });

    const executedTransaction = await aptos.waitForTransaction({
      transactionHash: committedTxn.hash,
    });

    console.log(`✅ Transaction committed: ${committedTxn.hash}`);
    console.log(`   Gas used: ${executedTransaction.gas_used}`);

    return committedTxn.hash;
  } catch (error) {
    console.error(`❌ Transaction failed:`, error);
    throw error;
  }
}

/**
 * Store data in Shelby (creates JSON file locally and uploads as a blob)
 */
async function pushToShelby(
  lat: number,
  lon: number,
  data: SolarData,
  txHash: string
): Promise<ShelbyOracleData> {
  console.log(`📤 Publishing to Shelby...`);

  const shelbyData: ShelbyOracleData = {
    location: {
      lat,
      lon,
      encoded_lat: data.latitude,
      encoded_lon: data.longitude,
    },
    solar: {
      dni: data.dni / 100,
      ghi: data.ghi / 100,
      lat_tilt: data.lat_tilt / 100,
    },
    metadata: {
      timestamp: data.timestamp,
      tx_hash: txHash,
      oracle_address: MODULE_ADDRESS,
    },
  };

  try {
    const outputDir = "data";
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const shelby = new ShelbyClient({
      apiKey: SHELBY_API_KEY,
      network: Network.SHELBYNET,
    });

    // Create JSON file on disk
    const fileName = `${outputDir}/solar_${lat}_${lon}.json`;
    fs.writeFileSync(fileName, JSON.stringify(shelbyData, null, 2));

    // Upload JSON as a Shelby blob
    const fileBytes = fs.readFileSync(fileName);
    const expirationMicros =
      Date.now() * 1000 + 24 * 60 * 60 * 1_000_000; // 24h from now

    await shelby.upload({
      blobData: fileBytes,
      signer: oracleAccount,
      blobName: fileName,
      expirationMicros,
    });

    console.log(`✅ Published to Shelby blob storage for ${fileName}`);

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const isInsufficientFunds =
      msg.includes("E_INSUFFICIENT_FUNDS") ||
      msg.includes("insufficient funds") ||
      msg.toLowerCase().includes("blob storage");
    if (isInsufficientFunds) {
      console.error(`❌ Failed to publish to Shelby: not enough ShelbyUSD for blob storage.`);
      console.error(
        `   💡 Fund your oracle with ShelbyUSD: https://docs.shelby.xyz/apis/faucet/shelbyusd`
      );
    } else {
      console.error(`❌ Failed to publish to Shelby:`, error);
    }
  }

  return shelbyData;
}

/**
 * Store aggregated data (all locations in one file)
 */
async function storeAggregatedData(allData: ShelbyOracleData[]): Promise<void> {
  try {
    console.log(`\n📦 Storing aggregated oracle data...`);

    const outputDir = "data";
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const shelby = new ShelbyClient({
      apiKey: SHELBY_API_KEY,
      network: Network.SHELBYNET,
    });

    const aggregated = {
      timestamp: Date.now(),
      total_locations: allData.length,
      oracle_address: MODULE_ADDRESS,
      network: NETWORK,
      locations: allData,
    };

    const fileName = `${outputDir}/oracle-data-${Date.now()}.json`;
    fs.writeFileSync(fileName, JSON.stringify(aggregated, null, 2));

    const fileBytes = fs.readFileSync(fileName);
    const expirationMicros =
      Date.now() * 1000 + 24 * 60 * 60 * 1_000_000; // 24h from now

    const uploadPayload = {
      blobs: [
        { blobData: fileBytes, blobName: fileName },
      ],
      signer: oracleAccount,
      expirationMicros,
    };

    const maxTries = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        await shelby.batchUpload(uploadPayload);
        console.log(`✅ Aggregated oracle data stored in ${fileName} and uploaded to Shelby`);
        return;
      } catch (e) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        const isServerError =
          msg.includes("multipart upload") ||
          msg.includes("500") ||
          msg.includes("Internal Server Error");
        if (isServerError && attempt < maxTries) {
          console.warn(
            `   ⚠️ Shelby upload attempt ${attempt}/${maxTries} failed (server error). Retrying in 3s...`
          );
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          throw e;
        }
      }
    }
    throw lastError;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const isInsufficientFunds =
      msg.includes("E_INSUFFICIENT_FUNDS") ||
      msg.includes("insufficient funds") ||
      msg.toLowerCase().includes("blob storage");
    const isShelbyServerError =
      msg.includes("multipart upload") ||
      msg.includes("500") ||
      msg.includes("Internal Server Error");

    if (isInsufficientFunds) {
      console.error(`❌ Failed to store aggregated data: not enough ShelbyUSD for blob storage.`);
      console.error(
        `   💡 Fund your oracle with ShelbyUSD: https://docs.shelby.xyz/apis/faucet/shelbyusd (or ShelbyNet faucet)`
      );
    } else if (isShelbyServerError) {
      console.error(`❌ Shelby upload failed (server error). Aggregated data was saved locally.`);
      console.error(`   📁 Local file: data/oracle-data-*.json — use it or retry the run later.`);
    } else {
      console.error(`❌ Failed to store aggregated data:`, error);
    }
  }
}

async function readFromChain(lat: number, lon: number): Promise<void> {
  try {
    const latEncoded = encodeLatitude(lat);
    const lonEncoded = encodeLongitude(lon);

    console.log(`📖 Reading on-chain data for (${lat}, ${lon})`);
    console.log(`   Encoded: lat=${latEncoded}, lon=${lonEncoded}`);

    const resource = await aptos.getAccountResource({
      accountAddress: MODULE_ADDRESS,
      resourceType: `${MODULE_ADDRESS}::solar_oracle::SolarRegistry`,
    });

    console.log(`📖 Registry data:`, resource);
  } catch (error) {
    console.error(`❌ Failed to read on-chain data:`, error);
  }
}

/**
 * Main oracle update cycle
 */
async function updateOracle(locations: Array<{ lat: number; lon: number }>) {
  console.log(`\n🚀 Starting Oracle Update Cycle`);
  console.log(`   Network: ${NETWORK}`);
  console.log(`   Module: ${MODULE_ADDRESS}`);
  console.log(`   Locations: ${locations.length}`);
  console.log(`   Shelby Integration: ${SHELBY_API_KEY ? 'Enabled' : 'Disabled'}`);

  const allShelbyData: ShelbyOracleData[] = [];

  // Ensure oracle has ShelbyUSD on ShelbyNet for blob storage (before any Shelby uploads)
  if (SHELBY_API_KEY) {
    await ensureShelbyUSDBalance();
  }

  for (const loc of locations) {
    try {
      console.log(`\n📍 Processing location: ${loc.lat}, ${loc.lon}`);
      
      // 1. Fetch from NREL
      const solarData = await fetchSolarData(loc.lat, loc.lon);
      
      // 2. Push to Aptos (blockchain is source of truth)
      const txHash = await pushToChain(solarData);
      
      // 3. Push to Shelby (for frontend to fetch later)
      if (SHELBY_API_KEY) {
        const shelbyData = await pushToShelby(loc.lat, loc.lon, solarData, txHash);
        allShelbyData.push(shelbyData);
      }

      console.log(`✅ Successfully updated location ${loc.lat}, ${loc.lon}`);
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error) {
      console.error(`❌ Failed to update location ${loc.lat}, ${loc.lon}:`, error);
    }
  }

  // Store all data in one aggregated file (easier for frontend)
  if (SHELBY_API_KEY && allShelbyData.length > 0) {
    await storeAggregatedData(allShelbyData);
  }

  console.log(`\n✅ Oracle update cycle completed\n`);
}

async function initialize() {
  console.log(`\n🔧 Initializing Oracle Module...`);
  
  try {
    const transaction = await aptos.transaction.build.simple({
      sender: oracleAccount.accountAddress,
      data: {
        function: `${MODULE_ADDRESS}::solar_oracle::initialize`,
        functionArguments: [],
      },
    });

    const committedTxn = await aptos.signAndSubmitTransaction({
      signer: oracleAccount,
      transaction,
    });

    await aptos.waitForTransaction({ transactionHash: committedTxn.hash });
    
    console.log(`✅ Oracle initialized: ${committedTxn.hash}`);
  } catch (error: any) {
    if (error.message?.includes("RESOURCE_ALREADY_EXISTS")) {
      console.log(`ℹ️  Oracle already initialized`);
    } else {
      throw error;
    }
  }
}

const LOCATIONS = [
  { lat: 37.7749, lon: -122.4194 }, // San Francisco, CA
  { lat: 40.7128, lon: -74.0060 },  // New York City, NY
  { lat: 33.4484, lon: -112.0740 }, // Phoenix, AZ
];

(async () => {
  try {
    // await initialize();
    await updateOracle(LOCATIONS);
    await readFromChain(LOCATIONS[0].lat, LOCATIONS[0].lon);
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
})();
