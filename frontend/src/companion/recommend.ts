/**
 * The "réglages recommandés" script for one repeater or room server: CLI
 * commands, each with why, shown for review (and editing) before they run.
 * Values live here, in one place, so they can be tuned without touching the UI.
 */

export interface Step {
  command: string
  why: string
}

/** Where a node is in France, from its position (geo.api.gouv.fr). */
export interface FrenchArea {
  /** Department code: "29", "2A". */
  dept: string
  /** INSEE region code: "53" for Bretagne. */
  region: string
  /** The commune, to show where the lookup landed. */
  commune: string
}

/** INSEE region codes to the ISO 3166-2:FR letters the mesh's names use (fr-bre). */
const REGION_ISO: Record<string, string> = {
  '84': 'ara',
  '27': 'bfc',
  '53': 'bre',
  '24': 'cvl',
  '94': 'cor',
  '44': 'ges',
  '32': 'hdf',
  '11': 'idf',
  '28': 'nor',
  '75': 'naq',
  '76': 'occ',
  '52': 'pdl',
  '93': 'pac',
}

const REGION_NAME: Record<string, string> = {
  ara: 'Auvergne-Rhône-Alpes',
  bfc: 'Bourgogne-Franche-Comté',
  bre: 'Bretagne',
  cvl: 'Centre-Val de Loire',
  cor: 'Corse',
  ges: 'Grand Est',
  hdf: 'Hauts-de-France',
  idf: 'Île-de-France',
  nor: 'Normandie',
  naq: 'Nouvelle-Aquitaine',
  occ: 'Occitanie',
  pdl: 'Pays de la Loire',
  pac: "Provence-Alpes-Côte d'Azur",
}

/** Other names a region goes by on the mesh, put under fr next to it. */
const REGION_ALIASES: Record<string, string[]> = { bre: ['bzh'] }

/** The node's department and region, or null outside France or when the lookup fails. */
export async function frenchArea(lat: number, lon: number, signal?: AbortSignal): Promise<FrenchArea | null> {
  try {
    const res = await fetch(
      `https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&fields=nom,codeDepartement,codeRegion`,
      { signal },
    )
    if (!res.ok) return null
    const [c] = (await res.json()) as { nom: string; codeDepartement: string; codeRegion: string }[]
    return c ? { dept: c.codeDepartement, region: c.codeRegion, commune: c.nom } : null
  } catch {
    return null
  }
}

export function describeArea(a: FrenchArea): string {
  const iso = REGION_ISO[a.region]
  return `${a.commune} : département ${a.dept}${iso ? `, ${REGION_NAME[iso]}` : ''}`
}

/**
 * The whole region tree in one `region def` line. Each name goes under the
 * previous one; "|name" then moves back to an existing region, "|*" to the
 * root. For Finistère: eu > fr > fr-bre > fr-29, bzh under fr, europe at the
 * root.
 */
export function regionDefLine(a: FrenchArea): string {
  const iso = REGION_ISO[a.region]
  const dept = `fr-${a.dept.toLowerCase()}`
  const chain = iso ? `eu fr fr-${iso} ${dept}` : `eu fr ${dept}`
  const aliases = (iso && REGION_ALIASES[iso]) || []
  const parts = [chain, ...aliases]
  // Each part but the last returns to fr; the last returns to the root.
  const joined = parts.map((p, i) => (i < parts.length - 1 ? `${p}|fr` : `${p}|*`)).join(' ')
  return `region def ${joined} europe`
}

/** The commands, in the order they run. */
export function recommendedSteps(area: FrenchArea | null): Step[] {
  const steps: Step[] = [
    { command: 'set advert.interval 240', why: 'annonce locale (sans relais) toutes les 4 h, le maximum' },
    { command: 'set flood.advert.interval 24', why: 'annonce flood une fois par jour' },
    { command: 'set agc.reset.interval 4', why: 'réinitialise le gain du récepteur toutes les 4 s' },
    { command: 'set loop.detect minimal', why: 'écarte les paquets flood qui tournent en boucle' },
    { command: 'set path.hash.mode 1', why: 'hashes de chemin sur 2 octets : les sauts restent attribuables' },
    { command: 'set multi.acks 1', why: 'accusé de réception doublé : moins de messages crus perdus' },
    { command: 'set flood.max.unscoped 5', why: 'limite à 5 sauts le trafic sans région' },
    { command: 'set flood.max.advert 12', why: 'limite à 12 sauts la propagation des annonces' },
    { command: 'set dutycycle 10', why: "temps d'émission plafonné à 10 % (869,4–869,65 MHz)" },
    { command: 'powersaving on', why: "économie d'énergie (nRF52 : immédiat, ESP32 : après 2 min ; refusé sur firmware bridge)" },
  ]
  if (area) {
    steps.push(
      { command: regionDefLine(area), why: `arbre des régions pour ${describeArea(area)}` },
      { command: 'region default fr', why: 'ses propres annonces et réponses partent dans la région fr' },
      { command: 'region home fr', why: 'région de rattachement' },
      { command: 'region save', why: 'enregistre les régions' },
    )
  }
  return steps
}
