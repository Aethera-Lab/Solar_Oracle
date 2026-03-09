
import React, { useState, useEffect } from 'react';
import { Aptos, AptosConfig, Network } from '@aptos-labs/ts-sdk';
import { Sun, MapPin, Zap, Clock, ExternalLink, RefreshCw, Loader, AlertCircle, Database } from 'lucide-react';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
    }
  }
}
// Your oracle configuration
const ORACLE_ADDRESS = "0x3894481b4dab10b691e954de7836b39fab6ea587861a613792aabd2f21008747";
const NETWORK = "devnet";

// Locations your oracle is tracking (from your backend LOCATIONS array)
const TRACKED_LOCATIONS = [
  { lat: 37.7749, lon: -122.4194, name: 'San Francisco, CA' },
  { lat: 40.7128, lon: -74.0060, name: 'New York City, NY' },
  { lat: 33.4484, lon: -112.0740, name: 'Phoenix, AZ' },
];

interface SolarData {
  location: { lat: number; lon: number; name: string };
  solar: { dni: number; ghi: number; lat_tilt: number };
  timestamp: number;
  hasData: boolean;
}

const aptos = new Aptos(new AptosConfig({ network: NETWORK as Network }));

export default function SolarOracleDashboard() {
  const [locations, setLocations] = useState<SolarData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [oracleStats, setOracleStats] = useState({ totalLocations: 0, totalUpdates: 0 });
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // Encode coordinates (same as your backend)
  const encodeLatitude = (lat: number) => Math.floor((lat + 90) * 1000000);
  const encodeLongitude = (lon: number) => Math.floor((lon + 180) * 1000000);

  // Fetch data directly from Aptos blockchain
  const fetchFromAptos = async () => {
    setLoading(true);
    setError(null);

    try {
      console.log('📡 Fetching oracle stats...');
      
      // Get oracle statistics
      const [totalLocations, totalUpdates] = await aptos.view({
        payload: {
          function: `${ORACLE_ADDRESS}::solar_oracle::get_stats`,
          functionArguments: [ORACLE_ADDRESS],
        },
      });

      console.log(`✅ Oracle has ${totalLocations} locations, ${totalUpdates} updates`);
      setOracleStats({
        totalLocations: Number(totalLocations),
        totalUpdates: Number(totalUpdates),
      });

      // Fetch data for each tracked location
      const locationData: SolarData[] = [];

      for (const loc of TRACKED_LOCATIONS) {
        const latEncoded = encodeLatitude(loc.lat);
        const lonEncoded = encodeLongitude(loc.lon);

        console.log(`📍 Fetching ${loc.name} (${loc.lat}, ${loc.lon})`);
        console.log(`   Encoded: lat=${latEncoded}, lon=${lonEncoded}`);

        try {
          // Check if data exists first
          const [hasData] = await aptos.view({
            payload: {
              function: `${ORACLE_ADDRESS}::solar_oracle::has_data`,
              functionArguments: [ORACLE_ADDRESS, latEncoded, lonEncoded],
            },
          });

          if (!hasData) {
            console.log(`   ⚠️  No data stored for this location yet`);
            locationData.push({
              location: { lat: loc.lat, lon: loc.lon, name: loc.name },
              solar: { dni: 0, ghi: 0, lat_tilt: 0 },
              timestamp: 0,
              hasData: false,
            });
            continue;
          }

          // Get the actual solar data
          const [dni, ghi, latTilt, timestamp] = await aptos.view({
            payload: {
              function: `${ORACLE_ADDRESS}::solar_oracle::get_solar_data`,
              functionArguments: [ORACLE_ADDRESS, latEncoded, lonEncoded],
            },
          });

          console.log(`   ✅ DNI: ${Number(dni)/100}, GHI: ${Number(ghi)/100}, Timestamp: ${timestamp}`);

          locationData.push({
            location: { lat: loc.lat, lon: loc.lon, name: loc.name },
            solar: {
              dni: Number(dni) / 100,
              ghi: Number(ghi) / 100,
              lat_tilt: Number(latTilt) / 100,
            },
            timestamp: Number(timestamp),
            hasData: true,
          });
        } catch (err) {
          console.error(`   ❌ Error fetching ${loc.name}:`, err);
          locationData.push({
            location: { lat: loc.lat, lon: loc.lon, name: loc.name },
            solar: { dni: 0, ghi: 0, lat_tilt: 0 },
            timestamp: 0,
            hasData: false,
          });
        }
      }

      setLocations(locationData);
      setLastUpdate(new Date());
      console.log('✅ All data loaded successfully!');

    } catch (err) {
      console.error('❌ Failed to fetch data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data from blockchain');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFromAptos();
  }, []);

  // Calculate averages (only for locations with data)
  const locationsWithData = locations.filter((loc: { hasData: any; }) => loc.hasData);
  const avgDNI = locationsWithData.length > 0
    ? locationsWithData.reduce((sum: any, loc: { solar: { dni: any; }; }) => sum + loc.solar.dni, 0) / locationsWithData.length
    : 0;
  const avgGHI = locationsWithData.length > 0
    ? locationsWithData.reduce((sum: any, loc: { solar: { ghi: any; }; }) => sum + loc.solar.ghi, 0) / locationsWithData.length
    : 0;

  const getSolarRating = (dni: number) => {
    if (dni >= 6.0) return { label: 'Excellent', color: 'text-emerald-400' };
    if (dni >= 5.0) return { label: 'Very Good', color: 'text-green-400' };
    if (dni >= 4.0) return { label: 'Good', color: 'text-yellow-400' };
    if (dni >= 3.0) return { label: 'Fair', color: 'text-orange-400' };
    return { label: 'Poor', color: 'text-red-400' };
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="text-center">
          <Loader className="w-12 h-12 text-yellow-400 animate-spin mx-auto mb-4" />
          <p className="text-slate-300 text-lg mb-2">Loading from Aptos Blockchain...</p>
          <p className="text-slate-500 text-sm">Network: {NETWORK}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
        <div className="bg-red-500/10 border border-red-500/50 rounded-xl p-6 max-w-md">
          <AlertCircle className="w-8 h-8 text-red-400 mb-3" />
          <p className="text-red-400 mb-4">{error}</p>
          <div className="bg-slate-900/50 rounded p-3 mb-4">
            <p className="text-xs text-slate-400 mb-1">Oracle Address:</p>
            <p className="text-xs text-slate-300 font-mono break-all">{ORACLE_ADDRESS}</p>
            <p className="text-xs text-slate-400 mt-2 mb-1">Network:</p>
            <p className="text-xs text-slate-300">{NETWORK}</p>
          </div>
          <button
            onClick={fetchFromAptos}
            className="w-full bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg transition"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
      {/* Header */}
      <div className="border-b border-slate-700/50 bg-slate-900/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="bg-gradient-to-br from-yellow-400 to-orange-500 p-2 rounded-xl">
                <Sun className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold bg-gradient-to-r from-yellow-400 to-orange-500 bg-clip-text text-transparent">
                  Solar Oracle
                </h1>
                <p className="text-sm text-slate-400">Real-time solar irradiance data on Aptos</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 bg-slate-800/50 px-3 py-2 rounded-lg border border-slate-700">
                <Database className="w-4 h-4 text-blue-400" />
                <span className="text-sm text-slate-300">{NETWORK}</span>
              </div>
              <button
                onClick={fetchFromAptos}
                className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-lg transition border border-slate-700"
              >
                <RefreshCw className="w-4 h-4" />
                Refresh
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-gradient-to-br from-slate-800/50 to-slate-900/50 backdrop-blur-sm border border-slate-700/50 rounded-xl p-6">
            <div className="flex items-center gap-3 mb-2">
              <MapPin className="w-5 h-5 text-blue-400" />
              <p className="text-slate-400 text-sm">Total Locations</p>
            </div>
            <p className="text-3xl font-bold">{oracleStats.totalLocations}</p>
            <p className="text-xs text-slate-500 mt-1">on-chain</p>
          </div>

          <div className="bg-gradient-to-br from-slate-800/50 to-slate-900/50 backdrop-blur-sm border border-slate-700/50 rounded-xl p-6">
            <div className="flex items-center gap-3 mb-2">
              <Zap className="w-5 h-5 text-yellow-400" />
              <p className="text-slate-400 text-sm">Avg DNI</p>
            </div>
            <p className="text-3xl font-bold">{avgDNI.toFixed(2)}</p>
            <p className="text-xs text-slate-500 mt-1">kWh/m²/day</p>
          </div>

          <div className="bg-gradient-to-br from-slate-800/50 to-slate-900/50 backdrop-blur-sm border border-slate-700/50 rounded-xl p-6">
            <div className="flex items-center gap-3 mb-2">
              <Sun className="w-5 h-5 text-orange-400" />
              <p className="text-slate-400 text-sm">Avg GHI</p>
            </div>
            <p className="text-3xl font-bold">{avgGHI.toFixed(2)}</p>
            <p className="text-xs text-slate-500 mt-1">kWh/m²/day</p>
          </div>

          <div className="bg-gradient-to-br from-slate-800/50 to-slate-900/50 backdrop-blur-sm border border-slate-700/50 rounded-xl p-6">
            <div className="flex items-center gap-3 mb-2">
              <Clock className="w-5 h-5 text-green-400" />
              <p className="text-slate-400 text-sm">Total Updates</p>
            </div>
            <p className="text-3xl font-bold">{oracleStats.totalUpdates}</p>
            <p className="text-xs text-slate-500 mt-1">
              {lastUpdate ? lastUpdate.toLocaleTimeString() : ''}
            </p>
          </div>
        </div>

        {/* Location Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {locations.map((location: { solar: { dni: number; ghi: number; lat_tilt: number; }; hasData: any; location: { name: any; lat: number; lon: number; }; timestamp: number; }, index: any) => {
            const rating = getSolarRating(location.solar.dni);
            return (
              <div
                key={index}
                className={`group bg-gradient-to-br from-slate-800/50 to-slate-900/50 backdrop-blur-sm border rounded-xl p-6 transition-all duration-300 ${
                  location.hasData
                    ? 'border-slate-700/50 hover:border-yellow-500/50'
                    : 'border-red-500/30 hover:border-red-500/50'
                }`}
              >
                {/* Location Header */}
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-semibold mb-1">{location.location.name}</h3>
                    <p className="text-sm text-slate-400">
                      {location.location.lat.toFixed(4)}, {location.location.lon.toFixed(4)}
                    </p>
                  </div>
                  <div className={`p-2 rounded-lg ${
                    location.hasData
                      ? 'bg-gradient-to-br from-yellow-400/20 to-orange-500/20'
                      : 'bg-red-500/10'
                  }`}>
                    <Sun className={`w-5 h-5 ${location.hasData ? 'text-yellow-400' : 'text-red-400'}`} />
                  </div>
                </div>

                {location.hasData ? (
                  <>
                    {/* Solar Data */}
                    <div className="space-y-3 mb-4">
                      <div className="flex justify-between items-center">
                        <span className="text-slate-400 text-sm">DNI</span>
                        <div className="text-right">
                          <span className="text-xl font-bold">{location.solar.dni.toFixed(2)}</span>
                          <span className="text-slate-500 text-xs ml-1">kWh/m²/day</span>
                        </div>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-slate-400 text-sm">GHI</span>
                        <div className="text-right">
                          <span className="text-xl font-bold">{location.solar.ghi.toFixed(2)}</span>
                          <span className="text-slate-500 text-xs ml-1">kWh/m²/day</span>
                        </div>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-slate-400 text-sm">Lat Tilt</span>
                        <div className="text-right">
                          <span className="text-xl font-bold">{location.solar.lat_tilt.toFixed(2)}</span>
                          <span className="text-slate-500 text-xs ml-1">kWh/m²/day</span>
                        </div>
                      </div>
                    </div>

                    {/* Rating */}
                    <div className="flex items-center justify-between pt-4 border-t border-slate-700/50">
                      <span className="text-sm text-slate-400">Solar Potential</span>
                      <span className={`text-sm font-semibold ${rating.color}`}>{rating.label}</span>
                    </div>

                    {/* Last Updated */}
                    <p className="mt-3 text-xs text-slate-500">
                      Updated: {new Date(location.timestamp * 1000).toLocaleString()}
                    </p>
                  </>
                ) : (
                  <div className="text-center py-6">
                    <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-2" />
                    <p className="text-sm text-red-400">No data available</p>
                    <p className="text-xs text-slate-500 mt-1">Run your oracle backend to populate data</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer Info */}
        <div className="mt-8 bg-slate-800/30 border border-slate-700/50 rounded-xl p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-slate-400 mb-1">Oracle Contract Address</p>
              <p className="font-mono text-xs text-slate-300 break-all">{ORACLE_ADDRESS}</p>
              <a
                href={`https://explorer.aptoslabs.com/account/${ORACLE_ADDRESS}?network=${NETWORK}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 mt-2"
              >
                <ExternalLink className="w-3 h-3" />
                View on Explorer
              </a>
            </div>
            <div>
              <p className="text-slate-400 mb-1">Network</p>
              <p className="font-semibold capitalize">{NETWORK}</p>
              <p className="text-xs text-slate-500 mt-2">
                Fetching data directly from Aptos blockchain
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}