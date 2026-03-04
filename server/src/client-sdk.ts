// Client SDK for Solar Oracle via Shelby
// npm install axios @aptos-labs/ts-sdk

import axios, { AxiosInstance } from "axios";
import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";

export interface SolarOracleConfig {
  shelbyApiKey?: string;           // Optional: for authenticated access
  oracleAddress: string;           // Your deployed oracle address
  network: "testnet" | "mainnet" | "devnet";
  useShelby?: boolean;            // true = use Shelby API, false = direct on-chain
}

export interface Location {
  lat: number;
  lon: number;
}

export interface SolarData {
  location: {
    lat: number;
    lon: number;
  };
  solar: {
    dni: number;        // kWh/m²/day
    ghi: number;        // kWh/m²/day
    lat_tilt: number;   // kWh/m²/day
  };
  metadata: {
    timestamp: number;
    last_updated: Date;
    tx_hash?: string;
    is_fresh: boolean;  // Updated within last 7 days
  };
}

export class SolarOracleClient {
  private shelbyClient: AxiosInstance;
  private aptosClient: Aptos;
  private config: SolarOracleConfig;

  constructor(config: SolarOracleConfig) {
    this.config = config;

    // Initialize Shelby API client
    this.shelbyClient = axios.create({
      baseURL: "https://api.shelbynet.shelby.xyz/v1",
      headers: {
        "Content-Type": "application/json",
        ...(config.shelbyApiKey && {
          Authorization: `Bearer ${config.shelbyApiKey}`,
        }),
      },
      timeout: 10000,
    });

    // Initialize Aptos client (fallback)
    const aptosConfig = new AptosConfig({
      network: config.network as Network,
    });
    this.aptosClient = new Aptos(aptosConfig);
  }

  /**
   * Get solar data for a specific location
   */
  async getSolarData(lat: number, lon: number): Promise<SolarData> {
    if (this.config.useShelby) {
      return this.getSolarDataFromShelby(lat, lon);
    } else {
      return this.getSolarDataFromChain(lat, lon);
    }
  }

  /**
   * Fetch data from Shelby (faster, cached)
   */
  private async getSolarDataFromShelby(
    lat: number,
    lon: number
  ): Promise<SolarData> {
    try {
      const response = await this.shelbyClient.get(
        `/oracle/data/${this.config.oracleAddress}/solar_oracle_${lat}_${lon}`
      );

      const data = response.data;

      return {
        location: {
          lat: data.location.lat,
          lon: data.location.lon,
        },
        solar: {
          dni: data.solar.dni,
          ghi: data.solar.ghi,
          lat_tilt: data.solar.lat_tilt,
        },
        metadata: {
          timestamp: data.metadata.timestamp,
          last_updated: new Date(data.metadata.timestamp * 1000),
          tx_hash: data.metadata.tx_hash,
          is_fresh: this.isFresh(data.metadata.timestamp),
        },
      };
    } catch (error) {
      console.error("Shelby fetch failed, falling back to chain:", error);
      return this.getSolarDataFromChain(lat, lon);
    }
  }

  /**
   * Fetch data directly from Aptos blockchain
   */
  private async getSolarDataFromChain(
    lat: number,
    lon: number
  ): Promise<SolarData> {
    const latEncoded = this.encodeLatitude(lat);
    const lonEncoded = this.encodeLongitude(lon);

    const [dni, ghi, latTilt, timestamp] = await this.aptosClient.view({
      payload: {
        function: `${this.config.oracleAddress}::solar_oracle::get_solar_data`,
        functionArguments: [
          this.config.oracleAddress,
          latEncoded,
          lonEncoded,
        ],
      },
    });

    return {
      location: { lat, lon },
      solar: {
        dni: Number(dni) / 100,
        ghi: Number(ghi) / 100,
        lat_tilt: Number(latTilt) / 100,
      },
      metadata: {
        timestamp: Number(timestamp),
        last_updated: new Date(Number(timestamp) * 1000),
        is_fresh: this.isFresh(Number(timestamp)),
      },
    };
  }

  /**
   * Check if location has data available
   */
  async hasData(lat: number, lon: number): Promise<boolean> {
    try {
      const latEncoded = this.encodeLatitude(lat);
      const lonEncoded = this.encodeLongitude(lon);

      const [hasData] = await this.aptosClient.view({
        payload: {
          function: `${this.config.oracleAddress}::solar_oracle::has_data`,
          functionArguments: [
            this.config.oracleAddress,
            latEncoded,
            lonEncoded,
          ],
        },
      });

      return Boolean(hasData);
    } catch {
      return false;
    }
  }

