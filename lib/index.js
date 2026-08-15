/**
 * dsh-premise-guard-cn · 前提守卫 — 中文前提锚点守卫
 *
 * fork of ICCuse/dsh-premise-guard (MIT license, https://github.com/ICCuse/dsh-premise-guard)
 * 为中文小说创作项目定制：
 *   1. 锚点提取增加中文模式：中文引号/书名号/直角引号内短语、顿号与箭头术语链、
 *      W编号、仓内中文相对路径、长中文串；原 ASCII 模式（引号、路径、键值、错误码）保留。
 *   2. 手动锚点清单：<工作区>/.dsh-meow/anchors.md（每行一条；# 开头为注释；"- " 前缀可省）。
 *      清单中的锚点若出现在被压缩区间、却未出现在压缩摘要中，会以【标注】优先报警。
 *   3. premise_anchor 工具（list/add/remove）与 /anchor 命令，供模型与用户维护清单。
 *
 * 行为与上游一致：压缩事件（compaction/summary）后，在下一次非用户消息的 pre-step
 * 注入一条一次性告警，指出摘要丢失的关键锚点，并提示如何从日志读回。
 */

import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import os from 'node:os'

export const name = 'premise-guard-cn'

export const Config = z.object({
  /** 手动锚点清单路径；为空时按 <cwd>/.dsh-meow/anchors.md → $DSH_HOME/anchors.md 回退 */
  anchorsFile: z.string().default(''),
  /** 一次告警最多列出的锚点数 */
  maxAnchors: z.number().default(5),
  /** 自动锚点最短长度 */
  minAnchorLength: z.number().default(4),
  /** 告警文本最大长度 */
  maxNoticeChars: z.number().default(700),
})

const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'premise-guard-cn' }

const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'your', 'what',
  'error', 'failed', 'failure', 'timeout', 'exception', 'command', 'result',
  'output', 'input', 'value', 'status', 'note', 'file', 'path',
])

const CN_STOPWORDS = new Set([
  '的', '了', '是', '我们', '你们', '他们', '这个', '那个', '这些', '那些',
  '一个', '一些', '什么', '怎么', '没有', '可以', '但是', '因为', '所以',
  '如果', '然后', '已经', '项目', '文件', '内容', '时候', '问题', '情况',
  '可能', '真的', '主要', '相关', '目前', '包括', '通过', '根据', '关于',
  '其中', '应该', '需要', '现在', '之后', '之前', '还是', '只是', '这样',
  '那样', '进行', '以及', '或者', '不能', '不要', '不会', '等等', '一下',
])

// ── 锚点提取 ──────────────────────────────────────────────────────────────

/** 上游原版 ASCII 模式 */
const ASCII_PATTERNS = [
  /(["'`])([^"'`\n]{4,80})\1/g,
  /(?:[A-Za-z]:[\\/]|(?:\/|\.{1,2}[\\/]))[\w.\\/()-]+\.\w{1,5}/g,
  /\b[\w.-]{2,40}\s*[=:]\s*[\w./:%-]{1,60}/g,
  /\b(?:[A-Z][A-Z0-9_]{3,}|[\w-]*[Ee]rror[\w-]*|[\w-]*(?:exception|failed|timeout)[\w-]*)\b/g,
  /\b[\w-]{2,40}\.[\w.-]{2,40}\b/g,
]

/** 中文定制模式 */
const CN_PATTERNS = [
  /[“]([^“”\n]{4,60})[”]/g,
  /[「]([^「」\n]{4,60})[」]/g,
  /[《]([^《》\n]{4,60})[》]/g,
  /[『]([^『』\n]{4,60})[』]/g,
  // 顿号/箭头术语链：筑基、结丹、元婴；炼体→炼气→炼神
  /[\u4e00-\u9fff·]{1,30}(?:[、→][\u4e00-\u9fff·]{1,30})+/g,
  // 字母+数字编号锚点（如 W12、A07、P3）
  /\b[A-Z]\d{2,3}\b/g,
  // 仓内中文相对路径
  /[\u4e00-\u9fff][\u4e00-\u9fff\w./\\·\-_（）()]{3,}\.(?:md|yaml|yml|txt|json)/g,
  // 数字与数量（12章、300—500里）
  /\d{2,6}(?:[—～~-]\d{2,6})?[\u4e00-\u9fff]{0,12}/g,
  // 长中文串
  /[\u4e00-\u9fff]{12,}/g,
]

function distinctive(anchor) {
  if (STOPWORDS.has(anchor.toLowerCase()) || CN_STOPWORDS.has(anchor)) return false
  const cjk = (anchor.match(/[\u4e00-\u9fff]/g) || []).length
  if (cjk >= 4) return true
  if (/[、→]/.test(anchor) && cjk >= 2) return true
  return /[0-9./\\_=:%-]/.test(anchor) || anchor.length >= 12
}

export function extractAnchors(text, minLength) {
  const seen = new Set()
  const anchors = []
  for (const pattern of [...CN_PATTERNS, ...ASCII_PATTERNS]) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1] ?? match[0]
      const anchor = raw.trim()
      if (anchor.length < minLength || !distinctive(anchor)) continue
      if (seen.has(anchor)) continue
      seen.add(anchor)
      anchors.push(anchor)
    }
  }
  return anchors.sort((a, b) => b.length - a.length)
}

