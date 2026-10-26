# Pitchline

> Modular 3D Tactical Football Web Engine & Match Simulation

Pitchline is a browser-based 3D football game and tactical simulation powered by Three.js and Vite. It features procedural and mocap-driven animations, an IFAB-compliant rules engine, physical ball simulation with spin dynamics, tactical AI with real-time formations, and automated physics & match playability tests.

---

## 🚀 Features

- **3D Match Rendering**: Built on Three.js with realistic lighting, shadows, grass turf, stadium bounds, and camera presets (TV broadcast, sideline, tactical, follow-cam).
- **Animation System**: Quaternius character rigs with retargeted mocap locomotion (idle, walk, jog, sprint, tackles, headers, goalkeeper saves, and celebrations).
- **Physical Ball Dynamics**: Realistic flight arcs, topspin/backspin aerodynamic drag, turf roll, bounce damping, and goal woodwork collisions.
- **Match Engine & AI**: Full 11v11 IFAB rules, set-pieces (corners, throw-ins, goal kicks, penalties), tactical formations (in-possession & out-of-possession shapes), marking, and xG (Expected Goals) calculation.
- **Controls & Playability**: Responsive keyboard and gamepad controls, dual-team support, passing, shooting, through-balls, crossing, and sprint mechanics.
- **Test Suite**: Over 280 automated unit, physics, and gameplay simulation tests.

---

## 🛠️ Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- `npm`

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/Mubashar986/crispy-octo-rotary-phone.git
cd crispy-octo-rotary-phone
npm install
```

### Development

Start the local Vite development server:

```bash
npm run dev
```

Open your browser at the URL shown in your terminal (typically `http://localhost:5173`).

### Production Build

Build minified production assets into the `dist/` directory:

```bash
npm run build
```

To preview the production build locally:

```bash
npm run preview
```

### Running Tests

Run the full automated test suite:

```bash
npm test
```

---

## 📂 Project Structure

```
pitchline/
├── assets/             # 3D models (GLTF/GLB), textures, audio, and animations
│   ├── athletes/       # Character models and animations
│   ├── football/       # Processed mocap clips and manifest
│   ├── meshes/         # Stadium, ball, and goal meshes
│   ├── textures/       # Turf, pitch markings, and skyboxes
│   └── audio/          # Sound effects (whistles, kicks, crowds)
├── src/                # Core client-side game engine
│   ├── audio/          # WebAudio manager and SFX triggers
│   ├── config/         # Game settings, IFAB dimensions, camera configs
│   ├── core/           # Math utilities, vectors, and state representations
│   ├── data/           # Rosters, formations, and player attributes
│   ├── engine/         # Main loop, match clock, and state coordinator
│   ├── input/          # Keyboard and gamepad input listeners
│   ├── net/            # Networking / loopback interface
│   ├── render/         # Three.js renderer, stadium scene, animations
│   ├── sim/            # Physics, ball flight, collisions, and referee rules
│   ├── state/          # Match state machine and transitions
│   ├── ui/             # HUD overlays, radar minimap, scoreboards
│   └── main.js         # Application bootstrap entry point
├── tests/              # Automated unit and simulation test suite (280+ tests)
├── tools/              # Build scripts and data extraction utilities
├── index.html          # HTML entry point with HUD canvas
├── package.json        # Dependencies and NPM scripts
└── vite.config.js      # Vite build configuration
```

---

## 👥 Contributing

1. Create a feature branch (`git checkout -b feature/awesome-feature`)
2. Commit your changes (`git commit -m 'Add awesome feature'`)
3. Ensure all tests pass (`npm test`)
4. Push to the branch (`git push origin feature/awesome-feature`)
5. Open a Pull Request
