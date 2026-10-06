# meshqual

Map of MeshCore link quality. A Go backend (`relayd`) ingests packets published
by MeshCore observers over MQTT, and a Vue 3 + MapLibre frontend draws the links
coloured by SNR, with the last frames received on each link.

```
observers ──MQTT──▶ relayd ──┬── in-memory link table ──▶ /api/links (GeoJSON)
                             ├── TimescaleDB ───────────▶ /api/links/{a}/{b}/history
                             └── SSE ───────────────────▶ /api/stream
```

## Quick start

```bash
cp .env.example .env    # set POSTGRES_PASSWORD
make up                 # TimescaleDB, mosquitto, relayd, web (Caddy)
```

The map is served on http://localhost:9090. `make logs` follows the backend,
`make down` stops everything.

## Development

```bash
make dev                              # backend on :8080, no database, no broker
cd frontend && npm install && npm run dev   # http://localhost:5173
```

The Vite dev server proxies `/api` to `MESHQUAL_API_URL` (default
`http://localhost:8080`).

To work without a live broker, replay a capture of MQTT messages (one
`{"topic": ..., "payload": ...}` object per line):

```bash
cd backend && MESHQUAL_REPLAY_FILE=../capture.ndjson go run ./cmd/relayd
```

## Configuration

`relayd` reads the JSON file given by `-config` or `MESHQUAL_CONFIG`
(see [backend/config.example.json](backend/config.example.json)), then applies
these environment overrides:

| Variable | Purpose |
|---|---|
| `MESHQUAL_DSN` | PostgreSQL/TimescaleDB DSN. Empty means in-memory only. |
| `MESHQUAL_ADDR` | Listen address (default `:8080`) |
| `MESHQUAL_LOG_LEVEL` | `debug`, `info`, `warn`, `error` |
| `MESHQUAL_CORS_ORIGINS` | Comma-separated allowed origins |
| `MESHQUAL_REPLAY_FILE` | NDJSON file to replay as an extra source |
| `MESHQUAL_MQTT_<ID>_URL` / `_USERNAME` / `_PASSWORD` | Override a source's broker settings. `<ID>` is the source `id` in upper case. |
| `MESHQUAL_MQTT_<ID>_ENABLED` | `false` skips the source (e.g. `MESHQUAL_MQTT_COMCHAN_ENABLED=false` to use only the local broker) |

Frontend variables are read at build time, from `.env` by `docker compose build
web`. Rebuild the image after changing them.

| Variable | Purpose |
|---|---|
| `VITE_API_BASE` | API origin without `/api`, e.g. `https://api.example.org`. Empty means same origin (Caddy proxies `/api` to relayd). When set, add the frontend origin to `MESHQUAL_CORS_ORIGINS`. |
| `VITE_TILE_URL` | Raster tile URL template |
| `MESHQUAL_API_URL` | Proxy target for `/api` in `npm run dev` only |

### MQTT sources

Each entry in `sources` is one broker subscription:

```json
{ "id": "local", "brokerUrl": "mqtt://mosquitto:1884", "topics": ["meshcore/+/+/packets"] }
```

A source can also be turned off in the file with `"enabled": false`.

