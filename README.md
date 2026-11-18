# ShotReady

Pre-mix camera verification and body tracking for Canon EOS C80 / C50 cameras with
Blackmagic ATEM 2 M/E switchers. It sits beside Canon's RCCA: RCCA stays the operators'
control surface, ShotReady confirms everything is right before mixing starts.

ShotReady reads from the ATEM, and finds it by itself on Ethernet or Wi-Fi. The one thing it changes
on the switcher is a cut of Media Player 1 or 2 to program, when you press **F1** or **F2**. It writes to
cameras only for tally lamps and when you ask it to, with **Adjust** or **Copy settings** on a camera's
card, the keyboard, or the all-camera buttons on the Checks tab.

## Run it

Install `dist/ShotReady-1.9.0-Windows-Setup.exe`, or unzip the portable build (`ShotReady-1.9.0-Windows-Portable.zip`) and run `ShotReady.exe`. From source:

    npm install
    npx install-electron
    npm start          # live
    npm run demo       # simulated cameras and switcher, no network needed

On Windows, double-click **start-windows.bat** in the source folder (or **start-windows-demo.bat** for
simulated cameras). The first time it installs the packages and Electron, which needs Node.js
(https://nodejs.org) and the internet; after that it just starts ShotReady.

The installed app shows demo mode when started with `ShotReady.exe --demo`.

## First show on the real network

1. **Settings > Labels:** enter your exact ATEM names and each label's ATEM input.
2. **Settings > Connections:** enter the camera login if the cameras use one. The ATEM is found
   automatically; enter its IP only if you want ShotReady to try that address first.
3. **Dashboard > Assign in order**, then set each body's label from the dropdown on its card.
4. Pick the switcher, pick **4K25** or **HD25**, and press **Run check**.

## Screens

| Screen | What it is for |
| --- | --- |
| Dashboard | ATEM status (CONNECTED in green), camera checks summary, a card per body with its label, PGM/PVW |
| Video out | Plays a video to the HDMI display through your inverse LUT, audio to the audio jack, or sends a screen live through any LUT |
| Stream | Streams the program live to YouTube, a Zoom webinar or event, or any RTMP server |
| Bar | Always-on-top strip with WB, ISO, shutter, aperture, digital IS and waveform per camera. Drag to move, drag an edge to resize, toggle with the **Bar** button |
| Bodies | Online status, IP, MAC, firmware and lens of every body |
| Label sheet | Label, body, IP and lens for RCCA and operators: copy, CSV or print |
| Workload | Total runtime per body, across all sessions, and by label |
| Log | Swaps, verdict changes, lens changes, bodies dropping out |
| Settings | Labels, ATEM, login, team standard, body IPs |

## Top of the screen

The top left says whether the ATEM is connected:

| Shows | Means |
| --- | --- |
| **CONNECTED** (green) | A switcher answered. Its name, address and video format are underneath. Hover to see how it was found. |
| **SEARCHING FOR ATEM…** / **CONNECTING TO ATEM…** (yellow) | Looking on every network, or trying an address. |
| **NO ATEM FOUND** (red) | Nothing answered anywhere. The networks searched are listed, and the search repeats by itself. |
| **ATEM NOT CONNECTED** (red) | It was connected (or has an address in Settings) and has gone. ShotReady keeps retrying and searching. |

Beside it, **Camera checks** counts the red and yellow findings on the cameras that have a label, and
names the first few (hover for all of them, click to open the Checks tab). A **red** finding is any of:
a camera not answering, two cameras on one IP or the wrong body on an IP, the wrong model, SDI output not
matching the profile (Constellation needs 3840x2160), a colour gamma, colour bars on, no recordable SD card,
Digital IS or Tele-converter on, ISO above the Base ISO, the ATEM in a different video format from the
profile (4K25 or HD25), or no camera assigned to any label. Spare cameras are not counted.

With one camera, set every body you do not have today to **Spare** on its card. A body that is on a
label but switched off counts as a camera not answering.

## Finding the ATEM

Leave **ATEM IP address** blank in Settings and ShotReady finds the switcher itself, wherever it is
plugged in. It searches every network adapter the computer has, Ethernet and Wi-Fi alike, two ways at once:

- **Bonjour:** ATEM software announces the switcher on the network. The question is asked on each adapter.
- **Control port:** every ATEM answers the opening packet of its control protocol (UDP 9910). That one
  packet is sent to each address on each network the computer is on (a /24 around the computer on a
  network bigger than a /22), on each camera's network, and to Blackmagic's factory address
  192.168.10.240. This finds switchers that do not announce themselves.

An address entered in Settings is tried first, then the address it was last found at, then the search.
If nothing answers, the search repeats (after 15 s, 30 s, then every minute). A connected switcher that is
gone for 10 seconds is searched for again, so one moved from Ethernet to Wi-Fi is found at its new
address. **Search now** in Settings lists every switcher that answers, with how and on which network it was
found. Untick **Find the ATEM automatically** to use only the address in Settings.

If none is found, check the switcher is on and on the same network as the computer. An ATEM at its
factory address (192.168.10.240) needs the computer to have a 192.168.10.x address to be reached.

## Tally

With an ATEM connected, each camera's tally lamp follows the switcher: `program` when its input is
on air on M/E 1 (including keyers and anything fed in from another M/E), `preview` when it is on
preview, off otherwise. The label's **ATEM input** in Settings says which input is which; with none
set, Cam-01 is input 1, and so on. Set `tallyFromAtem` to `false` in `cameras.json` to turn this off.

## Record

**REC** on a camera's card starts that camera recording. It is greyed out when the camera has no SD
Card it can record to. While recording the button turns red, and one click on it stops recording.
The button shows what the camera reports, so it only turns red once the camera is recording.

## Adjust a camera

**Adjust** on a camera's card opens dropdowns for shutter, white balance, Kelvin, tint, Base ISO, ISO, ND
and iris, plus **Closer** and **Further** buttons you hold to push focus. It also turns the camera's on-screen display on or off; it cannot be turned on for a live camera. They list only the values that camera offers right now, and a change goes to the camera as
soon as it is picked. A setting that does not apply in the camera's current mode is not shown.

**Saturation** is listed too on a camera that reports a saturation setting it takes changes to (the
name of the setting differs between models). If a camera's saturation is not listed, use **Save settings
list** on the Bodies tab and send the file: it holds every setting the camera reports, by name.

The card shows **ISO** in red when it is above the camera's Base ISO range (a grainy picture that has
lost sharpness); hover it for the Base ISO.