// ── 手动锚点清单 ──────────────────────────────────────────────────────────

function resolveAnchorsFile(config, session) {
  if (config.anchorsFile && config.anchorsFile.length > 0) return config.anchorsFile
  const cwd = session?.header?.cwd
  if (cwd) {
    const workspaceFile = join(cwd, '.dsh-meow', 'anchors.md')
    if (existsSync(workspaceFile)) return workspaceFile
  }
  const home = process.env.DSH_HOME || join(os.homedir(), '.dsh')
  return join(home, 'anchors.md')
}

/** 每行一条；# 开头为注释；去掉可选 "- " 前缀与首尾空白。 */
export function loadRegistry(path) {
  try {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*-\s+/, '').trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  } catch {
    return []
  }
}

const ANCHORS_FILE_HEADER = [
  '# 关键前提锚点清单（premise-guard-cn 手动标注入口）',
  '#',
  '# 用法：每行一条关键前提短语；# 开头为注释；行首 "- " 可省。',
  '# 插件在上下文压缩时检查：被压缩区间里出现过、但压缩摘要里消失的标注锚点，会优先报警。',
  '# 增删行后下一次压缩立即生效；本文件只作工具清单，不替代正式笔记。',
  '',
].join('\n')

// ── 插件主体 ──────────────────────────────────────────────────────────────

function validateInt(label, value, fallback) {
  const resolved = value === undefined ? fallback : value
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`premise-guard-cn: invalid ${label} ${resolved} — must be an integer >= 1`)
  }
  return resolved
}

