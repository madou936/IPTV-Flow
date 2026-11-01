import { useEffect, useMemo, useState } from 'react'
import type { Category, CategoryPrefs } from '../types'
import { orderCategories } from '../lib/categories'

interface Props {
  title: string
  categories: Category[]
  prefs: CategoryPrefs
  onClose: () => void
  onSave: (prefs: CategoryPrefs) => void
}

interface Row {
  id: string
  name: string
  hidden: boolean
}

export default function CategorySettings({ title, categories, prefs, onClose, onSave }: Props): JSX.Element {
  const initial = useMemo<Row[]>(() => {
    const ordered = orderCategories(categories, prefs.order).map((c) => ({
      id: c.category_id,
      name: c.category_name,
      hidden: prefs.hidden.includes(c.category_id)
    }))
    return [...ordered.filter((row) => !row.hidden), ...ordered.filter((row) => row.hidden)]
  }, [categories, prefs])
  const [rows, setRows] = useState<Row[]>(initial)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [showHidden, setShowHidden] = useState(false)

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  function grouped(next: Row[]): Row[] {
    return [...next.filter((row) => !row.hidden), ...next.filter((row) => row.hidden)]
  }

  function move(from: number, to: number): void {
    if (to < 0 || to >= rows.length || rows[from].hidden !== rows[to].hidden) return
    const next = rows.slice()
    const [r] = next.splice(from, 1)
    next.splice(to, 0, r)
    setRows(grouped(next))
  }

  function groupStart(i: number): number {
    let start = i
    while (start > 0 && rows[start - 1].hidden === rows[i].hidden) start--
    return start
  }
  function groupEnd(i: number): number {
    let end = i
    while (end + 1 < rows.length && rows[end + 1].hidden === rows[i].hidden) end++
    return end
  }
  function toTop(i: number): void {
    move(i, groupStart(i))
  }
  function toBottom(i: number): void {
    move(i, groupEnd(i))
  }
  function toggleHidden(i: number): void {
    const targets = selectedIds.includes(rows[i].id) ? new Set(selectedIds) : new Set([rows[i].id])
    const next = grouped(rows.map((r) => targets.has(r.id) ? { ...r, hidden: !r.hidden } : r))
    setRows(next)
    setAnchorIndex(next.findIndex((row) => row.id === rows[i].id))
  }

  function selectRow(i: number, event: React.MouseEvent<HTMLSpanElement>): void {
    if (event.shiftKey && anchorIndex !== null) {
      const anchorPosition = displayedIndices.indexOf(anchorIndex)
      const targetPosition = displayedIndices.indexOf(i)
      if (anchorPosition >= 0 && targetPosition >= 0) {
        const start = Math.min(anchorPosition, targetPosition)
        const end = Math.max(anchorPosition, targetPosition)
        setSelectedIds(displayedIndices.slice(start, end + 1).map((index) => rows[index].id))
        return
      }
    }
    setAnchorIndex(i)
    setSelectedIds([rows[i].id])
  }

  function save(): void {
    onSave({
      order: rows.map((r) => r.id),
      hidden: rows.filter((r) => r.hidden).map((r) => r.id)
    })
  }

  const hiddenCount = rows.filter((r) => r.hidden).length
  const visibleCount = rows.length - hiddenCount
  const query = search.trim().toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const matches = rows.map((row, index) => ({ row, index })).filter(({ row }) =>
    row.name.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(query)
  )
  const visibleRows = matches.filter(({ row }) => !row.hidden)
  const hiddenRows = matches.filter(({ row }) => row.hidden)
  const displayedIndices = [...visibleRows, ...(showHidden ? hiddenRows : [])].map(({ index }) => index)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-settings" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Fermer">
          ✕
        </button>

        <h2 className="settings-title">Catégories · {title}</h2>
        <p className="settings-sub">
          {rows.length} catégories · {visibleCount} affichées · {hiddenCount} masquées
        </p>

        <div className="settings-search-wrap">
          <input
            className="search settings-category-search"
            type="search"
            placeholder="Rechercher une catégorie…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            autoFocus
          />
        </div>

        <div className="settings-list">
          {visibleRows.map(({ row: r, index: i }) => (
            <CategoryRow key={r.id} row={r} index={i} selected={selectedIds.includes(r.id)} selectRow={selectRow}
              toggleHidden={toggleHidden} toTop={toTop} move={move} toBottom={toBottom}
              groupStart={groupStart} groupEnd={groupEnd} rows={rows} />
          ))}
          {hiddenCount > 0 && (
            <div className="settings-hidden-group">
              <button className="settings-hidden-toggle" onClick={() => setShowHidden((value) => !value)}>
                <span aria-hidden="true">{showHidden ? '▾' : '▸'}</span>
                Catégories masquées ({hiddenCount}){query.length > 0 ? ` · ${hiddenRows.length} trouvée(s)` : ''}
                <span className="settings-hidden-action">{showHidden ? 'Replier' : 'Déplier'}</span>
              </button>
              {showHidden && hiddenRows.map(({ row: r, index: i }) => (
                <CategoryRow key={r.id} row={r} index={i} selected={selectedIds.includes(r.id)} selectRow={selectRow}
                  toggleHidden={toggleHidden} toTop={toTop} move={move} toBottom={toBottom}
                  groupStart={groupStart} groupEnd={groupEnd} rows={rows} />
              ))}
            </div>
          )}
          {matches.length === 0 && <div className="settings-no-categories">Aucune catégorie trouvée.</div>}
        </div>

        <div className="settings-actions">
          <button className="btn-ghost" onClick={onClose}>
            Annuler
          </button>
          <button className="btn-primary" onClick={save}>
            Enregistrer
          </button>
        </div>
      </div>
    </div>
  )
}

interface CategoryRowProps {
  row: Row
  index: number
  selected: boolean
  selectRow: (index: number, event: React.MouseEvent<HTMLSpanElement>) => void
  toggleHidden: (index: number) => void
  toTop: (index: number) => void
  move: (from: number, to: number) => void
  toBottom: (index: number) => void
  groupStart: (index: number) => number
  groupEnd: (index: number) => number
  rows: Row[]
}

function CategoryRow({ row: r, index: i, selected, selectRow, toggleHidden, toTop, move, toBottom, groupStart, groupEnd, rows }: CategoryRowProps): JSX.Element {
  return (
    <div className={`settings-row ${r.hidden ? 'is-hidden' : ''} ${selected ? 'is-selected' : ''}`}>
      <button className={`eye ${r.hidden ? '' : 'on'}`} onClick={() => toggleHidden(i)} title={r.hidden ? 'Afficher' : 'Masquer'}>
        {r.hidden ? '🚫' : '👁'}
      </button>
      <span className="settings-name" onClick={(event) => selectRow(i, event)}>{r.name}</span>
      <div className="row-moves">
        <button onClick={() => toTop(i)} disabled={i === groupStart(i)} title="Tout en haut">⤒</button>
        <button onClick={() => move(i, i - 1)} disabled={i === 0 || rows[i - 1]?.hidden !== r.hidden} title="Monter">↑</button>
        <button onClick={() => move(i, i + 1)} disabled={i === rows.length - 1 || rows[i + 1]?.hidden !== r.hidden} title="Descendre">↓</button>
        <button onClick={() => toBottom(i)} disabled={i === groupEnd(i)} title="Tout en bas">⤓</button>
      </div>
    </div>
  )
}
