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
    airport: { x: -400, z: 900 },
    runwayHeading: 0,
    target: 110,
    route: { count: 8, radius: 1250, altitude: 320, spread: 0.5, ringRadius: 46 },
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
    blurb: 'Tight gates between the ridges. Commit to your turns.',
    seed: 90210,
    amp: 430,
    mountain: 0.95,
    airport: { x: 700, z: -650 },
    runwayHeading: Math.PI * 0.35,
    target: 145,
    route: { count: 11, radius: 1450, altitude: 430, spread: 0.75, ringRadius: 36 },
    city: null,
    palette: {
      sky: 0xd8b98c, fog: 0xe0c49b, fogNear: 600, fogFar: 3200,
      sun: 0xffe6b8, sunIntensity: 2.4, hemi: 0xe7cfa6, ground: 0x6b4a33, hemiIntensity: 0.9,
      water: 0x2c6f8f,
      sand: 0xcaa878, grass: 0x8a7a4e, rock: 0x8c6b52, snow: 0xf2ece1,
      body: 0x3c6fd1, accent: 0xf0f3f6,
      cloud: 0xfaf0e2, cloudCount: 16,
    },
  },
  {
    id: 'city',
    name: 'City Towers',
    blurb: 'Thread the gates between the blocks. Watch your wingtips.',
    seed: 24601,
    amp: 120,
    mountain: 0.05,
    airport: { x: 1100, z: 1100 },
    runwayHeading: -Math.PI * 0.25,
    target: 165,
    route: { count: 12, radius: 1000, altitude: 260, spread: 0.55, ringRadius: 34 },
    city: { x: -200, z: -200, radius: 850, count: 110, minH: 90, maxH: 300, corridor: 170 },
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
    airport: { x: -900, z: -1000 },
    runwayHeading: Math.PI * 0.62,
    target: 190,
    route: { count: 13, radius: 1500, altitude: 380, spread: 0.8, ringRadius: 38 },
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
