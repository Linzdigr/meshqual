/**
 * MeshCore payload types, grouped into four families for the frame table.
 * Thirteen distinct hues would be unreadable; the type name stays on the badge
 * and the family colour only says what kind of traffic it is.
 */
export type PayloadFamily = 'message' | 'request' | 'routing' | 'data'

const FAMILY: Record<string, PayloadFamily> = {
  TXT_MSG: 'message',
  GRP_TXT: 'message',
  REQ: 'request',
  RESPONSE: 'request',
  ANON_REQ: 'request',
  ACK: 'request',
  ADVERT: 'routing',
  PATH: 'routing',
  TRACE: 'routing',
  CONTROL: 'routing',
  GRP_DATA: 'data',
  MULTIPART: 'data',
  RAW_CUSTOM: 'data',
}

export const FAMILY_LABEL: Record<PayloadFamily, string> = {
  message: 'Message',
  request: 'Requête',
  routing: 'Routage',
  data: 'Données',
}

const DESCRIPTION: Record<string, string> = {
  REQ: 'Requête adressée à un nœud',
  RESPONSE: 'Réponse à une requête',
  TXT_MSG: 'Message direct',
  ACK: 'Accusé de réception',
  ADVERT: 'Annonce de nœud : identité et position',
  GRP_TXT: 'Message de canal',
  GRP_DATA: 'Données de canal',
  ANON_REQ: 'Requête anonyme (connexion)',
  PATH: 'Retour de chemin',
  TRACE: 'Trace : SNR relevé à chaque saut',
  MULTIPART: 'Paquet en plusieurs parties',
  CONTROL: 'Paquet de contrôle',
  RAW_CUSTOM: 'Données brutes applicatives',
}

/** Unknown types fall into 'data' rather than borrowing another family's colour. */
export function payloadFamily(type: string): PayloadFamily {
  return FAMILY[type] ?? 'data'
}

export function payloadTitle(type: string): string {
  const family = FAMILY_LABEL[payloadFamily(type)]
  const desc = DESCRIPTION[type]
  return desc ? `${family} — ${desc}` : family
}
