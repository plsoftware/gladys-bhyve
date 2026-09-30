// -----------------------------------------------------------------------------
// Orbit B-hyve -> Gladys external integration.
//
// One Gladys device per B-hyve sprinkler timer, with:
//   - one "watering" switch per zone (on = water for the run time, off = stop)
//   - "Run time" (minutes, writable): how long a switched-on zone waters
//   - "Rain delay" (hours, writable): 0 cancels it
//   - "Next watering" (text): next scheduled start, e.g. "Thu 1 Oct 09:00 · Bonsai"
//   - "Fault" (text): "OK" or the station faults the timer reports
// plus scene triggers (watering started / finished, zone fault / fault
// cleared) and scene actions (water a zone for N minutes, stop, rain delay).
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
import { formatNextWatering, formatFault, faultsOf } from './src/format.js';

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
// B-hyve device id -> its timer programs (a, b, c…), for program names.
const programsByDevice = new Map();
// B-hyve device id -> fault text last seen; absent until the first read, so a
// restart never fires a scene trigger by itself.
const lastFaults = new Map();
// B-hyve device id -> station watering at the last check (null = idle); absent
// until the first read, for the same reason.
const lastWatering = new Map();
let refreshSoonTimer = null;

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
      {
        name: 'Next watering',
        external_id: id.feature('next-watering'),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        read_only: true,
        has_feedback: false,
        keep_history: false,
        min: 0,
        max: 0,
      },
      {
        name: 'Fault',
        external_id: id.feature('fault'),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        read_only: true,
        has_feedback: false,
        keep_history: false,
        min: 0,
        max: 0,
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
    {
      device_feature_external_id: id.feature('next-watering'),
      text: formatNextWatering(device, programsByDevice.get(device.id)),
    },
    { device_feature_external_id: id.feature('fault'), text: formatFault(device) },
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
  try {
    const programs = await client.getPrograms();
    programsByDevice.clear();
    for (const program of programs) {
      if (!programsByDevice.has(program.device_id)) programsByDevice.set(program.device_id, []);
      programsByDevice.get(program.device_id).push(program);
    }
  } catch (err) {
    // Only costs the program names in "Next watering".
    logger.warn(`Could not read timer programs: ${err.message}`);
  }
  await publishAllStates();
  for (const device of devices) await checkTransitions(device);
  return devices;
}

/** A refresh a few seconds from now, coalescing bursts of events. */
function refreshSoon() {
  clearTimeout(refreshSoonTimer);
  refreshSoonTimer = setTimeout(() => {
    if (client) refreshFromCloud().catch((err) => logger.warn(`Refresh failed: ${err.message}`));
  }, 5000);
}

// --- Scene triggers -------------------------------------------------------------

async function fireSceneEvent(key, data) {
  logger.info(`scene event ${key}: ${JSON.stringify(data)}`);
  try {
    await gladys.publishSceneEvent(key, data);
  } catch (err) {
    // A refused event (older core, rate limit) must not break state handling.
    logger.error(`Cannot fire the scene trigger ${key}`, err);
  }
}

function zoneNameOf(device, station) {
  return zonesOf(device).find((z) => z.station === Number(station))?.name ?? `Zone ${station}`;
}

function programNameOf(device, letter) {
  if (!letter || letter === 'manual') return 'manual';
  const program = (programsByDevice.get(device.id) ?? []).find((p) => p.program === letter);
  return program?.name || `program ${String(letter).toUpperCase()}`;
}

async function checkTransitions(device) {
  await checkWatering(device);
  await checkFaults(device);
}

async function checkWatering(device) {
  const current = currentStation(device);
  const hadReference = lastWatering.has(device.id);
  const previous = lastWatering.get(device.id) ?? null;
  lastWatering.set(device.id, current);
  if (!hadReference || previous === current) return;

  const base = { timer: ids(device.id).device, timer_name: device.name };
  if (previous !== null) {
    await fireSceneEvent('watering_finished', {
      ...base,
      zone: zoneNameOf(device, previous),
      station: previous,
    });
  }
  if (current !== null) {
    const ws = device.status?.watering_status ?? {};
    await fireSceneEvent('watering_started', {
      ...base,
      zone: zoneNameOf(device, current),
      station: current,
      minutes: Number.isFinite(Number(ws.run_time)) ? Number(ws.run_time) : null,
      program: programNameOf(device, ws.program),
    });
  }
}

