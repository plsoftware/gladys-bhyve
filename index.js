// -----------------------------------------------------------------------------
// Orbit B-hyve -> Gladys external integration.
//
// One Gladys device per B-hyve sprinkler timer, with:
//   - one "watering" switch per zone (on = water for the run time, off = stop)
//   - "Run time" (minutes, writable): how long a switched-on zone waters
//   - "Rain delay" (hours, writable): 0 cancels it
// State comes from the B-hyve websocket event stream, backed by a periodic
// REST poll so a missed event cannot leave a zone stuck "on".
// -----------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import {
  GladysIntegration,
  logger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { BhyveClient, AuthenticationError } from './src/bhyve.js';

const STATE_FILE = '/data/state.json';
const DEFAULT_RUN_TIME = 10;

const gladys = new GladysIntegration();

let config = {};
let client = null;
let pollTimer = null;
// B-hyve device id -> latest device payload from the cloud.
const sprinklers = new Map();
// B-hyve device id -> run time in minutes (persisted in /data).
let runTimes = {};

// --- Helpers -----------------------------------------------------------------

function normalizeConfig(raw = {}) {
  return {
    username: (raw.username ?? '').trim(),
    password: raw.password ?? '',
    poll_frequency: Math.max(60, Number(raw.poll_frequency ?? 300)),
  };
}

function ids(bhyveId) {
  return gladys.externalIds('sprinkler', bhyveId);
}

function zonesOf(device) {
  if (Array.isArray(device.zones) && device.zones.length > 0) {
    return device.zones.map((z) => ({ station: Number(z.station), name: z.name || `Zone ${z.station}` }));
  }
  return Array.from({ length: device.num_stations ?? 1 }, (_, i) => ({
    station: i + 1,
    name: `Zone ${i + 1}`,
  }));
}

function runTimeOf(bhyveId) {
  return runTimes[bhyveId] ?? DEFAULT_RUN_TIME;
}

async function loadRunTimes() {
  try {
    runTimes = JSON.parse(await readFile(STATE_FILE, 'utf8')).runTimes ?? {};
  } catch {
    runTimes = {};
  }
}

async function saveRunTimes() {
  try {
    await writeFile(STATE_FILE, JSON.stringify({ runTimes }));
  } catch (err) {
    logger.warn(`Could not persist run times: ${err.message}`);
  }
}

function buildDevice(device) {
  const id = ids(device.id);
  return {
    name: device.name,
    external_id: id.device,
    params: [
      { name: 'model', value: device.hardware_version ?? 'unknown' },
      { name: 'firmware', value: String(device.firmware_version ?? 'unknown') },
    ],
    features: [
      ...zonesOf(device).map((zone) => ({
        name: `${zone.name} watering`,
        external_id: id.feature(`zone-${zone.station}`),
        category: DEVICE_FEATURE_CATEGORIES.SWITCH,
        type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
        read_only: false,
        has_feedback: true,
        keep_history: true,
        min: 0,
        max: 1,
      })),
      {
        name: 'Run time',
        external_id: id.feature('run-time'),
        category: DEVICE_FEATURE_CATEGORIES.DURATION,
        type: DEVICE_FEATURE_TYPES.DURATION.INTEGER,
        unit: DEVICE_FEATURE_UNITS.MINUTES,
        read_only: false,
        has_feedback: false,
        keep_history: false,
        min: 1,
        max: 120,
      },
      {
        name: 'Rain delay',
        external_id: id.feature('rain-delay'),
        category: DEVICE_FEATURE_CATEGORIES.DURATION,
        type: DEVICE_FEATURE_TYPES.DURATION.INTEGER,
        unit: DEVICE_FEATURE_UNITS.HOURS,
        read_only: false,
        has_feedback: true,
        keep_history: true,
        min: 0,
        max: 168,
      },
    ],
  };
}

function currentStation(device) {
  const station = device.status?.watering_status?.current_station;
  return station == null ? null : Number(station);
}

/** Every feature state of one sprinkler, derived from its cloud payload. */
function statesOf(device) {
  const id = ids(device.id);
  const watering = currentStation(device);
  return [
    ...zonesOf(device).map((zone) => ({
      device_feature_external_id: id.feature(`zone-${zone.station}`),
      state: zone.station === watering ? 1 : 0,
    })),
    { device_feature_external_id: id.feature('run-time'), state: runTimeOf(device.id) },
    { device_feature_external_id: id.feature('rain-delay'), state: Number(device.status?.rain_delay ?? 0) },
  ];
}

async function publishAllStates() {
  const states = [...sprinklers.values()].flatMap(statesOf);
  if (states.length === 0) return;
  try {
    await gladys.publishStates(states);
  } catch (err) {
    // Expected until the user has created the device from the Discovery tab.
    logger.debug(`publishStates skipped: ${err.message}`);
  }
}

async function refreshFromCloud() {
  const devices = await client.getSprinklers();
  sprinklers.clear();
  for (const device of devices) sprinklers.set(device.id, device);
  await publishAllStates();
  return devices;
}

