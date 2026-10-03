import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, refreshRows, resetRows, restoreRows, saveModules, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 火情报告 ↔ 扑火队伍联动用的固定键与状态。
const FIREREPORT_KEY = 'firereport'
const FIRETEAM_KEY = 'fireteam'
// 出警记录存在同一份存储里的伪模块下：和报告、队伍一起一次落库，不会写出半截。
const DISPATCH_KEY = 'firereport_dispatch'
const TEAM_READY = '在营待命'
const TEAM_DISPATCHED = '已出动'
const TEAM_RECALLED = '已撤回'
const DISPATCH_ACTIVE = '出警中'
const DISPATCH_RECALLED = '已撤回'

// 同一报告的流转请求只放行一个；同步执行下主要防重入，跨标签页靠 refreshRows 的并发校验兜底。
const inflightActions = new Set<string>()

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

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === FIREREPORT_KEY && meta.stateMachine) {
    return runFirereportAction(meta, id, action, target)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
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
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 火情报告的流转走独立链路：状态机校验 → 队伍回写 → 出警记录，三步在同一同步块里
// 「重读-校验-一次落库」，并发请求只放行一个状态，冲突时以先落库状态为准；
// 任何一步失败都把报告、队伍、待办（pending）一起恢复到动作前的快照。
function runFirereportAction(
  meta: ModuleMeta,
  id: number,
  action: string,
  target: string,
): ActionResult {
  const machine = meta.stateMachine
  if (!machine) {
    return { ok: false, message: '火情报告没有登记状态机，拒绝流转' }
  }
  const lockKey = `${FIREREPORT_KEY}:${id}`
  if (inflightActions.has(lockKey)) {
    return { ok: false, message: '该火情报告有正在处理的流转请求，并发请求只放行一个' }
  }
  inflightActions.add(lockKey)
  // 动作前的整份快照：既是并发校验的基准，也是失败回滚的还原点。
  const snapshot = refreshRows()
  try {
    const reports = snapshot[FIREREPORT_KEY] ?? []
    const reportIndex = reports.findIndex((row) => Number(row.id) === id)
    if (reportIndex < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
    }
    const report = reports[reportIndex]
    const current = String(report.status)
    // 终态优先级最高：已扑灭/误报一旦落库，后续任何动作都为时已晚。
    if (machine.terminalStatuses.includes(current)) {
      return {
        ok: false,
        message: `${meta.entity}已处于终态「${current}」，以先落库状态为准，「${action}」被拒绝`,
      }
    }
    const sources = machine.transitions[action] ?? []
    if (!sources.includes(current)) {
      return {
        ok: false,
        message: `${meta.entity}当前状态「${current}」，不能执行「${action}」（可从 ${sources.join('、')} 流转）`,
      }
    }

    const teams = snapshot[FIRETEAM_KEY] ?? []
    const dispatches = snapshot[DISPATCH_KEY] ?? []
    const nextReport: EntryRow = {
      ...report,
      status: target,
      pending: !machine.settledStatuses.includes(target),
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    }
    let nextTeams = teams
    let nextDispatches = dispatches
    let message = `${meta.entity}已${action}，当前状态「${target}」`

    if (action === '出动扑救') {
      // 同一报告只允许一条出警中记录：旧出警记录保留归属，不重复登记。
      const duplicated = dispatches.some(
        (record) => Number(record.reportId) === id && record.status === DISPATCH_ACTIVE,
      )
      if (duplicated) {
        return { ok: false, message: '该报告已有出警中的队伍，出警记录不重复登记' }
      }
      const teamIndex = teams.findIndex((row) => String(row.status) === TEAM_READY)
      if (teamIndex < 0) {
        return { ok: false, message: '没有「在营待命」的扑火队伍，出动扑救失败，报告与队伍状态均未改动' }
      }
      const team = teams[teamIndex]
      nextTeams = [...teams]
      nextTeams[teamIndex] = { ...team, status: TEAM_DISPATCHED, pending: true, abnormal: false }
      const dispatchId = dispatches.reduce((max, record) => Math.max(max, Number(record.id) || 0), 0) + 1
      nextDispatches = [
        ...dispatches,
        {
          id: dispatchId,
          status: DISPATCH_ACTIVE,
          pending: true,
          abnormal: false,
          reportId: id,
          teamId: Number(team.id),
          报告编号: String(report['报告编号'] ?? ''),
          队伍编号: String(team['队伍编号'] ?? ''),
          队伍名称: String(team['队伍名称'] ?? ''),
          出动时间: new Date().toISOString(),
          撤回时间: '',
        },
      ]
      message = `${meta.entity}已出动扑救，队伍「${String(team['队伍名称'] ?? team['队伍编号'])}」已出动`
    }

    if (action === '确认误报') {
      // 已出警的报告改判误报：队伍撤回，出警记录标记已撤回但保留历史出警归属。
      const activeIndex = dispatches.findIndex(
        (record) => Number(record.reportId) === id && record.status === DISPATCH_ACTIVE,
      )
      if (activeIndex >= 0) {
        const dispatch = dispatches[activeIndex]
        nextDispatches = [...dispatches]
        nextDispatches[activeIndex] = {
          ...dispatch,
          status: DISPATCH_RECALLED,
          pending: false,
          撤回时间: new Date().toISOString(),
        }
        const teamIndex = teams.findIndex((row) => Number(row.id) === Number(dispatch.teamId))
        if (teamIndex >= 0 && String(teams[teamIndex].status) === TEAM_DISPATCHED) {
          nextTeams = [...teams]
          nextTeams[teamIndex] = { ...teams[teamIndex], status: TEAM_RECALLED, pending: true, abnormal: false }
        }
        message = `${meta.entity}已确认误报，队伍「${String(dispatch['队伍名称'] ?? dispatch['队伍编号'])}」已撤回，出警记录保留`
      }
    }

    const nextReports = [...reports]
    nextReports[reportIndex] = nextReport
    saveModules({
      [FIREREPORT_KEY]: nextReports,
      [FIRETEAM_KEY]: nextTeams,
      [DISPATCH_KEY]: nextDispatches,
    })
    return { ok: true, message }
  } catch (error) {
    restoreRows(snapshot)
    return {
      ok: false,
      message: `${meta.entity}流转失败，报告、队伍与待办已一并恢复：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    inflightActions.delete(lockKey)
  }
}

// 出警记录：新的在前，历史归属完整保留；可按报告编号过滤。
export function listDispatches(reportId?: number): EntryRow[] {
  const rows = listRows(DISPATCH_KEY)
  const matched =
    reportId == null ? rows : rows.filter((row) => Number(row.reportId) === Number(reportId))
  return [...matched].sort((a, b) => Number(b.id) - Number(a.id))
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
