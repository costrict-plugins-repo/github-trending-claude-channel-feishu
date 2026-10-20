import { randomBytes } from 'crypto'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  renameSync,
  realpathSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, relative, resolve } from 'path'

export const STATE_DIR =
  process.env.FEISHU_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'feishu')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const INBOX_DIR = join(STATE_DIR, 'inbox')

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

export function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write(
      'feishu channel: access.json is corrupt, moved aside. Starting fresh.\n',
    )
    return defaultAccess()
  }
}

const STATIC = process.env.FEISHU_ACCESS_MODE === 'static'

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write(
          'feishu channel: static mode — dmPolicy "pairing" downgraded to "allowlist"\n',
        )
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

export function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

export function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

export function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

/**
 * Gate an inbound message. For Feishu, chat_type is either 'p2p' (DM) or 'group'.
 */
export function gate(
  senderId: string,
  chatId: string,
  chatType: string,
): GateResult {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  if (chatType === 'p2p') {
    if (access.allowFrom.includes(senderId) || access.allowFrom.includes(chatId)) {
      return { action: 'deliver', access }
    }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId,
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group') {
    const policy = access.groups[chatId]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
      return { action: 'drop' }
    }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

export function assertAllowedChat(chat_id: string): void {
  const access = loadAccess()
  // allowFrom may hold sender open_id (ou_...) and/or p2p chat_id (oc_...) after pairing
  if (access.allowFrom.includes(chat_id)) return
  if (chat_id in access.groups) return
  throw new Error(`chat ${chat_id} is not allowlisted`)
}

export type PairResult =
  | { ok: true; senderId: string; chatId: string }
  | { ok: false; error: string }

/** Feishu user open_id for safe use as a single path segment (e.g. under approved/). */
const FEISHU_USER_OPEN_ID_RE = /^ou_[0-9a-zA-Z]+$/

export function isSafeFeishuUserOpenId(id: string): boolean {
  return FEISHU_USER_OPEN_ID_RE.test(id)
}

/** Approve a DM pairing code from pending; updates allowFrom and queues Feishu confirm. */
export function pairByCode(code: string): PairResult {
  if (STATIC) return { ok: false, error: 'pairing disabled in FEISHU_ACCESS_MODE=static' }
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)

  const entry = access.pending[code]
  if (!entry) {
    return {
      ok: false,
      error: `unknown or expired pairing code: ${code}`,
    }
  }

  if (!isSafeFeishuUserOpenId(entry.senderId)) {
    return {
      ok: false,
      error:
        'pairing entry has invalid senderId (expected Feishu user open_id ou_…); fix access.json or re-pair',
    }
  }

  if (!access.allowFrom.includes(entry.senderId)) {
    access.allowFrom.push(entry.senderId)
  }
  if (!access.allowFrom.includes(entry.chatId)) {
    access.allowFrom.push(entry.chatId)
  }
  delete access.pending[code]
  saveAccess(access)

  mkdirSync(APPROVED_DIR, { recursive: true })
  writeFileSync(join(APPROVED_DIR, entry.senderId), `${entry.chatId}\n`, {
    mode: 0o600,
  })

  return { ok: true, senderId: entry.senderId, chatId: entry.chatId }
}

export function checkApprovals(
  sendConfirm: (chatId: string) => Promise<void>,
): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch {
    return
  }
  if (files.length === 0) return

  for (const senderId of files) {
    if (!isSafeFeishuUserOpenId(senderId)) {
      process.stderr.write(
        `feishu channel: skipping invalid approval queue filename: ${senderId}\n`,
      )
      continue
    }
    const file = join(APPROVED_DIR, senderId)
    const access = loadAccess()
    let chatId: string
    try {
      const raw = readFileSync(file, 'utf8').trim()
      const first = raw.split('\n')[0] ?? ''
      chatId =
        first.startsWith('oc_')
          ? first
          : (() => {
              const pending = Object.entries(access.pending).find(
                ([, p]) => p.senderId === senderId,
              )
              return pending ? pending[1].chatId : senderId
            })()
    } catch {
      continue
    }
    void sendConfirm(chatId).then(
      () => rmSync(file, { force: true }),
      (err) => {
        process.stderr.write(
          `feishu channel: failed to send approval confirm: ${err}\n`,
        )
        rmSync(file, { force: true })
      },
    )
  }
}

/** Ensures a download/write target stays under the real inbox dir (file may not exist yet). */
export function assertSendable(f: string): void {
  let inboxReal: string
  try {
    inboxReal = realpathSync(join(STATE_DIR, 'inbox'))
  } catch {
    throw new Error('refusing to send: inbox directory unavailable')
  }
  const resolved = resolve(f)
  const parent = dirname(resolved)
  let parentReal: string
  try {
    parentReal = realpathSync(parent)
  } catch {
    throw new Error('refusing to send: download path parent does not exist')
  }
  const rel = relative(inboxReal, parentReal)
  const parentInside =
    rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  if (!parentInside) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

const MAX_CHUNK_LIMIT = 4096

export function chunk(
  text: string,
  limit: number,
  mode: 'length' | 'newline',
): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut =
        para > limit / 2
          ? para
          : line > limit / 2
            ? line
            : space > 0
              ? space
              : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}