**Power** shows where a camera's power comes from: DC (the C80's DC input), USB-C (the C50 has no DC
input and runs on USB-C Power Delivery, such as Canon's PD-E2) or Battery, which is in red. Only a
camera that says it runs on its battery counts as on battery, and the low battery warning (under 30%)
is given only then: on USB-C a low battery is charging. When a camera goes onto its battery (the cable
came out) the Log says so in red, and in green when the power is back. The Log also shows, once, what
a camera reports for a power source other than plain DC or battery. If a C50 on USB-C still shows
Battery, that Log line or its settings list shows the name it uses.

## Digital IS on every camera

Under **Copy settings from** in any camera's **Adjust**: **Digital IS · all cameras** with **On** and
**Off**, and that camera's state beside it. One press sets Digital IS on every reachable camera, using
the camera's own first On mode (on1 on a C80). A message names the cameras changed, any on program
(in Mixer mode they change on air too), any that did not take it, have no Digital IS, are offline, or
are locked in Assistant mode (live cameras are left out there). The Digital IS check stays: with it on,
a camera's check shows red until it is turned off again.

## Copy settings from another camera

At the top of **Adjust**: pick another camera under **Copy settings from**, then **Compare…**. The list
shows each picture setting that differs, what this camera has now and what it would get, with a tick
box each. **Copy** sends the ticked ones in a safe order (a mode before its value: white balance before
Kelvin, shutter mode before shutter) and says which the camera did not take.

Copied: gamma, white balance (mode, Kelvin, tint), Base ISO, ISO or gain, shutter, ND, and the picture's
detail settings (knee, black, colour matrix, saturation and the like). Never copied: iris, sensor mode,
recording format and timecode, which belong to the body or the recording. Only settings this camera
says it takes are offered; others are listed greyed out with the reason. For a camera on program the
dialog warns that its picture changes on air, and in Assistant mode a live camera cannot be changed.

## Focus

**1-Shot AF** sends the XC command `control.cgi?c.1.focus.action=one_shot` (one_shot is a focus action;
`c.1.focus` itself only takes auto or manual). It works whenever the lens switch is on **AF**, in any focus
mode, as with Canon's own remotes. The lens switch is asked from the camera at the moment of the press, so a
reading a few seconds old never blocks it. If the camera refuses, its answer is shown and logged.

Click the picture to focus there. With an AF frame that can be placed (Spot, Zone and so on), the frame
moves to the click and the camera focuses on it. The box moves when the camera reports the new position.

**AF frame: Auto** in yellow on the picture means the camera's AF frame is set to Auto (Whole Area AF):
the camera chooses what to focus on, often a face, and the box cannot be placed. A click then does a plain
1-Shot AF. To focus where you click, set **AF frame** to Spot or Zone under Adjust. This is said once, not
on every click.

**People Priority:** the people the camera has detected are outlined on its picture (blue: the one it
is following). The person nearest the cursor is outlined in bright white, and a click puts the AF frame
on that person's face and focuses on them, rather than on the exact spot clicked. A click away from
everyone (more than a quarter of the picture) works as before. With the AF frame on **Auto**, the camera
always picks the person itself, so a click on a person sends nothing and offers **Use Zone AF frame**:
one press sets the AF frame to Zone (People Priority keeps working) and focuses the person clicked.

On **MF** the focus guide box still shows where the focus is, as before, and a click (on a person or
anywhere) moves the focus guide there without any autofocus.

On a camera that is on program a click never focuses: the box moves, and focus waits for **1-Shot AF**.
With Continuous AF on, a click only moves the box: the camera follows it by itself.

## Keyboard

With the ShotReady window in front, **W** raises and **S** lowers ISO by one step, and **D** raises and
**A** lowers Kelvin by one step (white balance must be on Kelvin). Choose who they are for at the top of
the window:

- **Mixer**: the camera the switcher has on preview (M/E 1 first). A camera also on program is left alone.
- **Assistant**: the camera last clicked on, which gets a blue outline. A camera on program cannot be
  selected or changed in this mode, and nothing can be changed while the ATEM is disconnected.

**F1** cuts Media Player 1, and **F2** Media Player 2, to program on M/E 1: a cut, no transition. They
work in Mixer mode only, and only with the ATEM connected. These two keys are the only thing ShotReady
ever changes on the switcher.

While a camera's menu is open (see Camera menu), W A S D move in the menu instead.

## HDMI View Assist

The Checks tab shows whether View Assist is on for each camera's HDMI output. When it is on the row is
yellow, as the HDMI monitor then shows a converted picture instead of the Log picture, and **Turn off**
switches it off. SDI is not affected.

## Camera menu

- **M** turns on the on-screen display of the camera the mode points at (Mixer: the one on preview,
  Assistant: the selected one) and opens its main menu. It does nothing to a camera on program.
- While the menu is open: **W** up, **A** left, **S** down, **D** right, **Space** to select, and
  **Q** or **Esc** to go back a level. At the top level that closes the menu and leaves the display on.
- **Esc** with no menu open turns the display off.

With no menu open, W and S change ISO as usual. Nothing is sent to a camera on program.

## All-camera buttons

At the top of the Checks tab:

- **Set default settings on all cameras** sends the team's gamma, shutter, ND 0, Tele-converter OFF and
  Digital IS OFF to every reachable camera. SDI output is set to match the ATEM's video mode on a camera that takes its resolution over the network (never one on program); a camera that does not, such as a C80 on firmware 1.0.6.1, is listed, to be set in its menu.
- **Send WB to all cameras** sends the Kelvin and tint you type.

Each shows what will change first, and Send always sends every setting, even one a camera already has.

## Windows security warnings

The app is not code-signed, so Windows shows **Windows protected your PC** the first time a downloaded copy
runs (**More info > Run anyway**). Signing needs a certificate in your organisation's name, which cannot be
made here:

- **Microsoft Trusted Signing** (Azure): a monthly subscription; Microsoft checks the organisation's identity,
  then signs with a certificate Windows trusts. electron-builder supports it (`win.azureSignOptions`).
- **A code-signing certificate** from a certificate authority (Sectigo, DigiCert, SSL.com and others), kept
  on a hardware key as the rules now require. Building on Windows with `CSC_LINK` and `CSC_KEY_PASSWORD`
  set signs the app and installer automatically.

Either way, SmartScreen's trust builds up as the signed app is downloaded and run. Until then, for your own
computers: right-click the downloaded zip, **Properties > Unblock**, before unzipping, and Windows does not
ask. If Defender itself ever flags the file, it can be sent to Microsoft as a false positive.

## Updating

**Check for updates** (bottom right) asks GitHub for the latest version and shows what changed.
**Update now** then does one of three things, depending on how ShotReady is running:

- **Installed copy:** downloads the latest release's installer, checks it against the release's
  SHA-256 file (a mismatch is deleted, never run), installs it and restarts. The repository is
  private, so this uses the GitHub CLI, which must be installed and signed in (`gh auth login`).
  No token is stored in ShotReady.
- **Run from source (`npm start`):** `git fetch`, then `git pull --ff-only`. It refuses if the
  folder has uncommitted changes or commits GitHub lacks. If packages changed, it reinstalls them
  after exiting (progress in `update.log` in the data folder) and starts again.
- **Portable zip:** cannot replace itself. It shows what is new and opens the download page.

Monitoring stops for a few seconds during an update, so do it between shows.

## Mandatory settings

Checked on every camera: Gamma flat (any Canon Log passes, any colour gamma is red, because the
recorder must never get a colour picture), SDI output (the ATEM's own video mode when it is connected, else the profile's),
Digital IS off, Tele-converter off and Base ISO range at or above the ISO.

A value the camera reports decides the row. If the Base ISO cannot be compared (for example it is
set to Auto), the row stays yellow until an operator presses **Confirm**, which holds for that lens
on that day.

Not checked: firmware, sensor mode, lens filter and lens stabilization. The C80 reports no setting
for sensor mode or for the lens stabilizer switch (checked with a lens attached), and the other two
are not wanted.

The key names are under `standards.mandatory` in `cameras.json`:

    "mandatory": { "digitalIS": ["c.1.eis"], "baseIso": ["c.1.me.baseiso"], "teleConverter": ["c.1.zoom.mode"] }

The card has one **SD Card** field for both slots. A slot's letter (A or B) is green when it has a
usable card, with its minutes left. **No SD Card** is red and bold when neither slot can record, and
plain light text for the empty slot when only one is empty. The camera only says "recordable" or
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
camera sends no focus guide, no box is shown and the corner says "Focus not detected".

On the card, **Focus** is the AF / MF switch on the lens (`c.1.lens.focus`). **Continuous AF** is ON
only when the focus mode is auto and its auto mode is continuous (`c.1.focus=auto` and
`c.1.focus.auto=continuous`, which is how Canon remotes switch it on). `c.1.focus=auto` with any other
`c.1.focus.auto` is OFF. A camera that does not report `c.1.focus.auto` is judged on `c.1.focus` alone.

The checks are on the second tab, **Checks**. Each card shows how many are red or yellow, and
clicking it opens that camera's checks.

## Threads

ShotReady's own work runs on separate threads, so a slow camera or a busy switcher cannot hold up
anything else:

| Thread | What it does |
| --- | --- |
| Main thread | Reads each camera's settings and live updates, runs the checks, drives the tally lamps and the screen |
| One per camera (8 with the standard list) | That camera's pictures, its picture feed to the screen, and its waveform: frames are decoded and measured here |
| ATEM | The switcher connection. It answers the ATEM on time whatever else is busy, and passes on only changes ShotReady uses |
| Stream sending (while streaming) | The connection to YouTube, Zoom or the RTMP server, and the test server. The network never holds up the main thread |
| Stream encoding (while streaming) | In a hidden window of its own (a separate process): pictures from the video device are scaled, put through a LUT if one is chosen, and encoded on the graphics chip; sound is encoded |

With 8 cameras that is 10 threads of ShotReady's own. A camera shown through a monitoring LUT adds one
more, in the window (see below). The Log says which run when the app starts.
Electron adds its own: the main window and the bar each run in their own process, as do the graphics
and network services, and each process has helper threads of its own. Measured on a test machine with
8 cameras: 96 operating-system threads in 7 processes, 43 of them in the main process.

If the ATEM's thread cannot start, the connection runs on the main thread instead and the Log says so.
If a camera's thread cannot decode a picture, that picture is decoded on the main thread, as before.

## Monitoring LUT

The pictures arrive as Log. A 3D LUT (`.cube`) can be shown over them, on this screen only: nothing is
sent to the cameras, and the waveform still reads the Log picture.

1. **Settings > Monitoring LUTs:** load a LUT for each Log gamma you use (for example Canon's Canon Log 3 /
   Cinema Gamut to BT.709 LUT for `clog3_cgamut`). They are copied into the data folder.
2. On a camera's card, **LUT** turns it on or off for that camera. Each camera uses the LUT for the gamma
   it is set to, so mixed gammas each get the right one. The button is grey when no LUT is loaded for
   that camera's gamma. The corner of the picture says `LUT · 16 fps` while it is on.

The camera's preview picture carries video levels. Set **LUT input** and **LUT output** to what the LUT
was made for; a file name with `_FF_` (full in, full out) or `_LL_` (legal in, legal out) sets them on
loading. If blacks look grey or crushed, the input setting is the wrong one.

The LUT is applied by the graphics card: a thread in the window per camera reads that camera's frames,
decodes them, and the graphics card looks every pixel up in the LUT as it draws it. The main process is
not involved, and the CPU does no per-pixel work. Any graphics chip that runs WebGL2 is enough, built-in
Intel graphics included: 8 pictures of 1024x576 at 16 frames a second is a small load for one. On a
laptop with two graphics chips Windows picks one per app (Settings > System > Display > Graphics); the
Log names the chip in use when ShotReady starts. Without hardware graphics, the LUT cannot be shown and
the picture stays plain, with a message saying so.

## Waveform

The camera does not send waveform data: `WFM` exists only as a button for its own screen. ShotReady
reads one preview frame per second from each camera (`image.cgi`, 1024x576 JPEG), four a second while
its picture is on screen, and shows peak and average level, on a scale where video level 16 is 0% and
235 is 100%. Frames are decoded in the camera's own thread (`src/core/jpeg.mjs`), and read the same as
Electron's decoder to within 1%. Peak ignores the brightest
0.5% of the picture. Set `waveformMs` in `cameras.json` to change the rate, or 0 to turn it off.

These are measurements of a compressed preview, so compare them with the camera's WFM display
before trusting exact numbers.

## Lifetime hours

The camera does not send its hour meter over the network: it is not in `info.cgi` on a C80
(firmware 1.0.6.1) or in Canon's XC spec. Enter the reading from the camera once on the Workload
screen. ShotReady then adds on-time from the uptime the camera reports, including time before the
app was opened. A power cycle that happens entirely while ShotReady is closed is not counted.

## Video out

The **Video out** tab plays a video file full screen on another display, the computer's HDMI output,
which goes into a switcher input (through an HDMI-to-SDI converter on an SDI switcher). Every frame goes
through your inverse LUT on the graphics card, so the clip goes out as flat as the cameras.

1. **Settings > Labels > Laptop video:** the ATEM input it goes into. No camera's tally follows that input,
   and no tally is shown or sent for it. A label that already uses that input is refused.
2. **Inverse LUT:** load your `.cube` (video colour to Log). Set LUT input and output to what it was made
   for; a LUT exported from DaVinci Resolve is usually full and full. Untick **Apply LUT** to send a video
   as it is, for example to an LED wall. With Apply LUT on and no LUT loaded, the tab and the Play button
   warn that the video goes out in colour, but it still plays.
3. **Output:** pick the display (it is listed as soon as Windows sees it, and the output stops if it is
   unplugged and comes back when it returns). **Output on** opens a borderless window on it: video only,
   no cursor, black when nothing plays. Play turns it on as well.
4. **Queue:** **Add videos…** (several at once) lists them in the order they play; ↑ ↓ reorder, ✕ removes,
   **Put in the player** loads one. With **Next clip plays automatically** on, the next one starts when a
   clip ends. The queue is kept between runs.
5. **Player:** **Play**, **Pause**, **Stop (black)**, **From the start**, **Next**, **Loop**, and the position
   bar, for the clip in the player.
6. **Audio:** goes to the output picked here, not over HDMI. Automatic picks the first output that is not
   display (HDMI) audio. If Windows does not name its outputs, sound goes to the default output: make the
   audio jack the default in Windows.

The picture is scaled to the display's resolution, keeping its shape, with black around it: a 4K file is
scaled down for a 1080 output and an HD file up for a 4K one. The frame rate of the HDMI signal is set
by Windows, not by an app. When the display is not at the show's format (3840×2160 or 1920×1080 at
25 Hz) the tab says so and where to change it (Settings > System > Display > the display > Advanced
display): a switcher input that needs the show's format will not take anything else, while a mixer that
matches frame rates itself, or an LED processor, takes it as it is. Set the graphics driver's output to
full-range RGB.

