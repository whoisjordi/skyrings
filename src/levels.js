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
    blurb: 'Down the streets below the rooftops, under the skybridges, and home through La Grande Arche.',
    seed: 24601,
    amp: 120,
    mountain: 0.05,
    // The runway points at the city's axis, so the way home is straight
    // through the Arche and onto the threshold.
    airport: { x: 0, z: -800 },
    runwayHeading: 0,
    target: 130,
    route: { ringRadius: 32 },
    city: {
      ground: 20,                     // the airfield's level, so it all joins up
      bounds: { x0: -1150, x1: 1150, z0: 290, z1: 1760 },
      // Terrain inside this is levelled to the ground; it blends back out.
      flatten: { x0: -1260, x1: 1260, z0: -420, z1: 1880, blend: 380 },
      // [centre, facade-to-facade width, kind]. Width 120 is a boulevard you
      // can fly down; 60 is a side street you cannot.
      streetsX: [
        [-1000, 60], [-750, 120], [-525, 60], [-300, 120],
        [0, 200, 'plaza'],
        [300, 120], [525, 60], [750, 120], [1000, 60],
      ],
      streetsZ: [[540, 120], [750, 60], [960, 120], [1170, 60], [1380, 120], [1600, 120]],
      laneWide: 12,
      laneNarrow: 10.5,
      carGap: 95,
      // Glass towers round the axis, tallest nearest it.
      district: { halfWidth: 520, zMax: 1030, minH: 230, maxH: 640 },
      routeMinH: 110,
      routeMaxH: 280,
      parks: [[-1080, 700], [880, 1700], [-640, 1700]],
      arche: {
        x: 0, z: 380, width: 220, depth: 170, height: 220,
        opening: 120, base: 14, roof: 48, steps: 3, stepDepth: 14,
      },
      // The pairs of towers the skybridges hang between.
      towers: [
        { x0: -236, x1: -112, z0: 784, z1: 896, h: 400 },
        { x0: 112, x1: 236, z0: 784, z1: 896, h: 450 },
        { x0: -236, x1: -110, z0: 1204, z1: 1316, h: 260 },
        { x0: -236, x1: -110, z0: 1444, z1: 1536, h: 220 },
      ],
      bridges: [
        // Across the axis, between the twin towers.
        { x0: -112, x1: 112, z0: 788, z1: 812, y0: 104, h: 20 },
        // Across the boulevard on the long westbound run.
        { x0: -186, x1: -160, z0: 1316, z1: 1444, y0: 96, h: 18 },
      ],
      // Sculptures on the esplanade, beside the slalom gates.
      monoliths: [
        { x: -60, z: 1470, w: 24, h: 95, color: 0xd8432e },
        { x: 60, z: 1250, w: 24, h: 110, color: 0x2f6fb5 },
        { x: -60, z: 1060, w: 24, h: 85, color: 0xf0b429 },
      ],
      route: {
        departAt: 800, departHeight: 110,
        // Off the departure end, round to the right, and down the east side
        // of the field into the city. Heights are above the runway.
        loop: [[200, -1930, 160], [560, -1960, 170], [850, -1680, 170], [920, -1180, 160],
          [800, -600, 140], [750, -150, 105]],
        loopSpacing: 600,
        maxTurn: 30,
        streetHeight: 55,
        cornerRadius: 100,
        spacing: 280,
        // [x, z, options]. 'corner' gets a gate on the inside of the bend;
        // everything else is a gate where it stands. Gates are added on the
        // straights between so none is more than `spacing` from the next,
        // except where `fill: false` says not to — used to keep gates out of
        // junctions the route crosses twice.
        path: [
          [750, 150, { h: 85 }],
          [750, 960, { corner: true }],
          [300, 960, { corner: true }],
          [300, 1380, { corner: true }],
          [120, 1380, {}],
          [-170, 1380, { h: 45, fill: false }],   // under the skybridge
          [-470, 1380, { fill: false }],
          [-750, 1380, { corner: true, fill: false }],
          [-750, 960, { corner: true }],
          [-300, 960, { corner: true }],
          [-300, 1240, {}],
          [-300, 1600, { corner: true, fill: false }],
          [0, 1600, { corner: true }],
          [50, 1440, {}],                         // slalom up the esplanade
          [-50, 1250, {}],
          [50, 1060, {}],
          [0, 800, { h: 48 }],                    // under the twin towers' bridge
          [0, 380, { h: 80, face: true }],        // through La Grande Arche
        ],
      },
    },
    palette: {
      sky: 0x9fbdd6, fog: 0xb9cbd9, fogNear: 650, fogFar: 3300,
      sun: 0xfff0e0, sunIntensity: 2.1, hemi: 0xb9cede, ground: 0x556070, hemiIntensity: 1.1,
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
