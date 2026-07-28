import { create } from 'zustand';
import { clearSensitiveBrowserStorage } from '../features/conversations/privacyStorage';

clearSensitiveBrowserStorage();

export const useAppStore = create((set) => ({
  botStatus: 'disconnected',
  botActivo: false,
  qrDataUrl: null,
  qrCountdown: 0,
  showQR: false,
  contacts: {},
  chatMessages: {},
  chatModes: {},
  silenced: {},
  selectedId: null,
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
  contactTags: {},
  customNames: {},
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
    return { contacts: next };
  }),
  setChatMessages: (updater) => set((state) => {
    const next = typeof updater === 'function' ? updater(state.chatMessages) : updater;
    return { chatMessages: next };
  }),
  setChatModes: (updater) => set((state) => ({ chatModes: typeof updater === 'function' ? updater(state.chatModes) : updater })),
  setSilenced: (updater) => set((state) => ({ silenced: typeof updater === 'function' ? updater(state.silenced) : updater })),
  setSelectedId: (updater) => set((state) => {
    const newId = typeof updater === 'function' ? updater(state.selectedId) : updater;
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
    return { customNames: newNames };
  }),
  clearSensitiveState: () => {
    clearSensitiveBrowserStorage();
    set({ contacts: {}, chatMessages: {}, selectedId: null, customNames: {}, contactTags: {}, unread: {}, chatModes: {}, silenced: {} });
  },
}));