Nothing on this tab holds the output back. A different format, a missing LUT, or a computer whose
graphics cannot apply a LUT (the video is then shown as it is) are all warnings only.

MP4 (H.264 or HEVC) and WebM play; ProRes, DNxHR and MXF do not, so convert those to MP4 first.

### Sending a screen through a LUT

**Send: A screen, live, through a LUT** (top of the Video out tab) sends a display instead of a clip:
whatever is on it (slides, a browser, a document you share) goes out live, every frame through a LUT
on the graphics card, cursor included.

- **Screen to send:** the main display unless you pick another.
- **LUT:** the inverse LUT used for clips (the default), any monitoring LUT loaded in Settings, a LUT of
  its own (**Load .cube…**, with its own LUT input and output), or none. The inverse and monitoring LUTs
  keep the input and output ranges set where they were loaded.
- **Output display:** as for clips, but the main display can be picked too. With none picked it is the
  first other display, or the main display when it is the only one.

With the screen sent apart from the output display, the output shows a copy of it. With the two the
same, including a computer with one display (or two displays set to Duplicate in Windows, which
Windows treats as one), ShotReady covers that display with its own picture through the LUT, so what you
see is what goes out. Clicks and typing go through to the apps under it. ShotReady's window is kept out
of the capture so it never films itself; that needs Windows 10 version 2004 or later. If the capture
comes out black in its first seconds, the screen output turns itself off and the Log says why.
**Ctrl+Shift+F12** turns the screen output off from any app. **Play** on a clip goes back to clips.

