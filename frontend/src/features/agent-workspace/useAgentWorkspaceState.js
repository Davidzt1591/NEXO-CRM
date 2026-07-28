import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { deriveVisibleContacts, deriveWorkspaceSelection } from './workspaceSelectors';

export default function useAgentWorkspaceState() {
  const store = useAppStore();
  const [principal, setPrincipal] = useState(null);
  const [currentView, setCurrentView] = useState('chats');
  const [conversationView, setConversationView] = useState(() => localStorage.getItem('nexo_conversation_view') === 'board' ? 'board' : 'list');
  const [stats, setStats] = useState(null);
  const [systemInfo, setSystemInfo] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [candidateAction, setCandidateAction] = useState({ loading: false, error: '', notice: '' });
  const [claimStates, setClaimStates] = useState({});
  const [boardError, setBoardError] = useState('');
  const [sfModal, setSfModal] = useState({ open: false, ticket: null });
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [chatSummaries, setChatSummaries] = useState({});
  const [isImprovingText, setIsImprovingText] = useState(false);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [rateLimitState, setRateLimitState] = useState(null);
  const qrTimerRef = useRef(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const selectedIdRef = useRef(store.selectedId);
  const rateLimitGenerationRef = useRef(0);

  useEffect(() => { selectedIdRef.current = store.selectedId; }, [store.selectedId]);
  const selection = useMemo(() => deriveWorkspaceSelection({ contacts: store.contacts, chatMessages: store.chatMessages, selectedId: store.selectedId, customNames: store.customNames }), [store.contacts, store.chatMessages, store.selectedId, store.customNames]);
  const visibleContacts = useMemo(() => deriveVisibleContacts({ contacts: store.contacts, filter: store.filter, search: store.search, chatModes: store.chatModes, silenced: store.silenced, principal }), [store.contacts, store.filter, store.search, store.chatModes, store.silenced, principal]);
  const counts = useMemo(() => {
    const all = Object.values(store.contacts);
    return {
      open: all.filter(contact => contact.status !== 'closed').length,
      high: all.filter(contact => contact.prioridad === 'Alta' && contact.status !== 'closed').length,
      manual: all.filter(contact => store.chatModes[contact.chatId] === 'manual' && contact.status !== 'closed').length,
    };
  }, [store.contacts, store.chatModes]);

  return {
    ...store, ...selection, visibleContacts, counts,
    principal, setPrincipal, currentView, setCurrentView, conversationView, setConversationView,
    stats, setStats, systemInfo, setSystemInfo, logs, setLogs, logsLoading, setLogsLoading,
    candidateAction, setCandidateAction, claimStates, setClaimStates, boardError, setBoardError,
    sfModal, setSfModal, isSummarizing, setIsSummarizing, chatSummaries, setChatSummaries,
    isImprovingText, setIsImprovingText, isDetailOpen, setIsDetailOpen,
    showQuickReplies, setShowQuickReplies, rateLimitState, setRateLimitState,
    qrTimerRef, messagesEndRef, inputRef, fileInputRef, selectedIdRef, rateLimitGenerationRef,
  };
}
