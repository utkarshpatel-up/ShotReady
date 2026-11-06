# ShotReady

Pre-mix camera verification and body tracking for Canon EOS C80 / C50 cameras with
Blackmagic ATEM 2 M/E switchers. It sits beside Canon's RCCA: RCCA stays the operators'
control surface, ShotReady confirms everything is right before mixing starts.

**Read-only.** ShotReady only sends HTTP GET requests to cameras and only reads from the ATEM.
Writing settings stays off until Canon's XC documentation confirms which keys can be written.

## Run it

Install `dist/ShotReady-1.1.0-Windows-Setup.exe`, or unzip the portable build. From source:

    npm install
    npx install-electron
    npm start          # live
    npm run demo       # simulated cameras and switcher, no network needed

The installed app shows demo mode when started with `ShotReady.exe --demo`.

## First show on the real network

1. **Settings > Labels:** enter your exact ATEM names and each label's ATEM input.
2. **Settings > Connections:** enter the ATEM IP, plus the camera login if the cameras use one.
3. **Dashboard > Assign in order**, then set each body's label from the dropdown on its card.
4. Pick the switcher, pick **4K25** or **HD25**, and press **Run check**.

## Screens

| Screen | What it is for |
| --- | --- |
| Dashboard | READY / WARNINGS / NOT READY, a card per body with its label, PGM/PVW, camera matching |
| Bar | Always-on-top strip with WB, ISO, aperture, lens IS and digital IS per camera. Drag to move, drag an edge to resize, toggle with the **Bar** button |
| Bodies | Online status, IP, MAC, firmware and lens of every body |
| Label sheet | Label, body, IP and lens for RCCA and operators: copy, CSV or print |
| Workload | Total runtime per body, across all sessions, and by label |
| Log | Swaps, verdict changes, lens changes, bodies dropping out |
| Settings | Labels, ATEM, login, team standard, body IPs |

## Mandatory settings

Checked on every camera: Gamma flat (any Canon Log passes, any colour gamma is red, because the
recorder must never get a colour picture), SDI output (3840x2160 whenever Constellation is selected), Sensor mode
Full, Digital IS off, Base ISO range at or above the ISO, lens filter, Tele-converter off, Lens
stabilization off.

A value the camera reports decides the row. Anything it does not report stays yellow until an
operator presses **Confirm**, which holds for that lens on that day. The lens filter is always
confirmed by hand, because it is physical.

The key names are under `standards.mandatory` in `cameras.json`. Most are still empty, because
Canon's public XC spec predates the C80. Fill them in from a real `info.cgi` read-out:

    "mandatory": { "sensor": [], "digitalIS": ["c.1.eis", "c.1.is"], "baseIso": ["c.1.me.baseiso"], "teleConverter": ["c.1.zoom.mode"], "lensIS": [] }

The bar reads aperture from `c.1.me.diaphragm` (280 means F2.8). A dash on the bar means the
camera did not report that value.

## Live updates

Each camera pushes changes over one stream (`info.cgi?type=stream`, XC spec 3.2.2.1), and ShotReady
re-judges as soon as one arrives, with no network call. A regular check still runs every 5 seconds
as a safety net (Settings > Connections), because a network can die silently and the spec only
promises push for items it marks as update-notified.

Each stream uses one of the camera's client connections, which RCCA also needs. A camera that
refuses a stream is logged, retried every 30 seconds, and covered by the regular check.

## Waveform

The camera does not send waveform data: `WFM` exists only as a button for its own screen. ShotReady
reads one preview frame per second from each camera (`image.cgi`, 1024x576 JPEG) and shows peak and
average level, on a scale where video level 16 is 0% and 235 is 100%. Peak ignores the brightest
0.5% of the picture. Set `waveformMs` in `cameras.json` to change the rate, or 0 to turn it off.

These are measurements of a compressed preview, so compare them with the camera's WFM display
before trusting exact numbers.

## Lifetime hours

The camera does not send its hour meter over the network: it is not in `info.cgi` on a C80
(firmware 1.0.6.1) or in Canon's XC spec. Enter the reading from the camera once on the Workload
screen. ShotReady then adds on-time from the uptime the camera reports, including time before the
app was opened. A power cycle that happens entirely while ShotReady is closed is not counted.

## Finding a setting's key

    npm run watch -- 192.168.8.10

Prints each setting the camera pushes as it changes. Change something on the camera to see its key.

## Data

Kept in `%APPDATA%\ShotReady` (Settings > Open data folder): `cameras.json`,
`shotready-state.json`, `events.log`, `reports\`. A state file from the v0.2 prototype can be
copied in as it is. Camera passwords are encrypted with Windows' own protection.

To change the list of bodies or labels, edit `cameras.json` with the app closed.

## Tests

    npm test           # engine and service, against simulated camera servers
    npm run test:e2e   # drives the real app in demo mode

`node test/packaged.mjs` checks the built app in live mode after `npm run dist:win`.

## Not built yet

These need something from outside this project, as listed in the project record:

- **Applying settings, copy from earlier camera, identify test:** need Canon's XC docs (writable keys).
- **System frequency check:** the key name is not in the prototype. The output format check
  covers part of it, since the camera must report 25.00p output to pass.