### Pre-processing

**Pre-process** on a clip in the queue makes a copy with the LUT already in every frame, kept in the data
folder (`video-out`, **Open pre-processed folder**). Tick **Pre-process the queue in the background** to
have every clip done as it is added. A pre-processed copy is played instead of the original, with nothing
left to do while it plays; it is used only when it was made with the LUT loaded now and Apply LUT is on.
Otherwise, or until it is done, the LUT is applied live, which also works.

It runs faster than real time and never slows the app or the output down:

- It runs in a hidden window of its own (a separate process), in a background thread inside it.
- The graphics chip does the work where it can: its video engine decodes and encodes (WebCodecs, hardware
  first, software where the chip cannot), and the LUT is applied on it with WebGL2. The picture never
  goes through the CPU in between. The Log says which was used.
- While a clip plays out, it works no faster than one and a half times real time, leaving the graphics
  chip to the output.
- Files are read and written a range at a time, so a long clip never sits in memory. A copy is written
  under a temporary name and only appears when it is complete.

Pre-processing takes MP4 files (H.264 or HEVC; also `.mov` with those). The copy is H.264 at the clip's
own size and frame rate (about 60 Mbit/s for 4K, 25 for HD), with the sound copied as it is.

## Live stream

The **Stream** tab sends the program live to **YouTube**, a **Zoom webinar or Zoom Events session**, or
any other **RTMP/RTMPS** server (Facebook Live, Vimeo, Twitch, a venue's own).

**Where the picture comes from.** The switcher's network connection carries no pictures, so the stream
takes a video input on this computer, and that input has to carry the program:

- an ATEM Mini's **USB-C output**, which shows up in Windows as a webcam with sound, or
- a **capture box** (HDMI or SDI to USB, such as a Blackmagic UltraStudio or Web Presenter, Magewell,
  AJA U-TAP) on a program output: an SDI program output, an aux set to program, or a multiview output set to
  program on a larger switcher.

**Setting it up.**

1. **Source:** choose the video device, and the sound: the device's own (the ATEM's USB sound is the
   program mix), another input such as an audio interface, or none. The picture is shown beside it.
   **Colour** can put a LUT loaded in Settings > Monitoring LUTs on the stream, for a program that is
   still in Log.
