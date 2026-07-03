export const PRODUCT_NAME = 'Flitdrop'
export const VERSION = '0.1.1'
export const PROTOCOL_TAG = 'wd1'
export const DEFAULT_PORT = 47777
export const CHUNK_SIZE = 8 * 1024 * 1024
// marge pour le nonce (24 o) + le tag Poly1305 (16 o)
export const MAX_CHUNK_BODY = CHUNK_SIZE + 64
export const PAYLOAD_MAX_AGE_MS = 2 * 60 * 1000
export const DEFAULT_MAX_FILE_MB = 8192
export const MAX_TEXT_BYTES = 1024 * 1024
export const OUTBOX_MAX_ITEMS = 50
export const MAX_ACTIVE_TRANSFERS_PER_DEVICE = 4
// large fenêtre : un téléphone qui se met en veille puis revient reprend son
// transfert tant qu'il ne dépasse pas ce délai d'inactivité.
export const TRANSFER_IDLE_TIMEOUT_MS = 30 * 60 * 1000
export const PENDING_PAIRING_TTL_MS = 15 * 60 * 1000
