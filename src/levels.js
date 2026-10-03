// Mission definitions. Everything that makes one level differ from another
// lives here: terrain shape, palette, route geometry and target time.

export const LEVELS = [
  {
    id: 'alps',
    name: 'Alpine Valley',
    blurb: 'Up the river between the mountains, over the summit between the flags, and home across the lake.',
    seed: 1337,
    amp: 190,
    mountain: 0.25,
    // The airfield sits on the floor of the main valley, pointing up it.
    airport: { x: -400, z: 550 },
    airportY: 40,
    runwayHeading: 0,
    target: 125,
    segments: 176,        // mountains want a finer mesh than rolling hills
    cloudBase: 1350,      // above the peaks, not inside them
    route: { ringRadius: 44 },
    alps: {
      base: 380,          // height of the range between the peaks
      peaks: 850,         // and how far the ridges rise above it
      rimFrom: 1900, rimTo: 2500, rimLift: 450,
      snowLine: 640,
      meadowTop: 150,
      treeLine: 540,
      // Two valleys, written from the lake upwards. Tables are [fraction of
      // the length, value]; floors in units above sea level.
      valleys: [
        {
          // The main valley: wide and flat where the airfield is, then
          // climbing and narrowing to its head under the summit.
          points: [[-420, 1500], [-400, 1100], [-400, 500], [-400, -150], [-260, -650],
            [-520, -1150], [-330, -1600], [-80, -1950]],
          floor: [[0, 0], [0.08, 40], [0.45, 40], [1, 450]],
          halfWidth: [[0, 360], [0.45, 320], [0.6, 230], [1, 180]],
          // The river keeps to one side past the runway.
          riverOffset: [[0, 150], [0.4, 190], [0.5, 0], [1, 0]],
          riverWidth: 34,
          meander: 35,
        },
        {
          // The side valley: down from the other side of the summit.
          points: [[760, 1500], [820, 900], [650, 350], [850, -250], [600, -850],
            [820, -1400], [620, -1900]],
          floor: [[0, 0], [0.15, 30], [1, 470]],
          halfWidth: [[0, 260], [1, 170]],
          riverOffset: [[0, 0], [1, 0]],
          riverWidth: 26,
          meander: 30,
        },
      ],
      // The summit between the two valley heads.
      summit: {
        x: 270, z: -2000, top: 700, flat: 24, slope: 1.05,
        blendFrom: 330, blendTo: 700, poleGap: 14, poleHeight: 95,
      },
      flagColors: [[0xd62828, 0xf4f4f4], [0xd62828, 0xf4f4f4]],
      lake: { x: 150, z: 1900, rx: 1800, rz: 650, bed: -70 },
      treeAttempts: 26000,
      villages: [[-600, 650, 22, 260], [-250, 1180, 10, 200], [900, 1350, 12, 220]],
      church: [-610, 470],
      route: {
        departAt: 800, departAGL: 80,
        spacing: 380,
        // Height above the valley floor, by fraction of the valley's length.
        main: { from: 0.56, to: 0.96, agl: [[0.5, 90], [0.8, 120], [1, 190]] },
        trib: { from: 0.95, to: 0.12, agl: [[0, 85], [0.8, 110], [1, 180]] },
        summitClearance: 10,   // ring bottom above the summit top
        // Out over the lake and round onto final, heading up the valley.
        lake: [[700, 1850, 70], [350, 2130, 60], [-50, 2170, 55], [-330, 2080, 55]],
        finalAt: 1300, finalAGL: 60,
        maxTurn: 30,
      },
    },
    city: null,
    palette: {
      sky: 0x8ec5ee, fog: 0xbcd8ee, fogNear: 1300, fogFar: 5400,
      sun: 0xfff4e2, sunIntensity: 2.3, hemi: 0xa9d0ee, ground: 0x4a5a3a, hemiIntensity: 1.05,
      water: 0x2f8aa3, river: 0x63b6c8,
      sand: 0xb3aa98, grass: 0x7db357, forest: 0x3d6a33, pasture: 0x93ab62,
      rock: 0x8c8e92, snow: 0xf5f8fb,
      body: 0xe04f3d, accent: 0xf4e3c1,
      cloud: 0xffffff, cloudCount: 22,
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
    id: 'dragon',
    name: 'Dragon Night',
    blurb: 'A clear night in the mountains, and a dragon of lights coiled round the gates across the lake.',
    seed: 777001,
    amp: 120,
    mountain: 0.25,
    // Alpine Valley's layout, mirrored and cut down: the same two valleys,
    // summit and lake, about half the height.
    airport: { x: 400, z: 550 },
    airportY: 30,
    runwayHeading: 0,
    target: 130,
    segments: 160,
    cloudBase: 1400,
    route: { ringRadius: 42 },
    alps: {
      base: 170,
      peaks: 330,
      rimFrom: 1900, rimTo: 2500, rimLift: 300,
      snowLine: 400,
      meadowTop: 90,
      treeLine: 330,
      valleys: [
        {
          points: [[420, 1500], [400, 1100], [400, 500], [400, -150], [260, -650],
            [520, -1150], [330, -1600], [80, -1950]],
          floor: [[0, 0], [0.08, 30], [0.45, 30], [1, 230]],
          halfWidth: [[0, 360], [0.45, 320], [0.6, 240], [1, 190]],
          riverOffset: [[0, -150], [0.4, -190], [0.5, 0], [1, 0]],
          riverWidth: 34,
          meander: 35,
        },
        {
          points: [[-760, 1500], [-820, 900], [-650, 350], [-850, -250], [-600, -850],
            [-820, -1400], [-620, -1900]],
          floor: [[0, 0], [0.15, 20], [1, 240]],
          halfWidth: [[0, 270], [1, 180]],
          riverOffset: [[0, 0], [1, 0]],
          riverWidth: 26,
          meander: 30,
        },
      ],
      summit: {
        x: -270, z: -2000, top: 390, flat: 24, slope: 1.05,
        blendFrom: 330, blendTo: 700, poleGap: 14, poleHeight: 80,
      },
      flagColors: [[0xc8102e, 0xffd700], [0xc8102e, 0xffd700]],
      lake: { x: -150, z: 1900, rx: 1800, rz: 650, bed: -60 },
      treeAttempts: 20000,
      villages: [[600, 650, 18, 260], [250, 1180, 8, 200], [-900, 1350, 10, 220]],
      church: [610, 470],
      route: {
        departAt: 800, departAGL: 80,
        spacing: 380,
        main: { from: 0.56, to: 0.96, agl: [[0.5, 90], [0.8, 110], [1, 150]] },
        trib: { from: 0.95, to: 0.12, agl: [[0, 85], [0.8, 100], [1, 140]] },
        summitClearance: 10,
        // High over the lake, where the dragon is, then down onto final.
        lake: [[-700, 1850, 150], [-350, 2130, 165], [50, 2170, 160], [330, 2080, 130]],
        finalAt: 1300, finalAGL: 60,
        maxTurn: 30,
      },
    },
    // The drone show: ~1500 lights in the shape of a Chinese dragon, coiled
    // round the gates that cross the lake. See docs/flock.md.
    dragon: {
      minClearance: 100,   // a gate's height over the water to be coiled round
      planeRadius: 8,
      shape: {},           // createDragon options; DRAGON_DEFAULTS otherwise
      rules: {},           // createFlock rules; DEFAULT_RULES otherwise
    },
    city: null,
    palette: {
      sky: 0x050a18, fog: 0x0a1226, fogNear: 1800, fogFar: 6000,
      // Moonlight, from low over the lake.
      sun: 0xb4c6ee, sunIntensity: 1.6, sunPos: [300, 900, 2600],
      hemi: 0x3a4c78, ground: 0x0b0e18, hemiIntensity: 1.0,
      water: 0x1a3658, river: 0x2a4c72,
      sand: 0x4a4c56, grass: 0x2a4434, forest: 0x1a3024, pasture: 0x3a4e3c,
      rock: 0x4c525e, snow: 0xc4d2ea,
      body: 0x7a8fb8, accent: 0xffd166,
      cloud: 0x1a2238, cloudCount: 0,
      runwayLights: 0xfff0a8,
      stars: 1600,
      moon: { dir: [0.12, 0.3, 1], size: 120, color: 0xf4f1e4 },
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
