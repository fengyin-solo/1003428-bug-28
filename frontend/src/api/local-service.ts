import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRowsTx } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 同一条记录的在途操作锁：并发请求只放行一个，后到者直接拒绝，以先落库的状态为准。
const inFlightActions = new Set<string>()

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// —— 火情报告 ↔ 扑火队伍 联动 ————————————————————————————————
// 「出动扑救」在火情处置入口落库的同时回写队伍工作台：报告、队伍、待办标记同一次原子写入，
// 任何一步失败整体不生效；出警归属只写一次，历史归属不覆盖、不重复显示。

type LinkedAction = (rows: EntryRow[], index: number, action: string, target: string) => ActionResult

function dispatchFirereport(rows: EntryRow[], index: number, _action: string, target: string): ActionResult {
  const report = rows[index]
  const teamRows = listRows('fireteam')
  const teamIndex = teamRows.findIndex((row) => String(row.status) === '在营待命')
  if (teamIndex < 0) {
    return { ok: false, message: `出动扑救失败：暂无在营待命的扑火队伍，火情报告保持「${String(report.status)}」` }
  }
  const team = teamRows[teamIndex]
  const teamName = String(team['队伍名称'] ?? team['队伍编号'])
  // 保留历史出警归属：已有归属以先落库为准，不覆盖、不重复追加。
  const prior = String(report['出警队伍'] ?? '').trim()
  const nextReport: EntryRow = {
    ...report,
    status: target,
    pending: true,
    abnormal: false,
    出警队伍: prior || teamName,
    扑救情况: prior ? report['扑救情况'] : `已出动：${teamName}`,
  }
  const nextTeam: EntryRow = {
    ...team,
    status: '已出动',
    pending: true,
    出动状态: `已派往${String(report['起火地点'] ?? '火场')}`,
  }
  const nextReports = [...rows]
  nextReports[index] = nextReport
  const nextTeams = [...teamRows]
  nextTeams[teamIndex] = nextTeam
  saveRowsTx({ firereport: nextReports, fireteam: nextTeams })
  return { ok: true, message: `火情报告已出动扑救，当前状态「${target}」，扑火队伍「${teamName}」已出动` }
}

function dismissFirereport(rows: EntryRow[], index: number, action: string, target: string): ActionResult {
  const report = rows[index]
  const nextReport: EntryRow = {
    ...report,
    status: target,
    pending: false,
    abnormal: false,
  }
  const nextReports = [...rows]
  nextReports[index] = nextReport
  // 已出警的报告确认误报：把仍在出动的归属队伍归建回写，队伍工作台与处置入口保持一致；
  // 报告上的出警队伍保留为历史归属，不再清除。
  const attribution = String(report['出警队伍'] ?? '').trim()
  const teamRows = listRows('fireteam')
  const teamIndex = attribution
    ? teamRows.findIndex((row) => String(row['队伍名称']) === attribution && String(row.status) === '已出动')
    : -1
  if (teamIndex < 0) {
    saveRowsTx({ firereport: nextReports })
    return { ok: true, message: `火情报告已${action}，当前状态「${target}」` }
  }
  const nextTeams = [...teamRows]
  nextTeams[teamIndex] = { ...teamRows[teamIndex], status: '在营待命', pending: true, 出动状态: '已归建待命' }
  saveRowsTx({ firereport: nextReports, fireteam: nextTeams })
  return { ok: true, message: `火情报告已${action}，当前状态「${target}」，扑火队伍「${attribution}」已归建待命` }
}

const LINKED_ACTIONS: Record<string, LinkedAction> = {
  'firereport:出动扑救': dispatchFirereport,
  'firereport:确认误报': dismissFirereport,
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const lockKey = `${key}#${id}`
  if (inFlightActions.has(lockKey)) {
    return { ok: false, message: `${meta.entity}编号 ${id} 有正在处理的操作，并发请求只放行一个` }
  }
  inFlightActions.add(lockKey)
  try {
    const rows = listRows(key)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
    }
    const current = String(rows[index].status)
    if (current === target) {
      return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
    }
    // 终态不再接受任何动作：已结案的状态以先落库为准，不能被后续动作覆盖。
    if (meta.terminalStatuses?.includes(current)) {
      return { ok: false, message: `${meta.entity}已结案于「${current}」，终态不再变更，以先落库状态为准` }
    }
    const sources = meta.actionSources?.[action]
    if (sources && !sources.includes(current)) {
      const allowed = sources.map((item) => `「${item}」`).join('')
      return { ok: false, message: `「${action}」只能从${allowed}发起，当前状态「${current}」` }
    }
    const linked = LINKED_ACTIONS[`${key}:${action}`]
    if (linked) {
      return linked(rows, index, action, target)
    }
    const lastStatus = meta.statuses[meta.statuses.length - 1]
    const updated: EntryRow = {
      ...rows[index],
      status: target,
      pending: target !== lastStatus,
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    }
    const next = [...rows]
    next[index] = updated
    saveRowsTx({ [key]: next })
    return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
  } catch (error) {
    // 落库失败：saveRowsTx 整体不生效，报告、队伍与待办标记一起留在旧状态。
    const reason = error instanceof Error ? error.message : '本地存储写入失败'
    return { ok: false, message: `${meta.entity}${action}失败：${reason}，数据未变更` }
  } finally {
    inFlightActions.delete(lockKey)
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
