export const LEGACY_SENSITIVE_STORAGE_KEYS = Object.freeze([
  'nexo_contacts', 'nexo_chatMessages', 'nexo_custom_names', 'nexo_contact_tags', 'nexo_selected_id',
]);

export function clearSensitiveBrowserStorage(storage = globalThis.localStorage, session = globalThis.sessionStorage) {
  for (const key of LEGACY_SENSITIVE_STORAGE_KEYS) {
    storage?.removeItem?.(key);
    session?.removeItem?.(key);
  }
}