async function publishDevices() {
  await gladys.publishDiscoveredDevices([...sprinklers.values()].map(buildDevice));
}

// --- Event stream --------------------------------------------------------------

function applyEvent(data) {
  const device = sprinklers.get(data.device_id);
  if (!device) return false;
  const status = (device.status ??= {});

  switch (data.event) {
    case 'watering_in_progress_notification':
      status.watering_status = {
        current_station: data.current_station,
        program: data.program,
        started_watering_station_at: data.started_watering_station_at,
      };
      status.run_mode = data.mode ?? 'manual';
      return true;
    case 'watering_complete':
    case 'device_idle':
      delete status.watering_status;
      if (data.event === 'device_idle') status.run_mode = 'off';
      return true;
    case 'change_mode':
      status.run_mode = data.mode ?? status.run_mode;
      // An empty station list is a stop.
      if (Array.isArray(data.stations) && data.stations.length === 0) delete status.watering_status;
      return true;
    case 'rain_delay':
      status.rain_delay = Number(data.delay ?? 0);
      return true;
    default:
      return false;
  }
}

async function onBhyveEvent(data) {
  if (applyEvent(data)) await publishAllStates();
}

// --- Lifecycle -----------------------------------------------------------------

async function start() {
  stop();
  if (!config.username || !config.password) {
    await gladys.setConnectionStatus(false, {
      en: 'Enter your B-hyve email and password in the Configuration tab.',
      fr: 'Saisissez votre e-mail et mot de passe B-hyve dans l’onglet Configuration.',
    });
    return;
  }

  client = new BhyveClient(config);
  try {
    const devices = await refreshFromCloud();
    await publishDevices();
    logger.info(`Found ${devices.length} B-hyve sprinkler timer(s)`);
  } catch (err) {
    logger.error('B-hyve initialization failed', err);
    await gladys.setConnectionStatus(false, {
      en: err instanceof AuthenticationError ? err.message : `Cannot reach B-hyve: ${err.message}`,
    });
    // Retry on the next poll rather than giving up.
  }

  client.on('event', (data) => onBhyveEvent(data).catch((err) => logger.error('Event handling failed', err)));
  client.on('connected', async () => {
    await gladys.setConnectionStatus(true).catch(() => {});
    // Events may have been missed while the stream was down.
    await refreshFromCloud().catch((err) => logger.warn(`Refresh after reconnect failed: ${err.message}`));
  });
  client.on('disconnected', () =>
    gladys.setConnectionStatus(false, { en: 'B-hyve event stream disconnected, reconnecting…' }).catch(() => {}),
  );
  client.connect();

  pollTimer = setInterval(async () => {
    try {
      const before = sprinklers.size;
      await refreshFromCloud();
      if (sprinklers.size !== before) await publishDevices();
    } catch (err) {
      logger.warn(`Poll failed: ${err.message}`);
    }
  }, config.poll_frequency * 1000);
}

function stop() {
  clearInterval(pollTimer);
  pollTimer = null;
  client?.close();
  client = null;
}

// --- Gladys handlers -------------------------------------------------------------

gladys.onScanRequest(async () => {
  if (client) await refreshFromCloud();
  await publishDevices();
});

gladys.onPoll(async () => {
  if (client) await refreshFromCloud();
});

gladys.onDeviceCreated(async () => {
  await publishAllStates();
});

gladys.onSetValue(async (device, feature, value) => {
  const bhyveId = [...sprinklers.keys()].find((id) => ids(id).device === device.external_id);
  if (!bhyveId || !client) throw new Error(`Unknown B-hyve device ${device.external_id}`);
  const key = feature.external_id.slice(device.external_id.length + 1);

  if (key === 'run-time') {
    runTimes[bhyveId] = Math.min(120, Math.max(1, Math.round(Number(value))));
    await saveRunTimes();
    await gladys.publishState(feature.external_id, runTimes[bhyveId]);
    return;
  }

  if (key === 'rain-delay') {
    const hours = Math.min(168, Math.max(0, Math.round(Number(value))));
    client.setRainDelay(bhyveId, hours);
    await gladys.publishState(feature.external_id, hours);
    return;
  }

  const zone = /^zone-(\d+)$/.exec(key);
  if (zone) {
    const station = Number(zone[1]);
    if (Number(value) === 1) {
      client.startWatering(bhyveId, station, runTimeOf(bhyveId));
    } else {
      client.stopWatering(bhyveId);
    }
    // Optimistic; the event stream confirms (or corrects) within seconds.
    await gladys.publishState(feature.external_id, Number(value) === 1 ? 1 : 0);
    return;
  }

  throw new Error(`Unknown feature ${feature.external_id}`);
});

gladys.onConfigUpdated(async (newConfig) => {
  config = normalizeConfig(newConfig);
  await start();
});

gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    await start();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
  }
});

gladys.handleShutdown(() => stop());

await loadRunTimes();
logger.info('Starting the B-hyve integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
