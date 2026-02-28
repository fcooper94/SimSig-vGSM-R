# vGSM-R

Virtual Railway Communication for [SimSig](https://www.simsig.co.uk)

vGSM-R is a desktop application that provides a realistic GSM-R radio interface for SimSig railway simulations. It handles incoming and outgoing phone calls with train drivers, signallers, and shunters — complete with text-to-speech voice synthesis, speech recognition, background noise, and train tracking.

![vGSM-R Screenshot](images/branding.png)

---

## Installation

1. Download the latest **vGSM-R-Setup-x.x.x.exe** from [Releases](https://github.com/fcooper94/SimSig-vGSM-R/releases)
2. Run the installer — it will install to your user profile (no admin required)
3. Launch vGSM-R from the desktop shortcut or Start Menu
4. The setup wizard will guide you through initial configuration

The app will automatically check for updates on launch and install them if available.

---

## Setup Wizard

On first launch, a setup wizard walks you through configuration:

### 1. Port Forwarding
If SimSig is running on a different machine, you need to forward **TCP port 51515** through your router:
- Open your router admin page (usually `192.168.1.1` or `192.168.0.1`)
- Find the **Port Forwarding** section
- Forward **TCP 51515** to the IP of the machine running SimSig
- Save and apply

If SimSig runs on the same machine as vGSM-R, you can skip this step.

### 2. SimSig Credentials
Enter your SimSig username and password. These are required for paid panels to authenticate with SimSig's servers. Free panels don't need credentials.

### 3. Text-to-Speech Provider
Choose how driver voices are generated:

| Provider | Quality | Cost | Requires |
|----------|---------|------|----------|
| **ElevenLabs** (Recommended) | Ultra-realistic AI voices | Free tier: 10,000 chars/month | API key |
| **Edge TTS** | High quality neural voices | Free | Internet connection |
| **Windows TTS** | Basic system voices | Free | Nothing (works offline) |

**Setting up ElevenLabs:**
1. Go to [elevenlabs.io](https://elevenlabs.io) and sign up
2. Click your profile icon → **API Keys**
3. Click **Create API Key**, name it (e.g. "vGSM-R"), and copy it
4. Paste the key into vGSM-R

The free tier gives ~125–200 driver messages per month, enough for several full sessions.

### 4. Browser Access
Enable this to control vGSM-R from an iPad or other device on your network. When enabled, the desktop interface is disabled and all interaction happens through the browser instead. See [Browser Access](#browser-access) for details.

---

## Connecting to SimSig

1. Open SimSig and load a simulation
2. Make sure the SimSig gateway is enabled (SimSig → Options → Enable Remote Control)
3. In vGSM-R, click **Connect**
4. The status indicator turns green when connected

**Connection settings** (configurable in Settings):
- **Host**: IP address of the SimSig machine (default: `localhost`)
- **Port**: Gateway port (default: `51515`)

If the gateway connection drops, vGSM-R will automatically attempt to reconnect.

---

## Handling Phone Calls

### Incoming Calls
When a driver or signaller calls, you'll hear a ringing sound and see the call in the **Incoming** tab with the train headcode and signal location.

**To answer:**
- Click the **Answer** button, or
- Press **Space** (default keybind)

Once answered, the caller's message is read aloud via TTS with appropriate background noise (cab noise for drivers, office noise for signallers, yard noise for shunters).

**To reply:**
- Hold **Left Ctrl** (PTT) and speak your reply — speech recognition matches it to available options
- Or click a reply option manually

**To hang up:**
- Press **Space** again, or
- Click the hang up button

### Outgoing Calls (Phone Book)
1. Switch to the **Phone Book** tab
2. Click **Refresh** to load contacts from SimSig
3. Click a contact to dial them
4. Follow the on-screen prompts to communicate

---

## Keybinds

All keybinds work globally — even when vGSM-R is not focused.

| Action | Default Key | Behaviour |
|--------|------------|-----------|
| **Push-to-Talk (PTT)** | Left Ctrl | Hold to record voice |
| **Answer Call** | Space | Press to answer incoming call |
| **Hang Up** | Space | Press to end current call |

To rebind, open **Settings** → scroll to **Keybinds** → click the rebind button next to the action and press your desired key.

---

## Text-to-Speech

vGSM-R converts driver messages to speech. Each caller gets a consistent voice (the same driver always sounds the same).

**Switching providers:** Open Settings → change the TTS Provider dropdown.

- **ElevenLabs**: Best quality. Selects regional British accents automatically. Requires an API key with available credits.
- **Edge TTS**: Good quality with 40+ voice variants. Free, requires internet.
- **Windows TTS**: Basic offline voices. No setup needed.

If your primary provider fails (e.g. no credits, no internet), vGSM-R falls back to Windows TTS automatically.

---

## Speech Recognition

When you hold PTT and speak, vGSM-R transcribes your speech and matches it to available reply options:

- **ElevenLabs users**: Cloud transcription via ElevenLabs Scribe (uses same API key)
- **Edge/Windows TTS users**: Offline transcription via Vosk (runs locally in-browser, no internet needed)

If only one reply option is available, it's selected automatically regardless of what you say.

---

## Browser Access

Browser access lets you control vGSM-R from an iPad, tablet, or any device on your local network.

### Enabling
1. Open **Settings** → enable **Browser Access**
2. Set a port (default: `3000`)
3. On your device, open a browser and go to `http://<your-pc-ip>:<port>`

The IP address is shown in the vGSM-R overlay when the web server is active.

### How it works
- The **first device** to connect gets full control (answer calls, reply, hang up, dial)
- Additional devices connect as **read-only mirrors**
- When browser access is enabled, the desktop app's phone interface is disabled — the browser becomes the primary interface

### Notes
- vGSM-R automatically adds a Windows Firewall rule for the port
- Both devices must be on the same local network
- Audio (ring tones, TTS, background noise) plays on the host PC, not the browser

---

## Train Tracker

The **Trains** tab shows all trains currently in your simulation area with their headcode, track position, and status. Data updates in real-time via the SimSig gateway.

---

## Message Log

Click the message log button to open a separate window showing all STOMP messages from SimSig. You can filter by message type:

- **Berth Step** — Train movement between berths
- **Berth Cancel** — Train cleared from berth
- **Berth Interpose** — Train placed at berth
- **Signalling** — Signal state changes
- **Train Location** — Train position reports
- **Train Delay** — Delay information
- **Clock** — Simulation time and speed

---

## Emergency

The **Emergency** tab contains the **All Signals to Danger** button. This sends a command to SimSig to set every signal in your area to danger. A confirmation dialog prevents accidental activation.

---

## Settings Reference

Open Settings via the gear icon in the bottom toolbar.

| Setting | Description | Default |
|---------|-------------|---------|
| Gateway Host | SimSig machine IP | `localhost` |
| Gateway Port | STOMP gateway port | `51515` |
| Username | SimSig account username | — |
| Password | SimSig account password | — |
| Input Device | Microphone for PTT | System default |
| Mic Volume | Microphone sensitivity | 50% |
| Output Device | Speaker for TTS/sounds | System default |
| Output Volume | Speaker volume | 50% |
| Ring Device | Speaker for ringtone | System default |
| TTS Provider | Voice synthesis engine | ElevenLabs |
| ElevenLabs API Key | API key for premium TTS | — |
| Browser Access | Enable web server | Off |
| Web Server Port | Browser access port | 3000 |
| PTT Keybind | Push-to-talk key | Left Ctrl |
| Answer Keybind | Answer call key | Space |
| Hang Up Keybind | End call key | Space |

All settings are saved automatically and persist between sessions.

---

## Auto-Updates

vGSM-R checks for updates automatically on launch. If a new version is available, it downloads and installs the update before the app opens. You'll see a brief splash screen with a progress bar during this process.

If the update check fails (e.g. no internet), the app starts normally and tries again next launch.

---

## Development

### Prerequisites
- Node.js 20+
- npm

### Running locally
```bash
npm install
npm run dev     # Launch with DevTools
```

### Building
```bash
npm run dist    # Build NSIS installer → dist/vGSM-R-Setup-x.x.x.exe
```

### Releasing
1. Bump `version` in `package.json`
2. Commit and tag:
   ```bash
   git commit -am "Release v1.2.0"
   git tag v1.2.0
   git push origin main --tags
   ```
3. GitHub Actions builds and publishes the release automatically

---

## Requirements

- **OS**: Windows 10/11
- **SimSig**: Must have gateway remote control enabled
- **Network**: Internet required for Edge TTS and ElevenLabs; offline mode available with Windows TTS
