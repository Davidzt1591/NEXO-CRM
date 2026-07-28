import { io } from 'socket.io-client';
import { getBackendOrigin } from './backendOrigin';

export const NEXO_SOCKET_RECONNECTION_ATTEMPTS = 10;
export const NEXO_SOCKET_RECONNECTION_DELAY_MS = 1500;

export function getNexoSocketBaseUrl() {
  return getBackendOrigin();
}

export function createNexoSocket() {
  return io(getNexoSocketBaseUrl(), {
    transports: ['websocket'],
    autoConnect: false,
    withCredentials: true,
    reconnectionAttempts: NEXO_SOCKET_RECONNECTION_ATTEMPTS,
    reconnectionDelay: NEXO_SOCKET_RECONNECTION_DELAY_MS,
  });
}

export const socket = createNexoSocket();
