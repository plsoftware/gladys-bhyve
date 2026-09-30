# Orbit B-hyve for Gladys

Controls Orbit B-hyve Wi-Fi sprinkler timers through the B-hyve cloud, using the
same API and event stream as the B-hyve app.

## Features (per timer)

- **<zone> watering** — one switch per zone. On waters that zone for the current
  *Run time*; off stops watering.
- **Run time** — minutes a switched-on zone waters (1–120, default 10).
- **Rain delay** — hours to suspend scheduled programs (0–168; 0 cancels).

Watering started by the timer's own schedule or from the B-hyve app is reflected
live over the event stream.

## Configuration

Enter your B-hyve account email and password. Then open the Discovery tab and
create the device.

## Troubleshooting

- *Login refused* — check the credentials in the B-hyve app.
- States lag — the event stream reconnects automatically; the refresh interval is
  a safety net.
- Logs: `docker logs` on the integration container.
