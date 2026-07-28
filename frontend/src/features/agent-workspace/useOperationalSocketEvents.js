import { useEffect, useMemo } from 'react';
import { RATE_LIMITED_EVENT, RATE_LIMIT_RECOVERED_EVENT } from '../../lib/apiClient';
import { applyClaimFailure } from '../../lib/claimState';
import { useNexoSocket } from '../../hooks/useNexoSocket';

export default function useOperationalSocketEvents({ authenticated, socket, workspace, setAuthError, setAuthenticated }) {
  const {
    qrTimerRef, selectedIdRef, setAuthMode, setBotActivo, setBotStatus, setChatMessages,
    setChatModes, setChatSummaries, setContacts, setIsImprovingText, setIsSummarizing,
    setNewMessage, setPairingCode, setPairingError, setPairingLoading, setPrincipal,
    setQrCountdown, setQrDataUrl, setSelectedId, setSilenced, setStats, setSystemInfo,
    setUnread, setClaimStates, rateLimitGenerationRef, setRateLimitState,
  } = workspace;
  const options = useMemo(() => ({
    qrTimerRef,
    selectedIdRef,
    setAuthError,
    setAuthMode, setBotActivo, setBotStatus, setChatMessages, setChatModes, setChatSummaries, setContacts,
    setIsAuthenticated: setAuthenticated,
    setIsImprovingText, setIsSummarizing, setNewMessage, setPairingCode, setPairingError,
    setPairingLoading, setPrincipal, setQrCountdown, setQrDataUrl, setSelectedId,
    setSilenced, setStats, setSystemInfo, setUnread,
  }), [qrTimerRef, selectedIdRef, setAuthError, setAuthMode, setAuthenticated, setBotActivo, setBotStatus, setChatMessages, setChatModes, setChatSummaries, setContacts, setIsImprovingText, setIsSummarizing, setNewMessage, setPairingCode, setPairingError, setPairingLoading, setPrincipal, setQrCountdown, setQrDataUrl, setSelectedId, setSilenced, setStats, setSystemInfo, setUnread]);
  useNexoSocket({ isAuthenticated: authenticated, socket, options });

  useEffect(() => {
    const success = ({ ticketId }) => {
      const key = String(ticketId);
      setClaimStates(previous => ({ ...previous, [key]: 'success' }));
      setSelectedId(key);
      socket.emit('get-messages', ticketId);
    };
    const failure = payload => setClaimStates(previous => applyClaimFailure(previous, payload));
    socket.on('assignment-success', success);
    socket.on('assignment-error', failure);
    socket.on('auth-error', failure);
    return () => {
      socket.off('assignment-success', success);
      socket.off('assignment-error', failure);
      socket.off('auth-error', failure);
    };
  }, [socket, setClaimStates, setSelectedId]);

  useEffect(() => {
    const limited = event => {
      const generation = ++rateLimitGenerationRef.current;
      setRateLimitState({ generation, signature: event.detail?.signature, retryAt: Date.now() + (event.detail?.retryAfterSeconds || 1) * 1000 });
    };
    const recovered = event => setRateLimitState(current => current?.signature && current.signature === event.detail?.signature ? null : current);
    window.addEventListener(RATE_LIMITED_EVENT, limited);
    window.addEventListener(RATE_LIMIT_RECOVERED_EVENT, recovered);
    return () => {
      window.removeEventListener(RATE_LIMITED_EVENT, limited);
      window.removeEventListener(RATE_LIMIT_RECOVERED_EVENT, recovered);
    };
  }, [rateLimitGenerationRef, setRateLimitState]);
}
