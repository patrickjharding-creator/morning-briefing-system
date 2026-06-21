import { google } from 'googleapis'
import type { NormalisedMessage } from '@morning-briefing/shared'

interface GmailCredentials {
  client_id: string
  client_secret: string
  refresh_token: string
}

interface FilterConfig {
  exclude_automated: boolean
  exclude_group_chats: boolean
  min_message_length: number
  lookback_hours: number
}

// Labels / senders that indicate automated/marketing mail — excluded before any LLM call
const AUTOMATED_PATTERNS = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'notifications@', 'alerts@', 'newsletter@', 'marketing@',
  'updates@', 'info@', 'support@', 'hello@',
  'unsubscribe', 'list-unsubscribe',
]

const AUTOMATED_SUBJECTS = [
  'unsubscribe', 'newsletter', 'weekly digest', 'monthly digest',
  'your receipt', 'your order', 'invoice #', 'statement',
  'password reset', 'verify your', 'confirm your',
]

function isAutomated(from: string, subject: string): boolean {
  const fromLower = from.toLowerCase()
  const subjectLower = subject.toLowerCase()
  return (
    AUTOMATED_PATTERNS.some(p => fromLower.includes(p)) ||
    AUTOMATED_SUBJECTS.some(p => subjectLower.includes(p))
  )
}

function decodeBase64(str: string): string {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
}

function extractBody(payload: GooglePayload): string {
  // Try plain text first, then html
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64(payload.body.data)
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBody(part)
      if (text) return text
    }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    // Strip HTML tags for a rough plain-text extraction
    return decodeBase64(payload.body.data)
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return ''
}

interface GooglePayload {
  mimeType?: string
  body?: { data?: string }
  parts?: GooglePayload[]
  headers?: Array<{ name: string; value: string }>
}

export async function fetchGmailMessages(
  credentials: GmailCredentials,
  filters: FilterConfig
): Promise<NormalisedMessage[]> {
  const auth = new google.auth.OAuth2(credentials.client_id, credentials.client_secret)
  auth.setCredentials({ refresh_token: credentials.refresh_token })

  const gmail = google.gmail({ version: 'v1', auth })

  const since = new Date()
  since.setHours(since.getHours() - filters.lookback_hours)
  const afterEpoch = Math.floor(since.getTime() / 1000)

  // Fetch inbox threads from the last lookback_hours
  const listRes = await gmail.users.threads.list({
    userId: 'me',
    q: `in:inbox after:${afterEpoch} -category:promotions -category:social`,
    maxResults: 50,
  })

  const threads = listRes.data.threads ?? []
  const messages: NormalisedMessage[] = []

  for (const thread of threads) {
    if (!thread.id) continue

    const threadRes = await gmail.users.threads.get({
      userId: 'me',
      id: thread.id,
      format: 'full',
    })

    const threadMessages = threadRes.data.messages ?? []

    for (const msg of threadMessages) {
      if (!msg.id || !msg.payload) continue

      const headers = msg.payload.headers ?? []
      const getHeader = (name: string) =>
        headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''

      const from = getHeader('From')
      const to = getHeader('To')
      const subject = getHeader('Subject')
      const dateStr = getHeader('Date')
      const messageId = getHeader('Message-ID')

      const timestamp = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString()

      // Apply filters
      if (filters.exclude_automated && isAutomated(from, subject)) continue

      const body = extractBody(msg.payload as GooglePayload)
      if (body.length < filters.min_message_length) continue

      // Parse sender
      const senderMatch = from.match(/^(?:"?(.+?)"?\s+)?<(.+?)>$/) ?? [null, from, from]
      const senderName = senderMatch[1]?.trim() ?? from
      const senderEmail = senderMatch[2]?.trim() ?? from

      // Determine direction (inbound = not from Pat's own address)
      const direction = senderEmail.toLowerCase().includes('patrick.j.harding')
        ? 'outbound' as const
        : 'inbound' as const

      messages.push({
        id: msg.id,
        source: 'gmail',
        source_id: msg.id,
        thread_id: thread.id,
        direction,
        sender: { name: senderName, identifier: senderEmail },
        recipients: [{ name: 'Pat', identifier: 'patrick.j.harding@gmail.com' }],
        subject,
        body: body.slice(0, 2000),  // cap body length for LLM input
        timestamp,
        read: !msg.labelIds?.includes('UNREAD'),
        metadata: { gmail_labels: msg.labelIds ?? [] },
      })
    }
  }

  return messages
}
