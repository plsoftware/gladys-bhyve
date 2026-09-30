// -----------------------------------------------------------------------------
// Orbit B-hyve cloud client.
//
// Protocol taken from the working Home Assistant component (sebr/bhyve-home-
// assistant 4.1.2, pybhyve): REST for login + device list, and a websocket
// event stream that both pushes device events and carries the commands.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'bhyve' });

const API_HOST = 'https://api.orbitbhyve.com';
const WS_URL = 'wss://api.orbitbhyve.com/v1/events';
const WEB_HOST = 'https://techsupport.orbitbhyve.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const HEARTBEAT_MS = 25_000;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 300_000;

export class AuthenticationError extends Error {}

export class BhyveClient extends EventEmitter {
  constructor({ username, password }) {
    super();
    this.username = username;
    this.password = password;
    this.token = null;
    this.ws = null;
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.closing = false;
  }

  headers() {
    return {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json; charset=utf-8',
      Origin: WEB_HOST,
      Referer: `${WEB_HOST}/`,
      'User-Agent': USER_AGENT,
      'orbit-app-id': 'Bhyve Dashboard',
      'orbit-api-key': this.token ?? 'null',
      'Orbit-Session-Token': this.token ?? '',
    };
  }

  async login() {
    const res = await fetch(`${API_HOST}/v1/session`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ session: { email: this.username, password: this.password } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      throw new AuthenticationError('B-hyve refused the login: check the email and password');
    }
    if (!res.ok) throw new Error(`B-hyve login failed: HTTP ${res.status}`);
    const body = await res.json();
    this.token = body.orbit_api_key;
    if (!this.token) throw new Error('B-hyve login returned no session token');
  }

  async request(path) {
    if (!this.token) await this.login();
    const doFetch = () =>
      fetch(`${API_HOST}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    let res = await doFetch();
    if (res.status === 401 || res.status === 403) {
      // Session expired: log in again once.
      this.token = null;
      await this.login();
      res = await doFetch();
    }
    if (!res.ok) throw new Error(`B-hyve ${path} failed: HTTP ${res.status}`);
    return res.json();
  }

  /** Sprinkler timers only (bridges and flood sensors are ignored). */
  async getSprinklers() {
    const devices = await this.request(`/v1/devices?t=${Date.now() / 1000}`);
    return devices.filter((d) => d.type === 'sprinkler_timer');
  }

  // --- Event stream ----------------------------------------------------------

  connect() {
    this.closing = false;
    this.openSocket().catch((err) => {
      logger.warn(`Event stream connection failed: ${err.message}`);
      this.scheduleReconnect();
    });
  }

  async openSocket() {
    // A fresh token per connection: the stream rejects stale sessions silently.
    await this.login();
    const ws = new WebSocket(WS_URL, { origin: WEB_HOST, headers: { 'User-Agent': USER_AGENT } });
    this.ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({ event: 'app_connection', orbit_session_token: this.token }));
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.resetHeartbeat();
      logger.info('Event stream connected');
      this.emit('connected');
    });

    ws.on('message', (raw) => {
      this.resetHeartbeat();
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }
      logger.debug(`event <- ${data.event} ${data.device_id ?? ''}`);
      this.emit('event', data);
    });

    ws.on('error', (err) => logger.warn(`Event stream error: ${err.message}`));

    ws.on('close', () => {
      clearTimeout(this.heartbeat);
      if (this.ws === ws) this.ws = null;
      this.emit('disconnected');
      if (!this.closing) this.scheduleReconnect();
    });
  }

  resetHeartbeat() {
    clearTimeout(this.heartbeat);
    this.heartbeat = setTimeout(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ event: 'ping' }));
        this.resetHeartbeat();
      }
    }, HEARTBEAT_MS);
  }

  scheduleReconnect() {
    if (this.closing || this.reconnectTimer) return;
    logger.info(`Reconnecting to B-hyve in ${this.reconnectDelay / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(payload) {
    if (!this.connected) throw new Error('B-hyve event stream is not connected');
    logger.info(`command -> ${JSON.stringify(payload)}`);
    this.ws.send(JSON.stringify(payload));
  }

  close() {
    this.closing = true;
    clearTimeout(this.heartbeat);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  // --- Commands --------------------------------------------------------------

  startWatering(deviceId, station, minutes) {
    this.send({
      event: 'change_mode',
      mode: 'manual',
      device_id: deviceId,
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      stations: [{ station, run_time: minutes }],
    });
  }

  stopWatering(deviceId) {
    this.send({
      event: 'change_mode',
      mode: 'manual',
      device_id: deviceId,
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      stations: [],
    });
  }

  setRainDelay(deviceId, hours) {
    this.send({ event: 'rain_delay', device_id: deviceId, delay: hours });
  }
}
