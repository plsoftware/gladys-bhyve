// -----------------------------------------------------------------------------
// Human-readable text for the "Next watering" and "Fault" features.
//
// Pure functions of a B-hyve device payload (plus its timer programs), so they
// are testable without the cloud or Gladys.
// -----------------------------------------------------------------------------

const NOTHING_SCHEDULED = 'Nothing scheduled';
const NO_FAULT = 'OK';

function timezoneOf(device) {
  return device.timezone?.timezone_id || 'UTC';
}

function zoneName(device, station) {
  const zone = (device.zones ?? []).find((z) => Number(z.station) === Number(station));
  return zone?.name || `Zone ${station}`;
}

/**
 * "Thu 1 Oct 09:00 · Bonsai" — the next scheduled start in the timer's own
 * timezone, followed by the names of the programs that start then.
 * @param {object} device B-hyve device payload
 * @param {object[]} [programs] B-hyve timer programs of this device
 * @returns {string}
 */
export function formatNextWatering(device, programs = []) {
  const raw = device.status?.next_start_time;
  const when = raw ? new Date(raw) : null;
  if (!when || Number.isNaN(when.getTime())) return NOTHING_SCHEDULED;

  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: timezoneOf(device),
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(when);
  const part = (type) => parts.find((p) => p.type === type)?.value ?? '';
  let text = `${part('weekday')} ${part('day')} ${part('month')} ${part('hour')}:${part('minute')}`;

  const names = (device.status?.next_start_programs ?? []).map((letter) => {
    const program = programs.find((p) => p.program === letter);
    return program?.name || `program ${String(letter).toUpperCase()}`;
  });
  if (names.length > 0) text += ` · ${names.join(', ')}`;

  const rainDelay = Number(device.status?.rain_delay ?? 0);
  if (rainDelay > 0) text += ` (rain delay ${rainDelay}h)`;
  return text;
}

/**
 * The station faults of a device as a list of readable strings. The payload
 * shape of a fault is not documented, so every field is read defensively.
 * @param {object} device B-hyve device payload
 * @returns {string[]}
 */
export function faultsOf(device) {
  const faults = device.status?.station_faults;
  if (!Array.isArray(faults) || faults.length === 0) return [];
  return faults.map((fault) => {
    if (typeof fault !== 'object' || fault === null) return String(fault);
    const station = fault.station ?? fault.station_id;
    const what =
      fault.fault_type ?? fault.type ?? fault.fault ?? fault.message ?? fault.description ?? fault.code;
    const where = station != null ? zoneName(device, station) : 'Timer';
    return what != null ? `${where}: ${what}` : `${where}: ${JSON.stringify(fault)}`;
  });
}

/**
 * "OK", or the faults joined with "; ".
 * @param {object} device B-hyve device payload
 * @returns {string}
 */
export function formatFault(device) {
  const faults = faultsOf(device);
  return faults.length === 0 ? NO_FAULT : faults.join('; ');
}