2. **Destination:**
   - **YouTube:** in YouTube Studio choose Create > Go live > Stream and copy the **Stream key**. The
     server address is already filled in (`rtmps://a.rtmps.youtube.com/live2`). Change it only if
     Studio shows a different Stream URL. A channel that has never streamed has to switch live
     streaming on first, which takes up to 24 hours.
   - **Zoom:** Zoom takes a stream only into a **Webinar** or a **Zoom Events session**, over
     `rtmps://`, up to 1080p 30 fps. Turn on the incoming livestream (RTMP) for the webinar and copy its
     Stream URL and Stream key. The stream appears in the webinar as a panelist. A **regular Zoom meeting**
     takes no stream: there, choose the same video device as the camera in Zoom, or use Share Screen >
     Advanced > Content from 2nd Camera. No streaming is needed.
   - **Other:** paste the server address and the stream key.
   - **Test on this computer:** runs the whole chain (device, encoder, sound, sending) into a server
     inside ShotReady and sends nothing anywhere. It says how many pictures and how much sound
     arrived, and keeps it as `stream-test.flv` in the data folder, which VLC plays. Use it before a show.
3. **Quality:** 1080p or 720p, the show's frame rate (25 or 30 for Zoom), and the bitrate (automatic:
   6 Mbps for 1080p up to 30 fps, 9 above; 4 and 6 for 720p). The upload speed should be at least twice
   the bitrate. A 4K program is scaled down.
