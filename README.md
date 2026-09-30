# gladys-bhyve

Orbit B-hyve sprinkler timers as a [Gladys Assistant](https://gladysassistant.com)
external integration.

Talks to the B-hyve cloud: REST for login and the device list, and the B-hyve
websocket event stream for commands and live state, so watering started by a
timer's own schedule or from the B-hyve app shows up in Gladys immediately.

## Features (per timer)

| Feature | Type | Behaviour |
|---|---|---|
| `<zone> watering` | switch | On waters the zone for *Run time*; off stops watering |
| Run time | duration, minutes | 1–120, default 10; persisted in `/data` |
| Rain delay | duration, hours | 0–168; 0 cancels |
| Next watering | text | Next scheduled start in the timer's timezone, e.g. `Thu 1 Oct 09:00 · Bonsai` |
| Fault | text | `OK`, or the station faults the timer reports |

## Scenes

**Triggers** (Add trigger → Integrations): *watering started*, *watering
finished* (filter by timer and zone name; variables `timer_name`, `zone`,
`station`, `minutes`, `program`), *zone fault*, *fault cleared* (variables
`timer_name`, `fault`, `fault_count`). Use them in messages as
`{{triggerEvent.data.zone}}` etc.

**Actions** (Add a step → Integrations): *water a zone* (zone name or number,
minutes), *stop watering*, *set rain delay* (hours, 0 cancels). The timer can
be left empty on an account with a single timer.

## Install

In Gladys: **Integrations → Install from GitHub → Developer mode: install from a
Docker image**, image `ghcr.io/plsoftware/gladys-bhyve:<version>`, and paste
`gladys-assistant-integration.json` as the manifest. Then enter the B-hyve email
and password in the Configuration tab and create the device from Discover.

## Release

Actions → **Release** → Run workflow → pick patch / minor / major. It bumps
`package.json` and the manifest, tags `vX.Y.Z`, and builds
`ghcr.io/plsoftware/gladys-bhyve:X.Y.Z` (+ `:latest`) for amd64 and arm64.

## Local build

```bash
docker build -t gladys-bhyve:dev .
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Credits

Cover icon: [Honeycomb icons created by Freepik – Flaticon](https://www.flaticon.com/free-icons/honeycomb).
