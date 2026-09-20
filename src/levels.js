// Mission definitions. Everything that makes one level differ from another
// lives here: terrain shape, palette, route geometry and target time.

export const LEVELS = [
  {
    id: 'valley',
    name: 'Green Valley',
    blurb: 'Wide gates over rolling hills. Learn the aeroplane.',
    seed: 1337,
    amp: 190,
    mountain: 0.25,
    airport: { x: 0, z: 150 },
    runwayHeading: 0,
    target: 110,
    route: {
      count: 14, radius: 1700, altitude: 320, spread: 0.4, ringRadius: 46,
      departAt: 900, joinRadius: 750, spacing: 1100, maxTurn: 30,
      loops: 0, finalAt: 1300,
    },
    city: null,
    palette: {
      sky: 0x8fc9e8, fog: 0xa9d4ea, fogNear: 700, fogFar: 3600,
      sun: 0xfff3dd, sunIntensity: 2.2, hemi: 0x9ec9e0, ground: 0x4a5a3a, hemiIntensity: 1.0,
      water: 0x2f7fa8,
      sand: 0xd9cb92, grass: 0x6f9e52, rock: 0x7d7f83, snow: 0xeef3f6,
      body: 0xe04f3d, accent: 0xf4e3c1,
      cloud: 0xffffff, cloudCount: 26,
    },
  },
  {
    id: 'canyon',
    name: 'Canyon Run',
    blurb: 'Drop into the gorge and stay in it. Every gate but the last is below the rim.',
    seed: 90210,
    // Gentle relief sitting on a high plateau, so the canyon has something
    // deep to be cut into rather than being a ditch between hills.
    amp: 150,
    mountain: 0.35,
    baseLift: 470,
    segments: 176,        // finer mesh, or the canyon walls come out as slabs
    airport: { x: 0, z: 0 },
    airportY: 480,        // the airfield sits up on the rim
    runwayHeading: 0,
    target: 185,
    route: { ringRadius: 42 },
    canyon: {
      // A long sweeping loop around the airfield with S-bends laid over it:
      // about 5.6km of gorge, curving at two different scales.
      radius: 1150,
      wiggle: 140,
      waves: 4,
      sweep: 4.87,                 // ~279 degrees
      startAngle: -Math.PI / 2,    // entrance straight off the departure end
      halfWidth: 150,
      rim: 130,
      depth: 370,
      // Shallow at both ends, so you can descend in and climb out without
      // meeting a wall head-on.
      entryRamp: 0.1,
      exitRamp: 0.1,
      gateHeight: 80,
      spacing: 430,                // close enough that the chords stay inside
      // A gate between the runway and the mouth, so the canyon entrance is
      // something you are aimed at rather than something you go looking for.
      departGate: 620,
      departHeight: 150,
      // Curving out of the gorge and round onto final.
      maxTurn: 30,
      approachPad: 480,   // keeps the sweep inside the turn-back warning
      linkSpacing: 800,
      // The one gate out in the open. It has to sit clear of the canyon ring
      // itself (radius 1010-1290 plus rim), hence well beyond it on final.
      finalGate: 1700,
      finalHeight: 190,
    },
    // Absolute colour bands: on a plateau these cannot be derived from `amp`.
    bands: { sand: 40, low: 80, high: 300, top: 380 },
    cloudBase: 950,       // the plateau is at 480; clouds belong above it
    city: null,
    palette: {
      sky: 0xd8b98c, fog: 0xe0c49b, fogNear: 700, fogFar: 3400,
      sun: 0xffe6b8, sunIntensity: 2.4, hemi: 0xe7cfa6, ground: 0x6b4a33, hemiIntensity: 0.9,
      water: 0x2c6f8f,
      sand: 0xc2a173, grass: 0xa8804f, rock: 0x9c4a2f, snow: 0xd8be96,
      body: 0x3c6fd1, accent: 0xf0f3f6,
      cloud: 0xfaf0e2, cloudCount: 14,
    },
  },
  {
    id: 'city',
    name: 'City Towers',
    blurb: 'Thread the gates between the blocks. Watch your wingtips.',
    seed: 24601,
    amp: 120,
    mountain: 0.05,
    airport: { x: 150, z: -150 },
    runwayHeading: -Math.PI * 0.25,
    target: 210,
    route: {
      count: 18, radius: 1650, altitude: 260, spread: 0.5, ringRadius: 34,
      departAt: 900, joinRadius: 700, spacing: 850, maxTurn: 30,
      loops: 1, finalAt: 1300,
    },
    city: { x: -850, z: -850, radius: 780, count: 110, minH: 90, maxH: 300, corridor: 170 },
    palette: {
      sky: 0x9fb8cc, fog: 0xb6c8d6, fogNear: 550, fogFar: 3000,
      sun: 0xfff0e0, sunIntensity: 2.0, hemi: 0xb9cede, ground: 0x556070, hemiIntensity: 1.05,
      water: 0x36718c,
      sand: 0xc9c2a8, grass: 0x6b8a5c, rock: 0x86898e, snow: 0xeef1f4,
      body: 0xf2b134, accent: 0x33404a,
      cloud: 0xf2f6fa, cloudCount: 20,
    },
  },
  {
    id: 'night',
    name: 'Night Storm',
    blurb: 'Glowing gates, heavy weather, a runway you have to find.',
    seed: 777001,
    amp: 300,
    mountain: 0.6,
    airport: { x: -150, z: 100 },
    runwayHeading: Math.PI * 0.62,
    target: 215,
    route: {
      count: 18, radius: 1650, altitude: 380, spread: 0.6, ringRadius: 38,
      // Fog closes in at 1900 here, so gates have to be closer together.
      departAt: 900, joinRadius: 700, spacing: 880, maxTurn: 28,
      loops: 0, finalAt: 1300,
    },
    city: null,
    palette: {
      sky: 0x0d1626, fog: 0x14203a, fogNear: 320, fogFar: 1900,
      sun: 0x9db7e8, sunIntensity: 0.85, hemi: 0x2a3c5e, ground: 0x0b1018, hemiIntensity: 0.65,
      water: 0x0e2438,
      sand: 0x4a4a52, grass: 0x2e4436, rock: 0x3a3f4a, snow: 0x9fb0c4,
      body: 0x7a8fb8, accent: 0xffd166,
      cloud: 0x2a3550, cloudCount: 34,
      runwayLights: 0xfff0a8,
    },
  },
];

export const levelByIndex = (i) => LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i))];

export function formatTime(seconds) {
  if (seconds == null || !isFinite(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds * 100) % 100);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
