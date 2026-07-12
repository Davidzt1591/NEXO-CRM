import { io } from 'socket.io-client';

export const NEXO_SOCKET_RECONNECTION_ATTEMPTS = 10;
export const NEXO_SOCKET_RECONNECTION_DELAY_MS = 1500;

export function createNexoSocket() {
  return io('http://localhost:3001', {
    transports: ['websocket'],
    autoConnect: false,
    auth: (cb) => {
      cb({ token: localStorage.getItem('nexo_token') });
    },
    reconnectionAttempts: NEXO_SOCKET_RECONNECTION_ATTEMPTS,
    reconnectionDelay: NEXO_SOCKET_RECONNECTION_DELAY_MS,
  });
}

export const socket = createNexoSocket();
