import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { addAnchors, loadRegistry, removeAnchorExactly, resolveAnchorsFile } from './registry.js'

export const name = 'premise-guard-cn'

export const Config = z.object({
  /** Explicit file wins; otherwise a project-specific registry is stored outside the workspace. */
  anchorsFile: z.string().default(''),
  /** External root for automatic per-workspace registries. */
  anchorsStoreDir: z.string().default(''),
  /** Model-facing tools stay read-only unless the human enables this explicitly. */
  allowAnchorEdits: z.boolean().default(false),
  maxAnchors: z.number().default(5),
  minAnchorLength: z.number().default(4),
  maxNoticeChars: z.number().default(700),
})

const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'premise-guard-cn' }
const STOPWORDS = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'have', 'your', 'what', 'error', 'failed', 'failure', 'timeout', 'exception', 'command', 'result', 'output', 'input', 'value', 'status', 'note', 'file', 'path'])
const CN_STOPWORDS = new Set(['的', '了', '是', '我们', '你们', '他们', '这个', '那个', '这些', '那些', '一个', '一些', '什么', '怎么', '没有', '可以', '但是', '因为', '所以', '如果', '然后', '已经', '项目', '文件', '内容', '时候', '问题', '情况', '可能', '真的', '主要', '相关', '目前', '包括', '通过', '根据', '关于', '其中', '应该', '需要', '现在', '之后', '之前', '还是', '只是', '这样', '那样', '进行', '以及', '或者', '不能', '不要', '不会', '等等', '一下'])
const PATTERNS = [
  /[“]([^“”\n]{4,60})[”]/g, /[「]([^「」\n]{4,60})[」]/g, /[《]([^《》\n]{4,60})[》]/g, /[『]([^『』\n]{4,60})[』]/g,
  /[\u4e00-\u9fff·]{1,30}(?:[、→][\u4e00-\u9fff·]{1,30})+/g, /\b[A-Z]\d{2,3}\b/g,
  /[\u4e00-\u9fff][\u4e00-\u9fff\w./\\·\-_（）()]{3,}\.(?:md|yaml|yml|txt|json)/g, /\d{2,6}(?:[—～~-]\d{2,6})?[\u4e00-\u9fff]{0,12}/g,
  /[\u4e00-\u9fff]{12,}/g, /(["'`])([^"'`\n]{4,80})\1/g, /(?:[A-Za-z]:[\\/]|(?:\/|\.{1,2}[\\/]))[\w.\\/()-]+\.\w{1,5}/g,
  /\b[\w.-]{2,40}\s*[=:]\s*[\w./:%-]{1,60}/g, /\b(?:[A-Z][A-Z0-9_]{3,}|[\w-]*[Ee]rror[\w-]*|[\w-]*(?:exception|failed|timeout)[\w-]*)\b/g,
  /\b[\w-]{2,40}\.[\w.-]{2,40}\b/g,
]

function distinctive(anchor) {
  if (STOPWORDS.has(anchor.toLowerCase()) || CN_STOPWORDS.has(anchor)) return false
  const cjk = (anchor.match(/[\u4e00-\u9fff]/g) || []).length
  return cjk >= 4 || (/[、→]/.test(anchor) && cjk >= 2) || /[0-9./\\_=:%-]/.test(anchor) || anchor.length >= 12
}

export function extractAnchors(text, minLength) {
  const seen = new Set(); const anchors = []
  for (const pattern of PATTERNS) for (const match of String(text).matchAll(pattern)) {
    const anchor = String(match[1] ?? match[0]).trim().normalize('NFC')
    if (anchor.length >= minLength && distinctive(anchor) && !seen.has(anchor)) { seen.add(anchor); anchors.push(anchor) }
  }
  return anchors.sort((a, b) => b.length - a.length)
}

function validateInt(label, value, fallback) {
  const actual = value === undefined ? fallback : value
  if (!Number.isInteger(actual) || actual < 1) throw new Error(`premise-guard-cn: invalid ${label} ${actual} — must be an integer >= 1`)
  return actual
}

function editDisabled(file) {
  return { ok: false, path: file, message: 'premise_anchor: 锚点编辑默认关闭。只有用户在插件配置中显式设置 allowAnchorEdits: true 后，add/remove 才能写入；当前未改动任何文件。' }
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
      const shadowed = (event.data?.shadowedSeqs ?? []).map((seq) => session.deriveEventMessage(session.events[seq])).filter(Boolean).map((message) => message.content.filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')).join('\n')
      const summary = (event.data?.summary ?? []).filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
      const registry = loadRegistry(resolveAnchorsFile(resolved, session))
      const markedLost = registry.filter((anchor) => shadowed.includes(anchor) && !summary.includes(anchor))
      const automatic = extractAnchors(shadowed, minAnchorLength).filter((anchor) => !summary.includes(anchor) && !markedLost.includes(anchor))
      const anchors = [...markedLost, ...automatic].slice(0, maxAnchors)
      if (anchors.length) pending.set(session.id, { anchors, marked: new Set(markedLost), range: event.data?.shadowedRange })
    } catch (error) { ctx.logger?.warn?.(`premise-guard-cn: ${error instanceof Error ? error.message : String(error)}`) }
  })
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    if (messages.some((message) => message.source.kind === 'user')) return next()
    const alarm = pending.get(agent.id); if (!alarm) return next(); pending.delete(agent.id)
    const items = alarm.anchors.map((anchor) => `- ${alarm.marked.has(anchor) ? '【标注】' : ''}${anchor}`).join('\n')
    let text = `⚠️ 前提告警【前提守卫 premise-guard-cn】：刚才的上下文压缩${alarm.range ? `（seqs ${alarm.range.start}-${alarm.range.end}）` : ''}生成的摘要可能丢失：\n${items}\n请按需从会话日志或正式笔记核对；等价表述已保留或前提已失效时可忽略。`
    if (text.length > maxNoticeChars) text = `${text.slice(0, maxNoticeChars)}…`
    const downstream = await next(); if (downstream.kind !== 'enter') return downstream
    return { kind: 'enter', messages: [...downstream.messages, createUserMessage({ content: [{ type: 'text', text }], source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'premise-drift alarm' } })] }
  })
  ctx.on('agent/disposed', ({ agent }) => pending.delete(agent.id))
  const tools = ctx.get('tools')
  if (tools) ctx.effect(() => tools.register({
    name: 'premise_anchor', description: '查看关键前提锚点清单。add/remove 默认关闭，只有用户明确启用 allowAnchorEdits 后才可写入；remove 必须传入完整、精确的锚点。',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: ['list', 'add', 'remove'] }, content: { type: 'string', description: 'add: 短语；remove: 完整锚点（精确匹配）' } } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, message: { type: 'string' }, path: { type: 'string' }, entries: { type: 'array', items: { type: 'string' } } } }, render: (_args, value) => [{ type: 'text', text: value.entries?.length ? `${value.message}\n\n${value.entries.map((entry) => `- ${entry}`).join('\n')}` : value.message }] },
    execute: async (args, exec) => {
      const file = resolveAnchorsFile(resolved, exec.agent?.session); const action = String(args.action ?? ''); const content = String(args.content ?? '').trim()
      if (action === 'list') { const entries = loadRegistry(file); return { ok: true, path: file, entries, message: entries.length ? `锚点清单（${file}）共 ${entries.length} 条：` : `锚点清单（${file}）为空；尚未写入文件。` } }
      if (!resolved.allowAnchorEdits) return editDisabled(file)
      if (action === 'add') { if (!content) return { ok: false, path: file, message: 'premise_anchor add 需要 content。' }; const added = addAnchors(file, content); return { ok: true, path: file, message: added.length ? `已精确新增 ${added.length} 条锚点；原文件已备份为 ${file}.bak。` : '这些锚点已存在，未改动。' } }
      if (action === 'remove') { if (!content) return { ok: false, path: file, message: 'premise_anchor remove 需要完整锚点 content。' }; const result = removeAnchorExactly(file, content); return result.removed ? { ok: true, path: file, message: `已精确移除 1 条锚点；原文件已备份为 ${file}.bak。` } : { ok: false, path: file, message: '未找到完全相同的锚点，未改动。' } }
      return { ok: false, path: file, message: `premise_anchor: 未知 action ${action}` }
    },
  }), 'premise-guard-cn: tool')
  const commands = ctx.get('commands')
  if (commands) ctx.effect(() => commands.register({
    name: 'anchor',
    description: '查看前提锚点；写操作须由用户在配置中显式启用 allowAnchorEdits。',
    handler: async (args) => {
      const file = resolveAnchorsFile(resolved)
      const [action = 'list', ...rest] = String(args ?? '').trim().split(/\s+/)
      const content = rest.join(' ').trim()
      if (action === 'list') {
        const entries = loadRegistry(file)
        return { kind: 'success', text: entries.length ? `${file} 共 ${entries.length} 条：\n${entries.map((entry) => `- ${entry}`).join('\n')}` : `${file} 为空；尚未写入文件。` }
      }
      if (!resolved.allowAnchorEdits) return { kind: 'error', text: '锚点编辑默认关闭：请由用户先在配置中设置 allowAnchorEdits: true；本次未改动文件。' }
      if (action === 'add' && content) {
        const added = addAnchors(file, content)
        return { kind: 'success', text: added.length ? `已新增 ${added.length} 条；原文件已备份为 ${file}.bak。` : '锚点已存在，未改动。' }
      }
      if (action === 'remove' && content) {
        const result = removeAnchorExactly(file, content)
        return result.removed ? { kind: 'success', text: `已精确移除 1 条；原文件已备份为 ${file}.bak。` } : { kind: 'error', text: '未找到完全相同的锚点，未改动。' }
      }
      return { kind: 'error', text: '用法：/anchor list | /anchor add <短语> | /anchor remove <完整锚点>' }
    },
  }), 'premise-guard-cn: command')
}
