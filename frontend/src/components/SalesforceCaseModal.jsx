import React, { useState, useEffect, useRef } from 'react';

const API = 'http://localhost:3001/api/sf';

// ── Campo Map completo — Modal → Nombre_API__c ────────────────────────────
const FIELD_MAP = [
  { label: 'Origen',                       api: 'Origin',                        type: 'picklist', col: 'half' },
  { label: 'Categoría',                    api: 'Categoria__c',                  type: 'picklist', col: 'half' },
  { label: 'Tipificación',                 api: 'Tipificacion__c',               type: 'picklist', col: 'half' },
  { label: 'Atribuible',                   api: 'Atribuible__c',                 type: 'picklist', col: 'half' },
  { label: 'Plataforma',                   api: 'Plataforma__c',                 type: 'picklist', col: 'half' },
  { label: 'Nivel de Atención',            api: 'Nivel_de_atenci_n__c',          type: 'picklist', col: 'half' },
  { label: 'Prioridad',                    api: 'Priority',                      type: 'picklist', col: 'half' },
  { label: 'País',                         api: 'Pais__c',                       type: 'picklist', col: 'half' },
  { label: 'Tipo de Cliente',              api: 'Tipo_de_cliente__c',            type: 'picklist', col: 'half' },
  { label: 'Solución en primer contacto',  api: 'Soluci_n_primer_contacto__c',   type: 'picklist', col: 'half' },
  { label: 'Marca',                        api: 'Marca__c',                      type: 'picklist', col: 'half' },
  { label: 'Subetapa Asignado',            api: 'Subetapa_asignado__c',          type: 'picklist', col: 'half' },
  { label: 'Escalado a nivel técnico',     api: 'Escalado_a_nivel_t_cnico__c',   type: 'picklist', col: 'half' },
  { label: 'Gestionado por integraciones', api: 'Gestionado_por_integraciones__c',type: 'picklist', col: 'half' },
  { label: 'Agente dueño del ticket',      api: 'Agente_due_o_del_ticket__c',    type: 'picklist', col: 'half' },
];

// ── Debounce Hook ─────────────────────────────────────────────────────────────
function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

