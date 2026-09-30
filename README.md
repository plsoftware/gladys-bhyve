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