async function checkFaults(device) {
  const current = formatFault(device);
  const previous = lastFaults.get(device.id);
  lastFaults.set(device.id, current);
  if (previous === undefined || previous === current) return;

  const faults = faultsOf(device);
  const key = faults.length > 0 ? 'zone_fault' : 'fault_cleared';
  const data = {
    timer: ids(device.id).device,
    timer_name: device.name,
    fault: faults.length > 0 ? current : previous,
    fault_count: faults.length,
  };
  await fireSceneEvent(key, data);
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
        run_time: data.run_time,
        started_watering_station_at: data.started_watering_station_at,
      };
      status.run_mode = data.mode ?? 'manual';
      return true;
    case 'watering_complete':
    case 'device_idle':
      delete status.watering_status;
      if (data.event === 'device_idle') status.run_mode = 'off';
      // The next scheduled start moves once a run finishes.
      refreshSoon();
      return true;
    case 'change_mode':
      status.run_mode = data.mode ?? status.run_mode;
      // An empty station list is a stop.
      if (Array.isArray(data.stations) && data.stations.length === 0) delete status.watering_status;
      return true;
    case 'rain_delay':
      status.rain_delay = Number(data.delay ?? 0);
      refreshSoon();
      return true;
    case 'fault':
      status.station_faults = data.station_faults ?? [];
      return true;
    case 'program_changed':
      refreshSoon();
      return false;
    default:
      return false;
  }
}

async function onBhyveEvent(data) {
  if (!applyEvent(data)) return;
  await publishAllStates();
  const device = sprinklers.get(data.device_id);
  if (device) await checkTransitions(device);
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
  clearTimeout(refreshSoonTimer);
  refreshSoonTimer = null;
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

// --- Scene actions ----------------------------------------------------------------

function timerFor(fields) {
  if (!client) throw new Error('B-hyve is not connected');
  const all = [...sprinklers.values()];
  if (!fields.timer) {
    if (all.length === 1) return all[0];
    throw new Error('Choose a timer: this account has several');
  }
  const device = all.find((d) => ids(d.id).device === fields.timer);
  if (!device) throw new Error(`Unknown B-hyve timer ${fields.timer}`);
  return device;
}

/** A zone by station number or by name (case-insensitive). */
function zoneFor(device, value) {
  const wanted = String(value ?? '').trim();
  const zones = zonesOf(device);
  const zone =
    zones.find((z) => String(z.station) === wanted) ??
    zones.find((z) => z.name.toLowerCase() === wanted.toLowerCase());
  if (!zone) {
    throw new Error(`No zone "${wanted}" on ${device.name}: ${zones.map((z) => `${z.station} ${z.name}`).join(', ')}`);
  }
  return zone;
}

gladys.onSceneAction('water_zone', async (fields) => {
  const device = timerFor(fields);
  const zone = zoneFor(device, fields.zone);
  const minutes = Math.min(120, Math.max(1, Math.round(Number(fields.minutes ?? runTimeOf(device.id)))));
  client.startWatering(device.id, zone.station, minutes);
  return { timer_name: device.name, zone: zone.name, minutes };
});

gladys.onSceneAction('stop_watering', async (fields) => {
  const device = timerFor(fields);
  client.stopWatering(device.id);
  return { timer_name: device.name };
});

gladys.onSceneAction('set_rain_delay', async (fields) => {
  const device = timerFor(fields);
  const hours = Math.min(168, Math.max(0, Math.round(Number(fields.hours ?? 0))));
  client.setRainDelay(device.id, hours);
  return { timer_name: device.name, hours };
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