  /**
   * Check if location is suitable for solar installation
   */
  async isSuitableForSolar(
    lat: number,
    lon: number,
    minDniThreshold: number = 5.0
  ): Promise<boolean> {
    try {
      const latEncoded = this.encodeLatitude(lat);
      const lonEncoded = this.encodeLongitude(lon);
      const thresholdEncoded = Math.floor(minDniThreshold * 100);

      const [isSuitable] = await this.aptosClient.view({
        payload: {
          function: `${this.config.oracleAddress}::solar_oracle::is_suitable_for_solar`,
          functionArguments: [
            this.config.oracleAddress,
            latEncoded,
            lonEncoded,
            thresholdEncoded,
          ],
        },
      });

      return Boolean(isSuitable);
    } catch {
      return false;
    }
  }

  /**
   * Get oracle statistics
   */
  async getOracleStats(): Promise<{
    totalLocations: number;
    totalUpdates: number;
  }> {
    const [totalLocations, totalUpdates] = await this.aptosClient.view({
      payload: {
        function: `${this.config.oracleAddress}::solar_oracle::get_stats`,
        functionArguments: [this.config.oracleAddress],
      },
    });

    return {
      totalLocations: Number(totalLocations),
      totalUpdates: Number(totalUpdates),
    };
  }

  /**
   * Batch fetch multiple locations (Shelby only)
   */
  async batchGetSolarData(locations: Location[]): Promise<SolarData[]> {
    if (!this.config.useShelby) {
      // Fallback: fetch one by one from chain
      return Promise.all(
        locations.map((loc) => this.getSolarData(loc.lat, loc.lon))
      );
    }

    try {
      const keys = locations.map(
        (loc) => `solar_oracle_${loc.lat}_${loc.lon}`
      );

      const response = await this.shelbyClient.post(
        `/oracle/batch`,
        {
          provider_address: this.config.oracleAddress,
          keys: keys,
        }
      );

      return response.data.results.map((item: any) => ({
        location: {
          lat: item.location.lat,
          lon: item.location.lon,
        },
        solar: {
          dni: item.solar.dni,
          ghi: item.solar.ghi,
          lat_tilt: item.solar.lat_tilt,
        },
        metadata: {
          timestamp: item.metadata.timestamp,
          last_updated: new Date(item.metadata.timestamp * 1000),
          tx_hash: item.metadata.tx_hash,
          is_fresh: this.isFresh(item.metadata.timestamp),
        },
      }));
    } catch (error) {
      console.error("Batch fetch failed:", error);
      return Promise.all(
        locations.map((loc) => this.getSolarData(loc.lat, loc.lon))
      );
    }
  }

  /**
   * Find best location for solar from a list
   */
  async findBestLocation(locations: Location[]): Promise<{
    location: Location;
    solar: SolarData;
  } | null> {
    const dataList = await this.batchGetSolarData(locations);

    let bestLocation: Location | null = null;
    let bestData: SolarData | null = null;
    let bestDni = 0;

    dataList.forEach((data, index) => {
      if (data.solar.dni > bestDni) {
        bestDni = data.solar.dni;
        bestLocation = locations[index];
        bestData = data;
      }
    });

    if (!bestLocation || !bestData) return null;

    return {
      location: bestLocation,
      solar: bestData,
    };
  }

  /**
   * Subscribe to real-time updates (Shelby WebSocket)
   */
  subscribeToLocation(
    lat: number,
    lon: number,
    callback: (data: SolarData) => void
  ): () => void {
    if (!this.config.useShelby) {
      console.warn("Real-time subscription requires Shelby");
      return () => {};
    }

    // WebSocket connection (pseudo-code, adjust based on Shelby's actual API)
    const ws = new WebSocket(
      `wss://api.shelby.xyz/v1/oracle/subscribe?key=solar_oracle_${lat}_${lon}`
    );

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      callback({
        location: { lat, lon },
        solar: {
          dni: data.solar.dni,
          ghi: data.solar.ghi,
          lat_tilt: data.solar.lat_tilt,
        },
        metadata: {
          timestamp: data.metadata.timestamp,
          last_updated: new Date(data.metadata.timestamp * 1000),
          tx_hash: data.metadata.tx_hash,
          is_fresh: this.isFresh(data.metadata.timestamp),
        },
      });
    };

    return () => ws.close();
  }

  // Helper methods
  private encodeLatitude(lat: number): number {
    return Math.floor((lat + 90) * 1000000);
  }

  private encodeLongitude(lon: number): number {
    return Math.floor((lon + 180) * 1000000);
  }

  private isFresh(timestamp: number): boolean {
    const sevenDaysInSeconds = 7 * 24 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);
    return now - timestamp <= sevenDaysInSeconds;
  }
}

// Export convenience functions
export const createSolarOracleClient = (
  config: SolarOracleConfig
): SolarOracleClient => {
  return new SolarOracleClient(config);
};