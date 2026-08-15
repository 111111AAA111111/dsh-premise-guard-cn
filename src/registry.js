import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import os from 'node:os'

export const ANCHORS_FILE_HEADER = [
  '# 关键前提锚点清单（premise-guard-cn 手动标注入口）',
  '#',
  '# 每行一条关键前提；# 开头为注释；行首 "- " 可省。',
  '# 本文件是工具清单，不替代正式笔记或来源裁定。',
  '',
].join('\n')

export function normalizeAnchor(value) {
  return String(value ?? '').replace(/^\s*-\s+/, '').trim().normalize('NFC')
}

export function parseRegistry(text) {
  const seen = new Set()
  const values = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const value = normalizeAnchor(raw)
    if (!value || value.startsWith('#') || seen.has(value)) continue
    seen.add(value)
    values.push(value)
  }
  return values
}

export function loadRegistry(file) {
  try {
    return existsSync(file) ? parseRegistry(readFileSync(file, 'utf8')) : []
  } catch {
    return []
  }
}

function workspaceKey(cwd) {
  return createHash('sha256').update(resolve(cwd).toLocaleLowerCase('en-US')).digest('hex').slice(0, 16)
}

/**
 * Never creates a file inside the workspace.  Each workspace gets an opaque
 * hash-named registry below DSH_PREMISE_GUARD_HOME (or ~/.dsh/premise-guard-cn).
 */
export function resolveAnchorsFile(config, session) {
  const specified = String(config?.anchorsFile ?? '').trim()
  if (specified) return specified
  const configuredRoot = String(config?.anchorsStoreDir ?? '').trim()
  const root = configuredRoot || process.env.DSH_PREMISE_GUARD_HOME
    || join(os.homedir(), '.dsh', 'premise-guard-cn')
  const cwd = session?.header?.cwd
  return cwd ? join(root, 'workspaces', workspaceKey(cwd), 'anchors.md') : join(root, 'global', 'anchors.md')
}

export function writeRegistryAtomic(file, entries) {
  const content = ANCHORS_FILE_HEADER + entries.map((entry) => `- ${entry}\n`).join('')
  const parent = dirname(file)
  mkdirSync(parent, { recursive: true })
  if (existsSync(file)) copyFileSync(file, `${file}.bak`)
  const temporary = join(parent, `.anchors.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(temporary, content, 'utf8')
  renameSync(temporary, file)
}

export function addAnchors(file, content) {
  const current = loadRegistry(file)
  const known = new Set(current)
  const added = parseRegistry(content).filter((entry) => !known.has(entry))
  if (added.length) writeRegistryAtomic(file, [...current, ...added])
  return added
}

export function removeAnchorExactly(file, content) {
  const wanted = normalizeAnchor(content)
  const current = loadRegistry(file)
  if (!wanted || !current.includes(wanted)) return { removed: false, entries: current }
  const entries = current.filter((entry) => entry !== wanted)
  writeRegistryAtomic(file, entries)
  return { removed: true, entries }
}