4. **Go live**, and **Stop stream** to end it. One click each.

Stream keys are kept encrypted on this computer (Windows' own protection, as for camera passwords),
are never shown again after saving, and are sent only to the server they belong to.

**While live** the tab shows the time live, the bitrate going out, the frame rate and how many
pictures were left out; the tab's title turns red (**Stream ● LIVE**) so it can be seen from any tab.

- If the internet drops, ShotReady connects again by itself, every 1 to 10 seconds, until the stream is
  stopped. YouTube keeps the broadcast open for a while, so viewers see it carry on.
- When the upload is slower than the bitrate, pictures are left out until the next key frame (every 2
  seconds) rather than letting the stream fall further and further behind; the sound keeps going.
  The tab says when the upload is too slow; lower the bitrate.
- The video device being unplugged, or taken by another program, stops the stream and says why, in the
  tab and in red in the Log.

**How it runs.** Encoding is H.264 on the graphics chip's video encoder (NVIDIA NVENC, Intel Quick
Sync, AMD) where Windows offers one to ShotReady, and in software otherwise; the tab and the Log say
which. Sound is AAC at 160 kbps. Encoding runs in a hidden window of its own, a separate process with a
thread for the work, and the sending runs in a thread of its own, so the cameras' pictures and the rest
of the app do not wait for the stream, or the stream for them (see Threads). If Windows has no AAC
encoder, the stream goes out without sound and says so: check with the test before a show.

## Finding a setting's key

    npm run watch -- 192.168.8.10

Prints each setting the camera pushes as it changes. Change something on the camera to see its key.
From the app, **Save settings list** on the Bodies tab saves every setting a camera reports to the
reports folder.

## Data

Kept in `%APPDATA%\ShotReady` (Settings > Open data folder): `cameras.json`,
`shotready-state.json`, `events.log`, `reports\`. A state file from the v0.2 prototype can be
copied in as it is. Camera passwords are encrypted with Windows' own protection.

To change the list of bodies or labels, edit `cameras.json` with the app closed.

## Tests

    npm test           # 19 unit tests, against simulated cameras and switchers
    npm run test:e2e   # drives the real app in demo mode

`node test/packaged.mjs` checks the built app in live mode after `npm run dist:win`.

## Not built yet

These need something from outside this project, as listed in the project record:

- **Identify test:** needs Canon's XC docs (writable keys).
- **Changing resolution remotely:** the SDI output format cannot be set from here on a C80 (it is set on
  the camera). A recording resolution setting can be added once its name is known: send a Save settings
  list file.
- **System frequency check:** the key name is not in the prototype. The output format check
  covers part of it, since the camera must report 25.00p output to pass.