Supported schemes: `mqtt://`, `mqtts://`, `ws://`, `wss://`. Topics follow the
`meshcore/<IATA>/<observer key>/packets` convention used by
[meshcoretomqtt](https://github.com/Cisien/meshcoretomqtt).

Coverage depends entirely on the brokers you subscribe to:

- `mqtt.comchan.net` (in the example config) only carries Texas traffic.
- LetsMesh (`mqtt-eu-v1.letsmesh.net`, `mqtt-us-v1.letsmesh.net`) and similar
  brokers only allow reading with a subscriber account issued by their
  operators. Observer keys can publish but not subscribe.
- The bundled mosquitto (`local` source) receives whatever your own observers
  publish to it.

### Bundled broker

The bundled mosquitto ([deploy/mosquitto/](deploy/mosquitto/)) requires an
account for every client. Any account may publish under `meshcore/`; only
`relayd` may read.

```bash
make up                        # creates an empty deploy/mosquitto/passwd on first run
make mqtt-user NAME=relayd     # then set MESHQUAL_MQTT_LOCAL_USERNAME/_PASSWORD in .env
make mqtt-user NAME=alice      # one account per contributor
docker compose up -d relayd    # reload relayd with its credentials
```

It listens on `1884` (plain MQTT, credentials in clear text: keep it on your
network) and on `127.0.0.1:9001` (WebSocket) for a TLS reverse proxy; set
`MQTT_WS_BIND` and `MQTT_WS_PORT` in `.env` to change that address and port; see
[deploy/nginx-mqtt.conf](deploy/nginx-mqtt.conf). Observers then use
`wss://<host>:443/mqtt` with their account, for example on the observer
firmware:

```
set mqtt3.preset custom
set mqtt3.server wss://mqtt.example.org:443/mqtt
set mqtt3.username alice
set mqtt3.password <password>
```

Accounts are not tied to a node key, so an account holder could publish as any
observer. This is a test setup, not an open service.

## How links are built

The `path` field of a MeshCore packet only holds routing hashes, no signal data.
The SNR reported by an observer therefore only describes the last hop. Links come
in three kinds:

| `kind` | Source | SNR |
|---|---|---|
| `measured` | last hop → observer | measured by the observer |
| `trace` | `TRACE` packets, each repeater appends its SNR | per hop |
| `topology` | two adjacent hops in an observed path | none (drawn dashed grey) |

A hop whose hash matches several known nodes creates no link. A link is only
drawn when both ends have advertised a position.

SNR is kept per direction of transmission (A → B is what B measured hearing A).
A link's colour is the weaker direction's median; directions are never pooled,
so a strong one cannot hide a failing one. With a single observer the measured
direction is usually the only one. Below `minDirectionSamples` (default 3)
values in a direction the result is marked as low confidence and no asymmetry is
computed. The map's **Par sens** view draws one lane per direction instead, and
can show unbalanced links only ("déséquilibré"): both directions measured,
medians at least `asymmetryThresholdDb` (default 6 dB) apart. The **Fonctionnel** view keeps only links
measured both ways whose weaker direction is at least -5 dB.

A link leaves the map once it has not been heard for `liveWindow` (default
24 h), unless it still holds a signal measurement: SNR and RSSI values are kept
for `measureRetention` (default 14 days), because signal between two repeaters
only comes from occasional traces. The map fades such links as the measurement
ages, and the link panel says how old it is.

Nodes not heard for `nodeMaxAge` (default 48 h) leave the map. A node is heard
when it adverts, relays in a path that names it unambiguously, or observes.
It stays known to the server, which still needs it to read paths.

Links longer than `maxHopKm` (default 300 km) are dropped as path-hash collisions
between distant meshes.

SNR colour thresholds (`-12 / -5 / 5` dB) are served by `/api/config`.

## Altitude and line of sight

- The **Calques** button under the zoom controls toggles an **Altitude** layer:
  elevation as a thermal colour ramp (dark blue low, red high) under the links.
  The ramp is stretched to the altitudes in view each time the map moves, with
  the range shown beside the button. Elevation comes from the AWS Open Data
  [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (worldwide,
  keyless), drawn by the browser.
- The link panel ends with a foldable **Ligne de vue** section (France only,
  IGN Géoplateforme, free and keyless): the ground profile between the two
  nodes, the straight line between antennas, the earth's bulge (k = 4/3) and
  the first Fresnel zone, with a verdict (clear when 60% of the zone is free). relayd fetches the profile from the IGN
  `elevationLine` service and caches it. Settings: `losAltimetryUrl` (empty
  disables it), `losResource`, `losFreqMHz` (869.525), `losAntennaM` (10 m,
  assumed at every node). The model is bare ground, without buildings or trees.

## API

| Route | Description |
|---|---|
| `GET /api/links?bbox=&kind=&minSamples=&limit=` | Links as a GeoJSON `FeatureCollection` |
| `GET /api/nodes?bbox=` | Nodes as GeoJSON points |
| `GET /api/links/{a}/{b}` | Aggregated link state |
| `GET /api/links/{a}/{b}/frames?limit=10` | Last frames on the link |
| `GET /api/links/{a}/{b}/history?window=24h&bucket=1h` | SNR time series (requires TimescaleDB) |
| `GET /api/links/{a}/{b}/profile` | Line of sight over the IGN ground profile |
| `GET /api/stream?link=A:B` | SSE: `links:changed`, `frame` |
| `GET /api/config` | SNR thresholds and refresh settings |
| `GET /api/health` | Source and pipeline status |

## Tests

```bash
make test    # go test -race, then vue-tsc and vitest
make lint
```

## Known limitations

- Advert signatures are decoded but not verified.
- `TRACE` packets are rare in passive observation, so most links are `measured`
  or `topology`.
