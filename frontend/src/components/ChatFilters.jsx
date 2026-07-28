const FILTERS = [
  ['all', 'Activos'],
  ['mine', 'Asignados a mí'],
  ['unassigned', 'Sin asignar'],
  ['sla', 'SLA crítico'],
  ['alta', 'Alta'],
  ['manual', 'Manual'],
  ['silenced', 'Silenc.'],
  ['cerrados', 'Cerrados'],
];

export default function ChatFilters({ filter, isAdmin, onChange }) {
  const filters = isAdmin ? [...FILTERS, ['candidates', 'Candidatos']] : FILTERS;

  return (
    <div className="filter-tabs">
      {filters.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={filter === id}
          onClick={() => onChange(id)}
          className={`filter-tab ${id === 'candidates' ? 'filter-tab--candidate' : ''} ${filter === id ? 'filter-tab--active' : ''}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
