<template>
  <section class="page" data-module="firereport">
    <header class="page-head">
      <div>
        <h2>火情报告管理</h2>
        <p class="page-desc">维护火情报告，围绕报告编号、起火地点、起火时间、火势等级做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记火情报告</button>
        <button class="btn" type="button" @click="exportRows">导出火情报告清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无火情报告数据，可先登记火情报告</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条火情报告记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="dispatch-panel">
      <h3>出警记录</h3>
      <p class="page-desc">出动扑救自动登记出警记录并回写扑火队伍状态；改判误报会撤回队伍，历史出警归属保留。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>报告编号</th>
            <th>出动队伍</th>
            <th>出动时间</th>
            <th>撤回时间</th>
            <th>记录状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in dispatches" :key="String(record.id)">
            <td>{{ record['报告编号'] }}</td>
            <td>{{ record['队伍名称'] }}（{{ record['队伍编号'] }}）</td>
            <td>{{ formatTime(record['出动时间']) }}</td>
            <td>{{ record['撤回时间'] ? formatTime(record['撤回时间']) : '—' }}</td>
            <td>{{ record.status }}</td>
          </tr>
          <tr v-if="!dispatches.length">
            <td colspan="5" class="empty-state">暂无出警记录，确认火情后可出动扑救</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listDispatches,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('firereport')
const columns = ["报告编号", "起火地点", "起火时间", "火势等级", "过火面积", "扑救情况", "报告人", "报告状态"]
const actions = ["核实火情", "出动扑救", "确认误报"]
const statuses = ["待核实", "已确认", "已出警", "已扑灭", "误报"]
const stats = [{"label": "今日报告数", "value": 0}, {"label": "已确认火情", "value": 0}, {"label": "扑救中火情", "value": 0}]

const rows = ref<EntryRow[]>([])
const dispatches = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function formatTime(value: unknown): string {
  const text = String(value ?? '')
  return text ? text.replace('T', ' ').slice(0, 19) : '—'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '火情报告登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  // 失败也要刷新：并发或终态冲突时，把先落库的状态原样呈现出来。
  reload()
  errorMessage.value = result.ok ? '' : result.message
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    dispatches.value = listDispatches()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '火情报告列表读取失败'
  }
}

onMounted(reload)
</script>
