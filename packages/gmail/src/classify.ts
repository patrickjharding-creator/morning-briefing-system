import Anthropic from '@anthropic-ai/sdk'
import type { NormalisedMessage, ClassifiedThread } from '@morning-briefing/shared'

export type { ClassifiedThread }

const SYSTEM_PROMPT = `You are an email assistant helping Pat, a busy professional in Sydney.

Your task: given an email thread, determine if it needs Pat's attention today and summarise it concisely.

Respond with JSON only, in exactly this format:
{
  "action_needed": true or false,
  "summary": "one sentence, max 20 words"
}

action_needed is true if the thread:
- Contains a direct question Pat hasn't answered
- Contains a request or ask directed at Pat
- Is time-sensitive (event, deadline, meeting request)
- Contains important information Pat should act on today

action_needed is false if the thread is:
- Informational only (FYI, newsletters, updates)
- Already resolved
- A conversation Pat has already responded to recently`

function buildThreadText(messages: NormalisedMessage[]): string {
  return messages
    .slice(-3)  // last 3 messages of the thread
    .map(m => `From: ${m.sender.name} <${m.sender.identifier}>\nSubject: ${m.subject ?? ''}\n\n${m.body}`)
    .join('\n\n---\n\n')
}

export async function classifyThreads(
  client: Anthropic,
  messages: NormalisedMessage[]
): Promise<ClassifiedThread[]> {
  // Group by thread
  const threadMap = new Map<string, NormalisedMessage[]>()
  for (const msg of messages) {
    const existing = threadMap.get(msg.thread_id) ?? []
    existing.push(msg)
    threadMap.set(msg.thread_id, existing)
  }

  const threads = [...threadMap.entries()]

  if (threads.length === 0) return []

  // Classify all threads in parallel with Haiku
  const results = await Promise.allSettled(
    threads.map(async ([threadId, threadMessages]) => {
      const firstMsg = threadMessages[0]
      const threadText = buildThreadText(threadMessages)

      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: threadText }],
      })

      const text = response.content.find(b => b.type === 'text')?.text ?? '{}'
      const parsed = JSON.parse(text) as { action_needed: boolean; summary: string }

      return {
        thread_id: threadId,
        subject: firstMsg.subject ?? '(no subject)',
        sender: firstMsg.sender.name,
        action_needed: parsed.action_needed,
        summary: parsed.summary,
        messages: threadMessages,
      } satisfies ClassifiedThread
    })
  )

  return results
    .filter((r): r is PromiseFulfilledResult<ClassifiedThread> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter(t => t.action_needed)  // only pass action-needed threads to synthesis
}
