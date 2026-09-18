window.__ModuleLoader__.load({
	id: "dsh-session-cleanup",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		/**
		 * Archived-session cleanup — browser half.
		 *
		 * Replaces the upstream read-only archived-sessions settings page with one that
		 * can delete. The page renders the same rows (the archive set joined with the
		 * loaded Session summaries, newest archive first, filtered by one search box)
		 * and drives this plugin's host half, which owns the only destructive write.
		 *
		 * A deletion also re-pulls the Session list: the host drops the deleted
		 * sessions from its own listing, and this client's snapshot would otherwise
		 * keep listing them (no Session lifecycle event accompanies a deleted log), so
		 * they would return to the sidebar as rows nothing can open.
		 *
		 * The page keeps the upstream unarchive action: cleanup and restore are the two
		 * ways out of the archive, and removing one to add the other would be a
		 * regression rather than a feature.
		 *
		 * @module dsh-session-cleanup/client
		 */

		const { createElement, useMemo, useState } = require("react");

		/** Dictionary namespace owned by this plugin. */
		const NS = 'settings.archivedSessions'

		/** Plugin name, as the loader row declares it. */
		const name = 'dsh-session-cleanup'

		/** Services the settings registration, the delete write, and the list refresh require. */
		const inject = ['slots', 'locale', 'uiWorkspace', 'sessions']

		/** The delete route this plugin's host half registers. */
		const DELETE_ROUTE = '/plugins/dsh-session-cleanup/delete'

		/** Copy dictionaries for the archived-session settings page. */
		const zh = {
		  nav: '已归档会话',
		  search: '搜索已归档会话',
		  loading: '正在读取会话…',
		  empty: '暂无已归档会话。',
		  unavailable: '这里没有可恢复的已归档会话。',
		  emptySearch: '没有匹配的会话。',
		  unarchive: '取消归档',
		  unarchiveNamed: '取消归档 {title}',
		  ungrouped: '未分组',
		  count: '共 {n} 个已归档会话',
		  missingTitle: '会话记录已不在磁盘上',
		  missingMeta: '记录已删除',
		  delete: '删除',
		  deleteNamed: '删除 {title}',
		  deleteAll: '全部删除',
		  deleteConfirmTitle: '删除已归档会话',
		  deleteConfirmOne: '将永久删除「{title}」的会话记录，无法恢复。',
		  deleteConfirmMany: '将永久删除 {n} 个已归档会话及其会话记录，无法恢复。',
		  deleteConfirmAll: '将永久删除全部 {n} 个已归档会话及其会话记录，无法恢复。',
		  deleteConfirmSearch: '提示：当前列表已按搜索词过滤，但「全部删除」会删除所有已归档会话。',
		  deleteConfirmStale: '其中 {n} 条的会话记录已不在磁盘上，将只把它们从归档列表移除。',
		  cancel: '取消',
		  confirmDelete: '永久删除',
		  deleting: '正在删除…',
		  deleteFailed: '删除失败：{message}',
		  deletePartial: '已删除 {removed} 个，{failed} 个失败。',
		  deleteMissing: '已删除 {removed} 个；另有 {missing} 个在磁盘上已不存在，已从归档列表移除。',
		  'time.now': '刚刚',
		  'time.minutes': '{n}分钟',
		  'time.hours': '{n}小时',
		  'time.days': '{n}天',
		  'time.months': '{n}个月',
		  'time.years': '{n}年',
		}

		/** English dictionary checked against the Chinese key set. */
		const en = {
		  nav: 'Archived sessions',
		  search: 'Search archived sessions',
		  loading: 'Reading sessions…',
		  empty: 'No archived sessions.',
		  unavailable: 'No archived session here can be restored.',
		  emptySearch: 'No matching sessions.',
		  unarchive: 'Unarchive',
		  unarchiveNamed: 'Unarchive {title}',
		  ungrouped: 'Ungrouped',
		  count: '{n} archived sessions',
		  missingTitle: 'Session log is gone',
		  missingMeta: 'log already deleted',
		  delete: 'Delete',
		  deleteNamed: 'Delete {title}',
		  deleteAll: 'Delete all',
		  deleteConfirmTitle: 'Delete archived sessions',
		  deleteConfirmOne: 'This permanently deletes “{title}” and its session log. It cannot be undone.',
		  deleteConfirmMany: 'This permanently deletes {n} archived sessions and their session logs. It cannot be undone.',
		  deleteConfirmAll: 'This permanently deletes all {n} archived sessions and their session logs. It cannot be undone.',
		  deleteConfirmSearch: 'Note: the list is filtered by your search, but Delete all removes every archived session.',
		  deleteConfirmStale: '{n} of them have no session log left; those are only removed from this list.',
		  cancel: 'Cancel',
		  confirmDelete: 'Delete permanently',
		  deleting: 'Deleting…',
		  deleteFailed: 'Delete failed: {message}',
		  deletePartial: 'Deleted {removed}; {failed} failed.',
		  deleteMissing: 'Deleted {removed}; {missing} no longer existed on disk and were removed from the list.',
		  'time.now': 'now',
		  'time.minutes': '{n}min',
		  'time.hours': '{n}h',
		  'time.days': '{n}d',
		  'time.months': '{n}mo',
		  'time.years': '{n}y',
		}

		/* ── styles ──────────────────────────────────────────────────────────────── */
		/* Inline objects rather than a stylesheet: a client plugin's bundle is loaded
		   as a module, and the established local convention is style objects over CSS
		   injection. Every colour reads a theme alias so both themes track. */

		const sectionStyle = { width: '100%', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 12 }
		const statusStyle = { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' }
		const errorStyle = { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-error, #d33)' }
		const searchStyle = {
		  width: '100%',
		  height: 32,
		  border: '0.5px solid var(--dsw-alias-border-l2)',
		  background: 'var(--dsw-alias-bg-base)',
		  color: 'var(--dsw-alias-label-primary)',
		  font: 'inherit',
		  borderRadius: 8,
		  padding: '0 12px 0 12px',
		  boxSizing: 'border-box',
		}
		const toolbarStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }
		const countStyle = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
		const listStyle = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }
		const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8 }
		const identityStyle = { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }
		const titleStyle = {
		  fontSize: 13,
		  lineHeight: '20px',
		  whiteSpace: 'nowrap',
		  overflow: 'hidden',
		  textOverflow: 'ellipsis',
		}
		const metaStyle = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
		const actionStyle = {
		  flex: 'none',
		  font: 'inherit',
		  fontSize: 13,
		  lineHeight: '20px',
		  padding: '3px 10px',
		  borderRadius: 8,
		  cursor: 'pointer',
		  border: '0.5px solid var(--dsw-alias-border-l2)',
		  background: 'var(--dsw-alias-bg-base)',
		  color: 'var(--dsw-alias-label-primary)',
		}
		const dangerStyle = {
		  ...actionStyle,
		  border: '0.5px solid var(--dsw-alias-border-l2)',
		  color: 'var(--dsw-alias-label-error, #d33)',
		}
		const dialogStyle = {
		  border: '0.5px solid var(--dsw-alias-border-l2)',
		  background: 'var(--dsw-alias-bg-layer-1, #fff)',
		  borderRadius: 12,
		  padding: '14px 16px',
		  display: 'flex',
		  flexDirection: 'column',
		  gap: 8,
		}
		const dialogTitleStyle = { margin: 0, fontSize: 13, lineHeight: '20px', fontWeight: 600 }
		const dialogTextStyle = { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
		const dialogActionsStyle = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 }

		/**
		 * Ask the host half to delete sessions.
		 * @param ids - session ids to delete.
		 * @returns the per-id outcome; rejects with a readable message on failure.
		 */
		async function requestDelete(ids) {
		  const response = await fetch(DELETE_ROUTE, {
		    method: 'POST',
		    credentials: 'same-origin',
		    headers: { 'content-type': 'application/json', accept: 'application/json' },
		    body: JSON.stringify({ ids }),
		  })
		  let parsed
		  try {
		    parsed = JSON.parse(await response.text())
		  } catch {
		    throw new Error(`HTTP ${String(response.status)}`)
		  }
		  if (!response.ok) {
		    throw new Error(typeof parsed?.error === 'string' ? parsed.error : `HTTP ${String(response.status)}`)
		  }
		  return parsed
		}

		/**
		 * Localized compact relative time of one row's last activity.
		 * @param updatedAt - last activity timestamp.
		 * @param now - the render-time clock.
		 * @param t - the bound translator.
		 * @returns the localized label.
		 */
		function timeLabel(updatedAt, now, t) {
		  const elapsed = Math.max(0, now - updatedAt)
		  const minute = 60_000
		  const hour = 60 * minute
		  const day = 24 * hour
		  if (elapsed < minute) return t('time.now')
		  if (elapsed < hour) return t('time.minutes', { n: Math.floor(elapsed / minute) })
		  if (elapsed < day) return t('time.hours', { n: Math.floor(elapsed / hour) })
		  const days = Math.floor(elapsed / day)
		  if (days < 30) return t('time.days', { n: days })
		  if (days < 365) return t('time.months', { n: Math.floor(days / 30) })
		  return t('time.years', { n: Math.floor(days / 365) })
		}

		/**
		 * Whether one row matches the normalized query in its title or Workspace label.
		 * @param row - the derived row.
		 * @param normalizedQuery - the lowercased, trimmed query.
		 * @returns true when the row should render.
		 */
		function matches(row, normalizedQuery) {
		  return (
		    normalizedQuery.length === 0 ||
		    row.title.toLowerCase().includes(normalizedQuery) ||
		    row.workspace.toLowerCase().includes(normalizedQuery)
		  )
		}

		/**
		 * Render the archived-session page with delete affordances.
		 * @param props - composed slot props (locale seat, hooks, and injections).
		 * @returns the settings page element tree.
		 */
		function ArchivedSessionsSection(props) {
		  const { t, unarchive, refresh, useSessions, useWorkspaces } = props
		  const sessions = useSessions((state) => state)
		  const workspaces = useWorkspaces((state) => state.items)
		  const archivedSessionIds = useWorkspaces((state) => state.archivedSessionIds)
		  const [query, setQuery] = useState('')
		  const [pending, setPending] = useState(null)
		  const [busy, setBusy] = useState(false)
		  const [error, setError] = useState(null)
		  const [hovered, setHovered] = useState(null)
		  const ungrouped = t('ungrouped')
		  const summaries = sessions.byId

		  const rows = useMemo(() => {
		    const owners = new Map()
		    for (const workspace of workspaces) {
		      for (const id of workspace.sessionIds) owners.set(id, workspace.title)
		    }
		    return [...archivedSessionIds].reverse().flatMap((id) => {
		      const summary = summaries[id]
		      const workspace = owners.get(id) ?? ungrouped
		      if (summary === undefined) {
		        // The archive set outlives the log: an id can be archived while its log
		        // directory is already gone (a deletion that failed before the archive
		        // write, or a directory removed by hand). Rendering it anyway is what
		        // keeps such an entry clearable — the alternative hides it forever,
		        // because the archive set has no other surface and the count would
		        // silently disagree with what the page shows.
		        return [{ id, title: t('missingTitle'), workspace, updatedAt: undefined, missing: true }]
		      }
		      return [{ id, title: summary.displayTitle, workspace, updatedAt: summary.updatedAt, missing: false }]
		    })
		  }, [archivedSessionIds, workspaces, summaries, ungrouped, t])

		  if (sessions.phase !== 'ready') {
		    return createElement('p', { style: statusStyle }, t('loading'))
		  }

		  const now = Date.now()
		  const normalized = query.trim().toLowerCase()
		  const visible = rows.filter((row) => matches(row, normalized))
		  const archived = archivedSessionIds.length > 0

		  /**
		   * Run one deletion and fold the host's per-id outcome into page state. A
		   * partial failure reports counts rather than pretending full success.
		   *
		   * A successful deletion also re-pulls the Session list. The host has just
		   * dropped those sessions from its own listing, but this client's copy is a
		   * snapshot that only advances on Session lifecycle events — and deleting a
		   * log emits none. Without the re-pull the deleted sessions stop being
		   * archived while still being listed, i.e. they come back to the sidebar as
		   * rows that cannot be opened.
		   * @param targets - the rows to delete.
		   */
		  const runDelete = async (targets) => {
		    setBusy(true)
		    setError(null)
		    try {
		      const result = await requestDelete(targets.map((row) => row.id))
		      const failed = Array.isArray(result?.failed) ? result.failed.length : 0
		      const removed = Array.isArray(result?.removed) ? result.removed.length : 0
		      const missing = Array.isArray(result?.missing) ? result.missing.length : 0
		      if (failed > 0) setError(t('deletePartial', { removed, failed }))
		      else if (missing > 0) setError(t('deleteMissing', { removed, missing }))
		      if (failed === 0 && removed + missing > 0) {
		        // Best effort: the deletion already succeeded, so a failed re-pull must
		        // not be reported as a failed deletion.
		        refresh().catch((reason) => {
		          console.warn('session list refresh rejected:', reason)
		        })
		      }
		      setPending(null)
		    } catch (reason) {
		      setError(t('deleteFailed', { message: reason instanceof Error ? reason.message : String(reason) }))
		    } finally {
		      setBusy(false)
		    }
		  }

		  const children = []

		  children.push(
		    createElement('input', {
		      key: 'search',
		      type: 'search',
		      value: query,
		      placeholder: t('search'),
		      'aria-label': t('search'),
		      style: searchStyle,
		      onChange: (event) => {
		        setQuery(event.currentTarget.value)
		      },
		    }),
		  )

		  if (archived) {
		    children.push(
		      createElement(
		        'div',
		        { key: 'toolbar', style: toolbarStyle },
		        createElement('span', { style: countStyle }, t('count', { n: rows.length })),
		        createElement(
		          'button',
		          {
		            type: 'button',
		            style: dangerStyle,
		            disabled: busy || rows.length === 0,
		            onClick: () => {
		              // Delete-all targets every archived entry, not `visible`: the
		              // search box filters what you see, and silently narrowing a
		              // destructive bulk action to the current filter is how people
		              // delete the wrong set. When a filter is active the dialog says
		              // so explicitly. Entries whose log is already gone are included
		              // so a bulk delete really does empty the archive set.
		              setPending({ kind: 'all', rows })
		            },
		          },
		          t('deleteAll'),
		        ),
		      ),
		    )
		  }

		  if (!archived) children.push(createElement('p', { key: 'empty', style: statusStyle }, t('empty')))
		  if (archived && rows.length === 0) {
		    children.push(createElement('p', { key: 'unavailable', style: statusStyle }, t('unavailable')))
		  }
		  if (rows.length > 0 && visible.length === 0) {
		    children.push(createElement('p', { key: 'emptySearch', style: statusStyle }, t('emptySearch')))
		  }

		  if (visible.length > 0) {
		    children.push(
		      createElement(
		        'ul',
		        { key: 'list', style: listStyle },
		        visible.map((row) =>
		          createElement(
		            'li',
		            {
		              key: row.id,
		              style: { ...rowStyle, background: hovered === row.id ? 'var(--dsw-alias-bg-layer-1)' : 'transparent' },
		              onMouseEnter: () => {
		                setHovered(row.id)
		              },
		              onMouseLeave: () => {
		                setHovered((current) => (current === row.id ? null : current))
		              },
		            },
		            createElement(
		              'span',
		              { style: identityStyle },
		              createElement('span', { style: titleStyle }, row.title),
		              createElement(
		                'span',
		                { style: metaStyle },
		                row.missing === true
		                  ? [row.workspace, t('missingMeta')].join(' · ')
		                  : [row.workspace, timeLabel(row.updatedAt, now, t)].join(' · '),
		              ),
		            ),
		            createElement(
		              'button',
		              {
		                type: 'button',
		                style: actionStyle,
		                disabled: busy,
		                'aria-label': t('unarchiveNamed', { title: row.title }),
		                onClick: () => {
		                  unarchive(row.id).catch((reason) => {
		                    console.warn('session unarchive rejected:', reason)
		                  })
		                },
		              },
		              t('unarchive'),
		            ),
		            // Nothing left to delete for an entry whose log is gone; the
		            // unarchive action above is what retires it from the archive set.
		            row.missing === true
		              ? null
		              : createElement(
		                  'button',
		                  {
		                    type: 'button',
		                    style: dangerStyle,
		                    disabled: busy,
		                    'aria-label': t('deleteNamed', { title: row.title }),
		                    onClick: () => {
		                      setPending({ kind: 'one', rows: [row] })
		                    },
		                  },
		                  t('delete'),
		                ),
		          ),
		        ),
		      ),
		    )
		  }

		  if (error !== null) {
		    children.push(createElement('p', { key: 'error', style: errorStyle, role: 'status' }, error))
		  }

		  if (pending !== null) {
		    const staleCount = pending.rows.filter((row) => row.missing === true).length
		    const confirmText =
		      pending.kind === 'all'
		        ? t('deleteConfirmAll', { n: pending.rows.length })
		        : pending.rows.length === 1
		          ? t('deleteConfirmOne', { title: pending.rows[0].title })
		          : t('deleteConfirmMany', { n: pending.rows.length })

		    children.push(
		      createElement(
		        'div',
		        {
		          key: 'dialog',
		          style: dialogStyle,
		          role: 'dialog',
		          'aria-modal': 'true',
		          'aria-label': t('deleteConfirmTitle'),
		        },
		        createElement('p', { style: dialogTitleStyle }, t('deleteConfirmTitle')),
		        createElement('p', { style: dialogTextStyle }, confirmText),
		        pending.kind === 'all' && staleCount > 0
		          ? createElement('p', { style: dialogTextStyle }, t('deleteConfirmStale', { n: staleCount }))
		          : null,
		        pending.kind === 'all' && normalized.length > 0 && rows.length > visible.length
		          ? createElement('p', { style: dialogTextStyle }, t('deleteConfirmSearch'))
		          : null,
		        createElement(
		          'div',
		          { style: dialogActionsStyle },
		          createElement(
		            'button',
		            {
		              type: 'button',
		              style: actionStyle,
		              disabled: busy,
		              onClick: () => {
		                setPending(null)
		              },
		            },
		            t('cancel'),
		          ),
		          createElement(
		            'button',
		            {
		              type: 'button',
		              style: dangerStyle,
		              disabled: busy,
		              onClick: () => {
		                void runDelete(pending.rows)
		              },
		            },
		            busy ? t('deleting') : t('confirmDelete'),
		          ),
		        ),
		      ),
		    )
		  }

		  return createElement('div', { style: sectionStyle }, children)
		}

		/** Contribute the archived-session page to Settings. */
		function apply(ctx) {
		  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-cleanup: dictionaries')
		  const t = ctx.locale.bind(NS)
		  const injected = () => ({
		    unarchive: (sessionId) => ctx.uiWorkspace.unarchiveSession(sessionId),
		    // Re-pull the Session list after a deletion: the host has already dropped
		    // the deleted sessions, and this is what removes them from the sidebar.
		    refresh: () => ctx.sessions.refresh(),
		  })
		  ctx.slots.inject('settings.section', () =>
		    ctx.slots.register(
		      {
		        name: 'settings.section',
		        id: 'archived-sessions',
		        order: 25,
		        label: () => t('nav'),
		        locale: NS,
		        inject: injected,
		      },
		      ArchivedSessionsSection,
		    ),
		  )
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
