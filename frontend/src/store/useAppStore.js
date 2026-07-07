import { create } from 'zustand';

// ── Helpers para persistir conversaciones en sesión ────────────────────────
function loadSession(key, fallback) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function saveSession(key, data) {
  try { sessionStorage.setItem(key, JSON.stringify(data)); } catch {}
}

export const useAppStore = create((set, get) => ({
  botStatus: 'disconnected',
  botActivo: false,
  qrDataUrl: null,
  qrCountdown: 0,
  showQR: false,
  contacts: loadSession('nexo_contacts', {}),
  chatMessages: loadSession('nexo_chatMessages', {}),
  chatModes: {},
  silenced: {},
  selectedId: localStorage.getItem('nexo_selected_id') || null,
  newMessage: '',
  filter: 'all',
  search: '',
  unread: {},
  showEmojiPicker: false,
  pendingMedia: null,
  authMode: 'qr',
  pairingPhone: '',
  pairingCode: null,
  pairingError: null,
  pairingLoading: false,
  contactTags: JSON.parse(localStorage.getItem('nexo_contact_tags') || '{}'),
  customNames: JSON.parse(localStorage.getItem('nexo_custom_names') || '{}'),
  quickReplies: JSON.parse(localStorage.getItem('nexo_quick_replies') || JSON.stringify([
    { id: '1', title: 'Saludo Inicial', text: 'Hola, espero te encuentres muy bien. Mi nombre es un asesor de integraciones de Magneto y estaré atendiendo tu requerimiento.' },
    { id: '2', title: 'Aviso Inactividad', text: 'Hola, continuamos a la espera de tu respuesta para brindarte una solución. Si en 20 minutos no recibimos información, daremos por cerrado el chat.' }
  ])),

  setBotStatus: (val) => set({ botStatus: val }),
  setBotActivo: (val) => set({ botActivo: val }),
  setQrDataUrl: (val) => set({ qrDataUrl: val }),
  setQrCountdown: (updater) => set((state) => ({ qrCountdown: typeof updater === 'function' ? updater(state.qrCountdown) : updater })),
  setShowQR: (val) => set({ showQR: val }),
  setContacts: (updater) => set((state) => {
    const next = typeof updater === 'function' ? updater(state.contacts) : updater;
    saveSession('nexo_contacts', next);
    return { contacts: next };
  }),
  setChatMessages: (updater) => set((state) => {
    const next = typeof updater === 'function' ? updater(state.chatMessages) : updater;
    saveSession('nexo_chatMessages', next);
    return { chatMessages: next };
  }),
  setChatModes: (updater) => set((state) => ({ chatModes: typeof updater === 'function' ? updater(state.chatModes) : updater })),
  setSilenced: (updater) => set((state) => ({ silenced: typeof updater === 'function' ? updater(state.silenced) : updater })),
  setSelectedId: (updater) => set((state) => {
    const newId = typeof updater === 'function' ? updater(state.selectedId) : updater;
    if (newId) localStorage.setItem('nexo_selected_id', newId);
    else localStorage.removeItem('nexo_selected_id');
    return { selectedId: newId };
  }),
  setNewMessage: (updater) => set((state) => ({ newMessage: typeof updater === 'function' ? updater(state.newMessage) : updater })),
  setFilter: (val) => set({ filter: val }),
  setSearch: (val) => set({ search: val }),
  setUnread: (updater) => set((state) => ({ unread: typeof updater === 'function' ? updater(state.unread) : updater })),
  setShowEmojiPicker: (updater) => set((state) => ({ showEmojiPicker: typeof updater === 'function' ? updater(state.showEmojiPicker) : updater })),
  setPendingMedia: (val) => set({ pendingMedia: val }),
  setAuthMode: (val) => set({ authMode: val }),
  setPairingPhone: (val) => set({ pairingPhone: val }),
  setPairingCode: (val) => set({ pairingCode: val }),
  setPairingError: (val) => set({ pairingError: val }),
  setPairingLoading: (val) => set({ pairingLoading: val }),
  setContactTag: (chatId, tag) => set(state => {
    if (!chatId) return state;
    const newTags = { ...state.contactTags };
    if (!tag) delete newTags[chatId];
    else newTags[chatId] = tag;
    localStorage.setItem('nexo_contact_tags', JSON.stringify(newTags));
    return { contactTags: newTags };
  }),
  setQuickReplies: (replies) => set(() => {
    localStorage.setItem('nexo_quick_replies', JSON.stringify(replies));
    return { quickReplies: replies };
  }),
  setCustomName: (chatId, name) => set(state => {
    if (!chatId) return state;
    const newNames = { ...state.customNames };
    if (!name) delete newNames[chatId];
    else newNames[chatId] = name;
    localStorage.setItem('nexo_custom_names', JSON.stringify(newNames));
    return { customNames: newNames };
  }),
}));
