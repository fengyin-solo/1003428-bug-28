/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type StateMachine = {
  /** 每个动作允许的来源状态；不在列表里的状态（含终态）一律拒绝 */
  transitions: Record<string, string[]>
  /** 终态：一旦落库不再接受任何动作，冲突时以先落库的终态为准 */
  terminalStatuses: string[]
  /** 这些状态不算待办（pending=false） */
  settledStatuses: string[]
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  stateMachine?: StateMachine
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