// ── Account Lookup Component (Typeahead) ──────────────────────────────────────
function AccountLookup({ initialAccount, ticketId, onSelect }) {
  const [query, setQuery]             = useState(initialAccount?.name || '');
  const [results, setResults]         = useState([]);
  const [searching, setSearching]     = useState(false);
  const [selected, setSelected]       = useState(initialAccount || null);
  const [showDropdown, setShowDropdown] = useState(false);
  const containerRef                  = useRef(null);
  const debouncedQuery                = useDebounce(query, 300);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Fetch suggestions
  useEffect(() => {
    if (!ticketId || selected || debouncedQuery.length < 3) {
      setResults([]);
      setShowDropdown(false);
      return;
    }
    setSearching(true);
    const params = new URLSearchParams({ q: debouncedQuery, ticket_id: ticketId });
    fetch(`${API}/accounts?${params.toString()}`)
      .then(r => r.json())
      .then(data => { setResults(data); setShowDropdown(true); })
      .catch(() => setResults([]))
      .finally(() => setSearching(false));
  }, [debouncedQuery, selected, ticketId]);

  const handleSelect = (acc) => {
    setSelected(acc);
    setQuery(acc.name);
    setResults([]);
    setShowDropdown(false);
    onSelect(acc);
  };

  const handleClear = () => {
    setSelected(null);
    setQuery('');
    onSelect(null);
  };

  return (
    <div className="sf-account-lookup" ref={containerRef}>
      {selected ? (
        <div className="sf-account-chip">
          <span className="sf-account-chip__icon">✅</span>
          <span className="sf-account-chip__name">{selected.name}</span>
          <button className="sf-account-chip__clear" onClick={handleClear} title="Cambiar cuenta">✕</button>
        </div>
      ) : (
        <div className="sf-input-wrapper">
          <input
            type="text"
            className="sf-input"
            placeholder="Escribe el nombre de la empresa (mín. 3 caracteres)..."
            value={query}
            onChange={e => { setQuery(e.target.value); setSelected(null); }}
            onFocus={() => results.length > 0 && setShowDropdown(true)}
          />
          {searching && <span className="sf-input-icon">🔍</span>}

          {showDropdown && (
            <div className="sf-account-dropdown">
              {results.length > 0
                ? results.map(r => (
                    <button key={r.id} className="sf-account-option" onClick={() => handleSelect(r)}>
                      <span className="sf-account-option__name">{r.name}</span>
                      <span className="sf-account-option__id">···{r.id.slice(-6)}</span>
                    </button>
                  ))
                : !searching && (
                    <p className="sf-no-results">Sin coincidencias para "{query}"</p>
                  )
              }
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Modal ────────────────────────────────────────────────────────────────
export default function SalesforceCaseModal({ ticket, onClose, onCaseCreated }) {
  const sfCaseIdRef       = useRef(ticket?.sf_case_id || null);
  const [caseId, setCaseId]               = useState(ticket?.sf_case_id || null);
  const [caseNumber, setCaseNumber]       = useState(ticket?.sf_case_number || null);

  const [picklists, setPicklists]         = useState({});
  const [dependencies, setDependencies]   = useState({});
  const [ownerInfo, setOwnerInfo]         = useState(null);
  const [loadingMeta, setLoadingMeta]     = useState(true);

  const [formData, setFormData]           = useState({});
  const [accountSelected, setAccountSelected] = useState(null);

  const [resolucion, setResolucion]       = useState('');
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [closeSubetapa, setCloseSubetapa] = useState('');
  const [showStatusDialog, setShowStatusDialog] = useState(false);
  const [newStatus, setNewStatus] = useState('');
  const [waitSubetapa, setWaitSubetapa] = useState('');
  const [currentStatus, setCurrentStatus] = useState('');
  const [isSaving, setIsSaving]           = useState(false);
  const [isClosing, setIsClosing]         = useState(false);
  const [isAssigning, setIsAssigning]     = useState(false);
  const [assignedToMe, setAssignedToMe]   = useState(false);

  const [error, setError]                 = useState(null);
  const [successMsg, setSuccessMsg]       = useState(null);

  const isEditMode = !!caseId;
  const ticketId = ticket?.id || ticket?.ticket_id || null;

  // ── Load picklists + owner identity + existing case data ─────────────────
  useEffect(() => {
    setLoadingMeta(true);
    const promises = [
      fetch(`${API}/describe`).then(r => r.json()),
      fetch(`${API}/me`).then(r => r.json()),
    ];

    // Si hay caseId, obtener datos existentes del Case
    if (caseId) {
      const params = new URLSearchParams({ ticket_id: ticketId });
      promises.push(fetch(`${API}/cases/${caseId}?${params.toString()}`).then(r => r.json()));
    }

    Promise.all(promises)
      .then(([describeResult, owner, caseData]) => {
        // describeResult is now { picklists: {}, dependencies: {} }
        const picks = describeResult?.picklists || describeResult || {};
        const deps  = describeResult?.dependencies || {};
        setPicklists(picks);
        setDependencies(deps);
        setOwnerInfo(owner?.userId ? owner : null);

        // Cargar datos existentes del caso en el formulario
        if (caseData && caseData.Id) {
          const fields = {};
          FIELD_MAP.forEach(f => {
            if (caseData[f.api]) fields[f.api] = caseData[f.api];
          });
          setFormData(fields);
          setCurrentStatus(caseData.Status || '');

          // Cargar cuenta si existe
          if (caseData.AccountId) {
            setAccountSelected({
              id: caseData.AccountId,
              name: caseData.Account?.Name || caseData.AccountId,
            });
          }
        }
      })
      .catch(e => setError('Error al conectar con Salesforce: ' + e.message))
      .finally(() => setLoadingMeta(false));
  }, [caseId, ticketId]);

  // ── Helper: get filtered options for a field (respects dependencies) ────
  const getFilteredOptions = (fieldApi) => {
    const allOptions = picklists[fieldApi] || [];
    const depInfo = dependencies[fieldApi];
    if (!depInfo || !depInfo.controllerField || !depInfo.controllerValues) {
      // No dependency → return all options (strip validFor for cleanliness)
      return allOptions;
    }

    const controllerValue = formData[depInfo.controllerField] || '';
    if (!controllerValue) {
      // Controller not selected → show nothing for a dependent field
      return [];
    }

    // Look up the index of the controller value
    const controllerIndex = depInfo.controllerValues[controllerValue];
    if (controllerIndex === undefined) return allOptions; // Safety fallback

    // Filter to only values whose validFor array includes this controller index
    return allOptions.filter(opt =>
      opt.validFor && Array.isArray(opt.validFor) && opt.validFor.includes(controllerIndex)
    );
  };

  const setField = (api, value) => {
    setFormData(prev => {
      const next = { ...prev, [api]: value };

      // If this field is the controller for other fields, clear dependent fields
      // whose current value is no longer valid
      for (const [depField, depInfo] of Object.entries(dependencies)) {
        if (depInfo.controllerField === api && next[depField]) {
          const controllerIndex = depInfo.controllerValues?.[value];
          const depOptions = picklists[depField] || [];
          const currentDepValue = next[depField];
          const stillValid = depOptions.some(opt =>
            opt.value === currentDepValue &&
            opt.validFor && Array.isArray(opt.validFor) &&
            opt.validFor.includes(controllerIndex)
          );
          if (!stillValid) {
            next[depField] = ''; // Clear invalid dependent value
          }
        }
      }

      return next;
    });
    setSuccessMsg(null);
    setError(null);
  };

  // ── Build payload from ticket context + form ──────────────────────────────
  const buildPayload = () => {
    const base = {
      Subject        : ticket?.situacion
                        ? ticket.situacion.slice(0, 255)
                        : `Caso NEXO — ${ticket?.nombre_analista || ticket?.chatId || 'Sin nombre'}`,
      Description    : ticket?.situacion || '',
      SuppliedName   : ticket?.nombre_analista || '',
      SuppliedEmail  : ticket?.correo || '',
      SuppliedPhone  : ticket?.telefono || ticket?.chatId?.replace(/@c\.us|@lid/g, '') || '',
    };

    if (accountSelected?.id) base.AccountId = accountSelected.id;

    const fields = { ...formData };
    // Clean empty strings
    Object.keys(fields).forEach(k => { if (!fields[k]) delete fields[k]; });

    return { ...base, ...fields, ticket_id: ticketId };
  };

  // ── Save (Create or Update) ───────────────────────────────────────────────
  const handleSave = async () => {
    setError(null);
    setSuccessMsg(null);
    setIsSaving(true);
    try {
      const payload = buildPayload();

      if (isEditMode) {
        await fetch(`${API}/cases/${caseId}`, {
          method  : 'PATCH',
          headers : { 'Content-Type': 'application/json' },
          body    : JSON.stringify(payload),
        }).then(async r => {
          if (!r.ok) { const j = await r.json(); throw new Error(j.error || r.statusText); }
        });
        setSuccessMsg('✅ Caso actualizado correctamente en Salesforce.');
      } else {
        const result = await fetch(`${API}/cases`, {
          method  : 'POST',
          headers : { 'Content-Type': 'application/json' },
          body    : JSON.stringify(payload),
        }).then(async r => {
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || r.statusText);
          return j;
        });
        sfCaseIdRef.current = result.id;
        setCaseId(result.id);
        setCaseNumber(result.CaseNumber);
        setSuccessMsg(`✅ Caso creado: #${result.CaseNumber}`);
        if (onCaseCreated) onCaseCreated({ sf_case_id: result.id, sf_case_number: result.CaseNumber });
      }
    } catch (e) {
      setError('Error al guardar: ' + e.message);
    } finally {
      setIsSaving(false);
    }
  };

  // ── Close Case ────────────────────────────────────────────────────────────
  const REQUIRED_FOR_CLOSE = [
    'Origin',
    'Priority',
    'Tipificacion__c',
    'Categoria__c',
    'Tipo_de_cliente__c',
    'AccountId',
    'Plataforma__c',
    'Soluci_n_primer_contacto__c',
    'Nivel_de_atenci_n__c',
    'Atribuible__c',
    'Pais__c',
    'Agente_due_o_del_ticket__c',
    'Escalado_a_nivel_t_cnico__c',
  ];

  const handleOpenCloseDialog = () => {
    if (!caseId) { setError('Debes crear el caso en Salesforce primero.'); return; }

    const missing = REQUIRED_FOR_CLOSE.filter(f => {
      if (f === 'AccountId') return !accountSelected?.id;
      return !formData[f];
    });

    if (missing.length > 0) {
      const fieldLabels = missing.map(f => {
        if (f === 'AccountId') return 'Cuenta';
        const found = FIELD_MAP.find(fm => fm.api === f);
        return found ? found.label : f;
      });
      setError(`Para cerrar el caso debes completar: ${fieldLabels.join(', ')}`);
      return;
    }

    setShowCloseDialog(true);
    setError(null);
  };

  const handleConfirmClose = async () => {
    if (!resolucion.trim()) { setError('La resolución es obligatoria para cerrar el caso.'); return; }
    if (!closeSubetapa) { setError('Selecciona una subetapa de resolución.'); return; }

    setError(null);
    setIsClosing(true);
    try {
      await fetch(`${API}/cases/${caseId}/close`, {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({ ticket_id: ticketId, resolucion, subetapa_resuelto: closeSubetapa }),
      }).then(async r => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || r.statusText);
      });
      setShowCloseDialog(false);
      setSuccessMsg('🔒 Caso cerrado correctamente en Salesforce.');
      if (onCaseCreated) onCaseCreated({ sf_case_id: caseId, sf_case_number: caseNumber, status: 'Closed' });
    } catch (e) {
      setError('Error al cerrar: ' + e.message);
    } finally {
      setIsClosing(false);
    }
  };

  // ── Change Status ────────────────────────────────────────────────────────
  const handleOpenStatusDialog = () => {
    if (!caseId) { setError('Crea el caso en Salesforce primero.'); return; }
    setNewStatus('');
    setWaitSubetapa('');
    setShowStatusDialog(true);
  };

  const handleConfirmStatusChange = async () => {
    if (!newStatus) { setError('Selecciona un estado.'); return; }
    if (newStatus === 'En espera' && !waitSubetapa) {
      setError('Para estado "En espera" debes seleccionar una subetapa.'); return;
    }

    setError(null);
    setIsSaving(true);
    try {
      const payload = { ticket_id: ticketId, Status: newStatus };
      if (newStatus === 'En espera' && waitSubetapa) {
        payload.subetapa_en_espera__c = waitSubetapa;
      }
      await fetch(`${API}/cases/${caseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(async r => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || r.statusText);
      });
      setCurrentStatus(newStatus);
      setShowStatusDialog(false);
      setSuccessMsg(`📋 Estado cambiado a "${newStatus}".`);
    } catch (e) {
      setError('Error al cambiar estado: ' + e.message);
    } finally {
      setIsSaving(false);
    }
  };

  // ── Assign to Me ────────────────────────────────────────────────────────--
  const handleAssignMe = async () => {
    if (!caseId) { setError('Crea el caso en Salesforce primero.'); return; }
    setIsAssigning(true);
    setError(null);
    try {
      await fetch(`${API}/cases/${caseId}/assign-me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket_id: ticketId }),
      })
        .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); });
      setAssignedToMe(true);
      setSuccessMsg(`👤 Caso asignado a ${ownerInfo?.displayName || 'ti'}.`);
    } catch (e) {
      setError('Error al asignar: ' + e.message);
    } finally {
      setIsAssigning(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="sf-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sf-modal">

        {/* ── HEADER ── */}
        <div className="sf-modal__header">
          <div className="sf-modal__title-area">
            <div className="sf-modal__badge">☁️ Salesforce</div>
            <h2 className="sf-modal__title">
              {caseNumber ? `Case #${caseNumber}` : 'Crear Nuevo Caso'}
            </h2>
            {ticket?.nombre_analista && (
              <p className="sf-modal__subtitle">
                {ticket.nombre_analista}
                {ticket.nombre_empresa ? ` · ${ticket.nombre_empresa}` : ''}
              </p>
            )}
            {currentStatus && (
              <span className={`sf-status-badge sf-status-badge--${currentStatus.toLowerCase().replace(/\s+/g, '-')}`}>
                {currentStatus}
              </span>
            )}
          </div>
          <div className="sf-modal__header-actions">
            {caseId && (
              <button
                className="sf-btn sf-btn--status"
                onClick={handleOpenStatusDialog}
                disabled={isSaving}
                title="Cambiar estado del caso"
              >
                📋 Cambiar Estado
              </button>
            )}
            {caseId && (
              <button
                className={`sf-btn ${assignedToMe ? 'sf-btn--assigned' : 'sf-btn--assign'}`}
                onClick={handleAssignMe}
                disabled={isAssigning || assignedToMe}
                title="Asignarme este caso"
              >
                {isAssigning ? '⏳' : assignedToMe ? '✅ Asignado a mí' : '👤 Asignarme'}
              </button>
            )}
            <button className="sf-modal__close-btn" onClick={onClose} title="Cerrar">✕</button>
          </div>
        </div>

        {/* ── BODY ── */}
        <div className="sf-modal__body">
          {loadingMeta ? (
            <div className="sf-loading">
              <div className="qr-loading__spinner" />
              <p>Cargando configuración de Salesforce...</p>
            </div>
          ) : (
            <>
              {error      && <div className="sf-alert sf-alert--error">{error}</div>}
              {successMsg && <div className="sf-alert sf-alert--success">{successMsg}</div>}

              {ownerInfo && (
                <div className="sf-owner-banner">
                  <span>👤</span>
                  <span>Operando como <strong>{ownerInfo.displayName}</strong> ({ownerInfo.email})</span>
                </div>
              )}

              <div className="sf-section">
                <h3 className="sf-section__title">🏢 Cuenta Asociada</h3>
                <AccountLookup
                  initialAccount={accountSelected}
                  ticketId={ticketId}
                  onSelect={acc => setAccountSelected(acc)}
                />
              </div>

              <div className="sf-section">
                <h3 className="sf-section__title">📋 Tipificación y Campos del Caso</h3>
                <div className="sf-form-grid">
                  {FIELD_MAP.map(f => {
                    const depInfo = dependencies[f.api];
                    const isDependent = !!depInfo?.controllerField;
                    const controllerLabel = isDependent
                      ? FIELD_MAP.find(cf => cf.api === depInfo.controllerField)?.label || depInfo.controllerField
                      : null;
                    const controllerHasValue = isDependent ? !!formData[depInfo.controllerField] : true;
                    const options = getFilteredOptions(f.api);

                    return (
                      <div key={f.api} className="sf-field">
                        <label className="sf-label">
                          {f.label}
                          {isDependent && <span className="sf-label__dep"> (depende de {controllerLabel})</span>}
                        </label>
                        <select
                          className="sf-select"
                          value={formData[f.api] || ''}
                          onChange={e => setField(f.api, e.target.value)}
                          disabled={isDependent && !controllerHasValue}
                        >
                          <option value="">
                            {isDependent && !controllerHasValue
                              ? `— Selecciona ${controllerLabel} primero —`
                              : '— Seleccionar —'}
                          </option>
                          {options.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="sf-section sf-section--close">
                <h3 className="sf-section__title">🔒 Cierre del Caso</h3>
                <p className="sf-section__hint">
                  Completa la resolución y selecciona la subetapa para cerrar. Solo disponible si el caso ya fue creado en SF.
                </p>
                <textarea
                  className="sf-textarea"
                  rows={4}
                  placeholder="Descríbe detalladamente la solución aplicada..."
                  value={resolucion}
                  onChange={e => setResolucion(e.target.value)}
                />
              </div>
            </>
          )}
        </div>

        {/* ── FOOTER ── */}
        {!loadingMeta && (
          <div className="sf-modal__footer">
            <button className="sf-btn sf-btn--ghost" onClick={onClose}>Cancelar</button>
            <div style={{ flex: 1 }} />
            <button
              className="sf-btn sf-btn--danger"
              onClick={handleOpenCloseDialog}
              disabled={!resolucion.trim() || !caseId || isClosing}
              title={!caseId ? 'Crea el caso primero' : !resolucion.trim() ? 'Escribe la resolución' : 'Cerrar caso en SF'}
            >
              {isClosing ? '⏳ Cerrando...' : '🔒 Cerrar Caso'}
            </button>
            <button
              className="sf-btn sf-btn--primary"
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving
                ? '⏳ Guardando...'
                : caseId
                  ? '💾 Actualizar Caso'
                  : '🚀 Crear en Salesforce'}
            </button>
          </div>
        )}

        {/* ── CLOSE DIALOG ── */}
        {showCloseDialog && (
          <div className="sf-modal-overlay" style={{ background: 'rgba(0,0,0,0.7)' }} onClick={e => { if (e.target === e.currentTarget && !isClosing) setShowCloseDialog(false); }}>
            <div className="sf-modal" style={{ maxWidth: 480 }}>
              <div className="sf-modal__header">
                <div className="sf-modal__title-area">
                  <div className="sf-modal__badge">🔒 Cerrar Caso</div>
                  <h2 className="sf-modal__title">Subetapa de Resolución</h2>
                  <p className="sf-modal__subtitle">Selecciona cómo se resolvió este caso</p>
                </div>
                <button className="sf-modal__close-btn" onClick={() => !isClosing && setShowCloseDialog(false)} disabled={isClosing}>✕</button>
              </div>
              <div className="sf-modal__body">
                {error && <div className="sf-alert sf-alert--error">{error}</div>}
                <div className="sf-section">
                  <h3 className="sf-section__title">Subetapa de Resolución</h3>
                  <div className="sf-field">
                    <label className="sf-label">¿Cómo se resolvió?</label>
                    <select
                      className="sf-select"
                      value={closeSubetapa}
                      onChange={e => setCloseSubetapa(e.target.value)}
                    >
                      <option value="">— Seleccionar —</option>
                      {(picklists['Subetapa_resuelto__c'] || []).map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="sf-section">
                  <h3 className="sf-section__title">Resolución</h3>
                  <p className="sf-section__hint">{resolucion}</p>
                </div>
              </div>
              <div className="sf-modal__footer">
                <button className="sf-btn sf-btn--ghost" onClick={() => !isClosing && setShowCloseDialog(false)} disabled={isClosing}>Volver</button>
                <div style={{ flex: 1 }} />
                <button
                  className="sf-btn sf-btn--danger"
                  onClick={handleConfirmClose}
                  disabled={!closeSubetapa || isClosing}
                >
                  {isClosing ? '⏳ Cerrando...' : '🔒 Confirmar Cierre'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── STATUS CHANGE DIALOG ── */}
        {showStatusDialog && (
          <div className="sf-modal-overlay" style={{ background: 'rgba(0,0,0,0.7)' }} onClick={e => { if (e.target === e.currentTarget && !isSaving) setShowStatusDialog(false); }}>
            <div className="sf-modal" style={{ maxWidth: 480 }}>
              <div className="sf-modal__header">
                <div className="sf-modal__title-area">
                  <div className="sf-modal__badge">📋 Estado</div>
                  <h2 className="sf-modal__title">Cambiar Estado del Caso</h2>
                  {currentStatus && <p className="sf-modal__subtitle">Estado actual: <strong>{currentStatus}</strong></p>}
                </div>
                <button className="sf-modal__close-btn" onClick={() => !isSaving && setShowStatusDialog(false)} disabled={isSaving}>✕</button>
              </div>
              <div className="sf-modal__body">
                {error && <div className="sf-alert sf-alert--error">{error}</div>}
                <div className="sf-section">
                  <h3 className="sf-section__title">Nuevo Estado</h3>
                  <div className="sf-field">
                    <label className="sf-label">Estado</label>
                    <select
                      className="sf-select"
                      value={newStatus}
                      onChange={e => setNewStatus(e.target.value)}
                    >
                      <option value="">— Seleccionar estado —</option>
                      {(picklists['Status'] || []).map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Subetapa En Espera - solo si el estado es "En espera" */}
                {newStatus === 'En espera' && (
                  <div className="sf-section">
                    <h3 className="sf-section__title">Subetapa En Espera</h3>
                    <div className="sf-field">
                      <label className="sf-label">¿Por qué está en espera?</label>
                      <select
                        className="sf-select"
                        value={waitSubetapa}
                        onChange={e => setWaitSubetapa(e.target.value)}
                      >
                        <option value="">— Seleccionar subetapa —</option>
                        {(picklists['subetapa_en_espera__c'] || []).map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
              <div className="sf-modal__footer">
                <button className="sf-btn sf-btn--ghost" onClick={() => !isSaving && setShowStatusDialog(false)} disabled={isSaving}>Cancelar</button>
                <div style={{ flex: 1 }} />
                <button
                  className="sf-btn sf-btn--primary"
                  onClick={handleConfirmStatusChange}
                  disabled={!newStatus || (newStatus === 'En espera' && !waitSubetapa) || isSaving}
                >
                  {isSaving ? '⏳ Guardando...' : '💾 Aplicar Cambio'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