export function apply(ctx, config) {
  const resolved = config || {}
  const maxAnchors = validateInt('maxAnchors', resolved.maxAnchors, 5)
  const minAnchorLength = validateInt('minAnchorLength', resolved.minAnchorLength, 4)
  const maxNoticeChars = validateInt('maxNoticeChars', resolved.maxNoticeChars, 700)

  const pending = new Map()

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/summary') return
    try {
      const shadowedSeqs = event.data?.shadowedSeqs ?? []
      const shadowedText = shadowedSeqs
        .map((seq) => session.deriveEventMessage(session.events[seq]))
        .filter((message) => message !== null)
        .map((message) => message.content
          .filter((block) => block !== null && typeof block === 'object'
            && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n'))
        .join('\n')
      const summaryText = (event.data?.summary ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')

      const registry = loadRegistry(resolveAnchorsFile(resolved, session))
      const registryHit = registry.filter((anchor) => shadowedText.includes(anchor))
      const auto = extractAnchors(shadowedText, minAnchorLength)

      const registryLost = registryHit.filter((anchor) => !summaryText.includes(anchor))
      const autoLost = auto.filter((anchor) => !summaryText.includes(anchor))
      const lost = [...registryLost, ...autoLost].slice(0, maxAnchors)
      if (lost.length === 0) return

      const range = event.data?.shadowedRange
        ? `${event.data.shadowedRange.start}-${event.data.shadowedRange.end}`
        : ''
      pending.set(session.id, {
        anchors: lost,
        marked: new Set(registryLost),
        range,
      })
    } catch (error) {
      ctx.logger?.warn?.(`premise-guard-cn: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    if (messages.some((message) => message.source.kind === 'user')) return next()
    const alarm = pending.get(agent.id)
    if (alarm === undefined) return next()
    pending.delete(agent.id)

    const anchorLines = alarm.anchors
      .map((anchor) => (alarm.marked.has(anchor) ? `- 【标注】${anchor}` : `- ${anchor}`))
      .join('\n')
    let text = '⚠️ 前提告警【前提守卫 premise-guard-cn】：刚才的上下文压缩'
      + (alarm.range ? `（seqs ${alarm.range}）` : '')
      + '生成的摘要丢失了以下关键锚点：\n' + anchorLines + '\n'
      + '若这些前提仍然重要，用 session 事件工具从日志读回被压缩区间核对；'
      + '若摘要已用等价表述保留，或前提已不再影响当前工作，忽略本提醒。'
    if (text.length > maxNoticeChars) {
      text = text.slice(0, maxNoticeChars) + '…'
    }

    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    return {
      kind: 'enter',
      messages: [
        ...downstream.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'premise-drift alarm' },
        }),
      ],
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    pending.delete(agent.id)
  })

  // ── premise_anchor 工具 / /anchor 命令 ─────────────────────────────────
  const tools = ctx.get('tools')
  if (tools !== undefined) {
    ctx.effect(() => tools.register({
      name: 'premise_anchor',
      description: '维护“关键前提锚点清单”（.dsh-meow/anchors.md，每行一条；# 为注释）。压缩摘要丢失清单里的锚点时插件会报警。action: list=列出清单与路径；add=追加一条（content 为一条短语，可含多行）；remove=删除包含 content 子串的行。仅在用户明确要求标注/取消某个前提时调用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove'] },
          content: { type: 'string', description: 'add: 要标注的前提短语；remove: 要删除行的子串' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            path: { type: 'string' },
            entries: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.ok
            ? (value.entries && value.entries.length > 0
              ? `${value.message}\n\n${value.entries.map((e) => `- ${e}`).join('\n')}`
              : value.message)
            : value.message,
        }],
      },
      execute: async (args, exec) => {
        const action = String(args.action ?? '')
        const content = typeof args.content === 'string' ? args.content.trim() : ''
        const session = exec.agent?.session
        const file = resolveAnchorsFile(resolved, session)
        if (action === 'list') {
          const entries = loadRegistry(file)
          return {
            ok: true,
            path: file,
            message: entries.length > 0
              ? `锚点清单（${file}）共 ${entries.length} 条：`
              : `锚点清单（${file}）当前为空。`,
            entries,
          }
        }
        if (action === 'add') {
          if (!content) return { ok: false, message: 'premise_anchor add 需要 content（一条前提短语）' }
          if (!existsSync(file)) {
            mkdirSync(dirname(file), { recursive: true })
            writeFileSync(file, ANCHORS_FILE_HEADER, 'utf8')
          }
          const existing = new Set(loadRegistry(file))
          const lines = content
            .split(/\r?\n/)
            .map((line) => line.replace(/^\s*-\s+/, '').trim())
            .filter((line) => line.length > 0 && !line.startsWith('#'))
          const added = []
          for (const line of lines) {
            if (existing.has(line)) continue
            existing.add(line)
            added.push(line)
          }
          if (added.length === 0) return { ok: true, message: 'premise_anchor: 这些锚点已存在，未改动。', path: file }
          appendFileSync(file, added.map((line) => `- ${line}\n`).join(''), 'utf8')
          return { ok: true, message: `premise_anchor: 已标注 ${added.length} 条锚点，写入 ${file}`, path: file }
        }
        if (action === 'remove') {
          if (!content) return { ok: false, message: 'premise_anchor remove 需要 content（要删除行的子串）' }
          const entries = loadRegistry(file)
          const kept = entries.filter((line) => !line.includes(content))
          const removed = entries.length - kept.length
          if (removed === 0) return { ok: false, message: `premise_anchor: 清单中没有包含“${content}”的行` }
          writeFileSync(file, ANCHORS_FILE_HEADER + kept.map((line) => `- ${line}\n`).join(''), 'utf8')
          return { ok: true, message: `premise_anchor: 已移除 ${removed} 条`, path: file }
        }
        return { ok: false, message: `premise_anchor: 未知 action ${action}` }
      },
    }), 'premise-guard-cn: tool')

    const commands = ctx.get('commands')
    if (commands !== undefined) {
      ctx.effect(() => commands.register({
        name: 'anchor',
        description: '查看或维护关键前提锚点清单（list/add/remove）',
        handler: async (args) => {
          // 命令无法取得会话 cwd，操作默认清单；工作区清单请用 premise_anchor 工具或直接编辑 .dsh-meow/anchors.md
          const home = process.env.DSH_HOME || join(os.homedir(), '.dsh')
          const file = resolved.anchorsFile && resolved.anchorsFile.length > 0
            ? resolved.anchorsFile
            : join(home, 'anchors.md')
          const parts = typeof args === 'string' ? args.trim().split(/\s+/) : []
          const action = parts[0] || 'list'
          const content = parts.slice(1).join(' ')
          if (action === 'list') {
            const entries = loadRegistry(file)
            return {
              kind: 'success',
              text: entries.length > 0
                ? `${file} 共 ${entries.length} 条：\n${entries.map((e) => `- ${e}`).join('\n')}`
                : `${file} 当前为空（工作区清单用 premise_anchor 工具维护）`,
            }
          }
          if (action === 'add' && content) {
            if (!existsSync(file)) {
              mkdirSync(dirname(file), { recursive: true })
              writeFileSync(file, ANCHORS_FILE_HEADER, 'utf8')
            }
            const existing = new Set(loadRegistry(file))
            if (existing.has(content)) return { kind: 'success', text: '锚点已存在' }
            appendFileSync(file, `- ${content}\n`, 'utf8')
            return { kind: 'success', text: `已标注：${content}` }
          }
          if (action === 'remove' && content) {
            const entries = loadRegistry(file)
            const kept = entries.filter((line) => !line.includes(content))
            writeFileSync(file, ANCHORS_FILE_HEADER + kept.map((line) => `- ${line}\n`).join(''), 'utf8')
            return { kind: 'success', text: `已移除 ${entries.length - kept.length} 条` }
          }
          return { kind: 'error', text: '用法：/anchor list | /anchor add <短语> | /anchor remove <子串>（工作区清单用 premise_anchor 工具）' }
        },
      }), 'premise-guard-cn: command')
    }
  }
}
