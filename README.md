# ShotReady

Pre-mix camera verification and body tracking for Canon EOS C80 / C50 cameras with
Blackmagic ATEM 2 M/E switchers. It sits beside Canon's RCCA: RCCA stays the operators'
control surface, ShotReady confirms everything is right before mixing starts.

**Read-only.** ShotReady only sends HTTP GET requests to cameras and only reads from the ATEM.
Writing settings stays off until Canon's XC documentation confirms which keys can be written.

## Run it

Install `dist/ShotReady-1.2.0-Windows-Setup.exe`, or unzip the portable build. From source:

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
| Bar | Always-on-top strip with WB, ISO, shutter, aperture, digital IS and waveform per camera. Drag to move, drag an edge to resize, toggle with the **Bar** button |
| Bodies | Online status, IP, MAC, firmware and lens of every body |
| Label sheet | Label, body, IP and lens for RCCA and operators: copy, CSV or print |
| Workload | Total runtime per body, across all sessions, and by label |
| Log | Swaps, verdict changes, lens changes, bodies dropping out |
| Settings | Labels, ATEM, login, team standard, body IPs |

## Mandatory settings

Checked on every camera: Gamma flat (any Canon Log passes, any colour gamma is red, because the
recorder must never get a colour picture), SDI output (3840x2160 whenever Constellation is selected),
Digital IS off, Tele-converter off and Base ISO range at or above the ISO.

A value the camera reports decides the row. If the Base ISO cannot be compared (for example it is
set to Auto), the row stays yellow until an operator presses **Confirm**, which holds for that lens
on that day.

Not checked: firmware, sensor mode, lens filter and lens stabilization. The C80 reports no setting
for sensor mode or for the lens stabilizer switch (checked with a lens attached), and the other two
are not wanted.

The key names are under `standards.mandatory` in `cameras.json`:

    "mandatory": { "digitalIS": ["c.1.eis"], "baseIso": ["c.1.me.baseiso"], "teleConverter": ["c.1.zoom.mode"] }

The card shows Card A and Card B as **No SD Card** when a slot cannot record: red and bold when
neither slot can, plain light text when only one is empty. The camera only says "recordable" or
"unrecordable", so a full, locked or unformatted card also shows as No SD Card.

The bar reads aperture from `c.1.me.diaphragm` (280 means F2.8). A dash on the bar means the
camera did not report that value.

## Live updates

Each camera pushes changes over one stream (`info.cgi?type=stream`, XC spec 3.2.2.1), and ShotReady
re-judges as soon as one arrives, with no network call. A regular check still runs every 5 seconds
as a safety net (Settings > Connections), because a network can die silently and the spec only
promises push for items it marks as update-notified.

Each stream uses one of the camera's client connections, which RCCA also needs. A camera that
refuses a stream is logged, retried every 30 seconds, and covered by the regular check.

## Live view and focus box

Each camera card on the Dashboard shows the camera's picture. The C80 has no continuous video
stream, so ShotReady asks for single frames (`image.cgi`) with several requests overlapping: about
10 to 18 frames a second per camera on a real C80. Pictures are only fetched for cameras on screen
(not while another tab is open or the window is minimised) and not for offline cameras. The more
cameras are on screen, the fewer overlapping requests each gets, so eight pictures do not swamp the
network: 1 or 2 cameras get 4 overlapping requests each (the most the C80 handled without errors),
3 or 4 cameras get 2, and 5 or more get 1. Set `liveViewParallel` (1 to 4) in `cameras.json` to
force a number. A wired connection matters: over a jittery Wi-Fi link the rate drops a lot.

The box over the picture is the camera's focus guide (`meta.cgi`): **green** when the camera reports
level 2 (in focus), **red** below that, with "front focus" or "back focus" in the corner. When the
camera sends no focus guide, no box is shown and the corner says "no focus data".

On the card, **Focus** is the AF / MF switch on the lens (`c.1.lens.focus`). **Continuous AF** is
read from the camera's focus mode (`c.1.focus`): auto means on, manual means off. The camera has no
setting named Continuous AF, so this mapping was worked out from a camera with the lens on AF and
Continuous AF off.

The checks are on the second tab, **Checks**. Each card shows how many are red or yellow, and
clicking it opens that camera's checks.

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

    npm test           # 5 unit tests, against simulated camera servers
    npm run test:e2e   # drives the real app in demo mode

`node test/packaged.mjs` checks the built app in live mode after `npm run dist:win`.

## Not built yet

These need something from outside this project, as listed in the project record:

- **Applying settings, copy from earlier camera, identify test:** need Canon's XC docs (writable keys).
- **System frequency check:** the key name is not in the prototype. The output format check
  covers part of it, since the camera must report 25.00p output to pass.
