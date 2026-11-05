# Remember That One Trip

Turn a folder of travel photos into an interactive route map and a short travel film with music – entirely in your browser. No installation, no account, no upload.

Point the app at a folder of photos from a trip. It reads where and when each photo was taken, works out where you stopped and how you travelled between the stops (car, train, ferry, flight …), draws the route along real roads and rail lines, and records a small film: the map follows your route and every stop gets a montage of the photos and video clips you took there.

> The user interface is currently in **Swedish**. Translations are very welcome – see [Contributing](#contributing).

## Features

- **Reads your photos locally** – GPS position and time from JPEG/HEIC EXIF data, and from phone videos (MP4/MOV).
- **Finds your stops** – photos taken close together (within 1.5 km, no gap longer than 6 hours) form one stop. Photos without GPS are attached to the stop closest in time.
- **Guesses how you travelled** – walking, car or flight, based on distance and the time between photos. You can change the mode of any leg: car, bus, train, bike, walking, boat/ferry or flight.
- **Follows real routes** – roads (including ferries such as Rødby–Puttgarden), bike paths, footpaths and railway tracks, from free OpenStreetMap-based routing services.
- **Your own waypoints** – add places you passed without taking photos anywhere along the route; they behave like any other stop.
- **Start and end point** – e.g. your home, so the trip there and back is included.
- **Trip summary** – total distance along the route, distance per mode of transport, the farthest point from home, days, stops.
- **Map styles** – classic, silver, retro, National Geographic, pastel, terrain, ocean, black & white, dark, night, aubergine and satellite.
- **Travel film** – choose which photos and clips appear at each stop, pick a length and pace, and create an MP4 film in 720p, 1080p (default) or 4K (H.264, 30 fps) with generated travel music or your own audio file. The film is rendered frame by frame – usually faster than real time, and it keeps going even if the window is hidden. It is saved straight into the trip folder.
- **Remembers everything** – name, reason for the trip, start/end point, transport modes, waypoints, routes and your film selection are stored in a small JSON file in the trip folder.

## Use it

**Option 1 – web (easiest):** open the hosted version in Chrome or Edge, e.g. `https://<your-github-user>.github.io/remember-that-one-trip/` once GitHub Pages is enabled (see [Publishing](#publishing-on-github-pages)).

**Option 2 – offline file:** download [`index.html`](index.html) and double-click it. It is a single self-contained file.

Then:

1. Click **Välj resmapp…** (*Choose trip folder*) and select a folder with photos from one trip.
2. The first time, give the trip a name, write a line about why you went, and set a start point (and optionally an end point).
3. Explore the map and timeline. Change transport modes, add waypoints, pick a map style.
4. Click **▶ Skapa film** (*Create film*), choose photos and clips per stop, choose music, and click **● Skapa filmen**. You can keep using the computer while it renders.

### Requirements

| | |
|---|---|
| **Browser** | Chrome or Edge on a desktop/laptop. They can read *and write* to a folder (File System Access API) and encode video (WebCodecs). Firefox and Safari can read the photos, but cannot save the trip file or the film into the folder (the film can still be downloaded); without WebCodecs the film is recorded in real time instead, and the window must stay visible. |
| **Photos** | Taken with location turned on (default on most phones). |
| **Internet** | For map tiles, place names and routes. Your photos are never uploaded. |
| **Videos** | Most phones record HEVC (H.265). Chrome/Edge play it if the computer supports HEVC; otherwise clips are marked as unplayable and skipped. |
| **HEIC photos** | Shown on the map, but Chrome cannot decode HEIC images, so they are skipped in the film. |

Nothing needs to be installed.

## Privacy

- Photos and videos are read by the browser on your computer. **They are never uploaded anywhere.**
- To show place names and routes, the **coordinates of your stops** (not the photos) are sent to the services listed below. Viewing the map requests map tiles for the area you look at.
- The trip file (`remember-that-one-trip.json`) and the film are written only to the folder you chose.

## Third-party services

All are free and require no API key, but they are run by others and have fair-use policies. They are fine for personal use; a busy public deployment should use its own keys or servers.

| Purpose | Service | Notes |
|---|---|---|
| Map tiles | [Esri ArcGIS Online](https://www.esri.com/) basemaps | Keyless tile services; check Esri's terms for commercial use. |
| Place names & search | [OpenStreetMap Nominatim](https://nominatim.org/) | Max ~1 request/second ([usage policy](https://operations.osmfoundation.org/policies/nominatim/)). The app throttles itself. |
| Car, bus, bike, walking routes incl. ferries | [Valhalla](https://valhalla.github.io/valhalla/) on FOSSGIS servers (`valhalla1.openstreetmap.de`) | Primary router. |
| Fallback routes | [OSRM](https://project-osrm.org/) demo server and FOSSGIS OSRM (`routing.openstreetmap.de`) | Used if Valhalla does not answer. |
| Train routes | [BRouter](https://brouter.de/) (`rail` profile) | Follows railway tracks; no timetables. |

Map and route data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). Routes are cached in the trip file, so each leg is only requested once.

## How it works

- **Single file, no framework.** `index.html` contains the app, [Leaflet](https://leafletjs.com/) for the interactive map, [exifr](https://github.com/MikeKovarik/exifr) for reading EXIF data and [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) for writing MP4 files.
- **Stops:** photos sorted by time are grouped while they stay within 1.5 km of the group centre. Video location comes from the `©xyz` atom of MP4/MOV files.
- **Transport guess:** < 1.5 km → walking; very fast over long distances (or much faster than driving would take) → flight; otherwise car. Legs through your own waypoints are guessed from the whole stretch between real stops.
- **Film:** drawn frame by frame on a `<canvas>` (map tiles, route, animated vehicle, Ken Burns photo montage, video clips seeked frame-accurately), encoded with the WebCodecs `VideoEncoder` (H.264) and `AudioEncoder` (AAC, or Opus where AAC is unavailable), and muxed into a regular MP4 with the metadata at the start. Browsers without WebCodecs fall back to real-time recording with `MediaRecorder`.
- **Music:** generated with the Web Audio API (rendered offline with `OfflineAudioContext` for the film) – a seeded chord progression, arpeggio, bass, drums and melody, unique per trip. No audio files, no licensing issues.

## Development

```bash
npm install      # fetches Leaflet, exifr and mp4-muxer (build-time only)
npm run build    # writes index.html
```

Requires Node.js 18 or newer. Source files:

| File | Contents |
|---|---|
| `src/index.template.html` | Markup and CSS. Library and app code are inlined at the `/*…*/` markers. |
| `src/app.js` | Folder reading, EXIF/video metadata, stops, transport modes, routing, map, timeline, setup dialog, waypoints, map styles. |
| `src/film.js` | Film planning, photo/clip selection UI, canvas renderer and recording. |
| `src/music.js` | Generated travel music. |
| `scripts/build.mjs` | Inlines everything into `index.html`. |

Always edit `src/` and rebuild; `index.html` is generated but committed so the app can be served directly by GitHub Pages. Code comments are partly in Swedish.

## Publishing on GitHub Pages

1. Push the repository to GitHub.
2. Go to **Settings → Pages**, choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
3. After a minute the app is available at `https://<your-github-user>.github.io/remember-that-one-trip/`.

## Contributing

Issues and pull requests are welcome. Ideas:

- English (and other) translations of the interface
- Snapping the drawn route to waypoints by dragging the line
- Optional API keys for commercial routing/map providers
- Better handling of HEIC images in the film

## License

[MIT](LICENSE). Bundled third-party code (Leaflet, exifr, mp4-muxer) keeps its own licence – see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
