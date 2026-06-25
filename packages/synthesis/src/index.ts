import Anthropic from '@anthropic-ai/sdk'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { randomUUID } from 'crypto'
import type { BriefingData, DraftCorrespondence, ClassifiedThread } from '@morning-briefing/shared'

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-southeast-2' })
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-southeast-2' })
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ap-southeast-2' }))
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION ?? 'ap-southeast-2' })

const BUCKET = process.env.S3_BUCKET!
const DRAFTS_TABLE = process.env.DRAFTS_TABLE ?? 'morning-briefing-drafts'

async function getSecret(name: string): Promise<string> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: name }))
  if (!res.SecretString) throw new Error(`Secret ${name} is empty`)
  return res.SecretString
}

async function getS3Json<T>(key: string): Promise<T> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  return JSON.parse(await res.Body!.transformToString()) as T
}

// ─── Cached system prompt ─────────────────────────────────────────────────────
// Marked with cache_control so Anthropic caches it across daily runs (~90% discount)

const SONNET_SYSTEM_PROMPT = `You are Pat's personal morning briefing assistant. Pat is a professional in Sydney, Australia.

Your job is to analyse the day's data and produce three outputs:
1. Suggested actions inferred from email summaries
2. Draft correspondence for emails that need a reply or new email to send
3. A one-sentence opening line that captures the feel of the day

Be concise, direct, and practical. Pat is busy. No filler.

For drafts: write as Pat. Match his likely tone (professional but friendly). Don't over-explain.
For the opening line: ground it in real data — training, calendar load, recovery, notable flags. Make it feel like it was written by someone who actually knows what's happening today.`

// ─── Suggested actions ────────────────────────────────────────────────────────

async function generateSuggestedActions(
  client: Anthropic,
  threads: ClassifiedThread[]
): Promise<string[]> {
  if (!threads.length) return []

  const threadSummaries = threads
    .map(t => `- "${t.subject}" from ${t.sender}: ${t.summary}`)
    .join('\n')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system: [{ type: 'text', text: SONNET_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Based on these email summaries, list the suggested actions Pat should take today. Be specific. One action per line, starting with a verb. Max 5 actions.\n\n${threadSummaries}`,
    }],
  })

  const text = response.content.find(b => b.type === 'text')?.text ?? ''
  return text
    .split('\n')
    .map(l => l.replace(/^\d+[.)]\s+/, '').replace(/^[-•*]+\s*/, '').trim())
    .filter(l => l.length > 10 && !l.startsWith('*') && !l.startsWith('#') && !l.toLowerCase().includes("today's suggested actions") && !l.toLowerCase().startsWith("here are"))
    .slice(0, 5)
}

// ─── Draft correspondence ─────────────────────────────────────────────────────

async function generateDrafts(
  client: Anthropic,
  threads: ClassifiedThread[]
): Promise<DraftCorrespondence[]> {
  const replyThreads = threads.filter(t =>
    t.messages.some(m => m.direction === 'inbound' && !m.read)
  )

  if (!replyThreads.length) return []

  const drafts: DraftCorrespondence[] = []

  for (const thread of replyThreads.slice(0, 3)) {  // max 3 drafts per day
    const lastInbound = [...thread.messages]
      .reverse()
      .find(m => m.direction === 'inbound')
    if (!lastInbound) continue

    const context = `Thread: "${thread.subject}"\nFrom: ${lastInbound.sender.name}\n\n${lastInbound.body}`

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: [{ type: 'text', text: SONNET_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `Write a reply to this email on Pat's behalf. Be concise and direct. Output only the email body — no subject line, no greeting label, no sign-off label.\n\n${context}`,
      }],
    })

    const body = response.content.find(b => b.type === 'text')?.text?.trim() ?? ''
    if (!body) continue

    const draft: DraftCorrespondence = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      status: 'draft',
      to: lastInbound.sender.identifier,
      subject: `Re: ${thread.subject}`,
      body,
      context: thread.summary,
    }

    // Persist to DynamoDB
    await dynamo.send(new PutCommand({ TableName: DRAFTS_TABLE, Item: draft }))
    drafts.push(draft)
  }

  return drafts
}

// ─── Philosopher quote ────────────────────────────────────────────────────────

async function generatePhilosopher(
  client: Anthropic,
  contextLine: string
): Promise<BriefingData['philosopher']> {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Select a relevant philosophical quote for Pat's morning briefing based on this context: "${contextLine}"

Choose from: Marcus Aurelius, Epictetus, Seneca, Cato (Stoic) | Camus, Sartre, de Beauvoir, Heidegger, Kierkegaard (Existentialist) | Aristotle, Kant, Mill, Wittgenstein, Bertrand Russell (Moral philosophy)

Contextual mapping:
- Poor sleep or high load → Stoic (resilience, control)
- Social commitments → de Beauvoir or Aristotle
- Decisions pending → Sartre
- Mundane or repetitive → Camus
- Physical/training focus → Epictetus
- Race approaching → Marcus Aurelius
- Quiet reflective day → Kierkegaard or Russell
- Default → Stoic

Respond with JSON only:
{"quote": "...", "author": "...", "tradition": "Stoic|Existentialist|Moral philosophy"}`,
    }],
  })

  const raw = response.content.find(b => b.type === 'text')?.text ?? ''
  const match = raw.match(/\{[\s\S]*\}/)
  try {
    return JSON.parse(match?.[0] ?? '{}') as BriefingData['philosopher']
  } catch {
    console.error('Philosopher JSON parse failed:', raw)
    return null
  }
}

// ─── Fitness commentary ───────────────────────────────────────────────────────

async function generateFitnessCommentary(
  client: Anthropic,
  fitness: BriefingData['fitness']
): Promise<string | null> {
  const { recovery, planned_session, goals } = fitness
  const context = [
    `HRV: ${recovery.hrv_value ?? 'unknown'} (${recovery.hrv_status})`,
    `Sleep: ${recovery.sleep_duration_hr}h`,
    `Body Battery: ${recovery.body_battery ?? 'unknown'}`,
    planned_session ? `Today's session: ${planned_session.discipline} ${planned_session.type}` : 'Rest day',
    goals.weight_current_kg ? `Weight: ${goals.weight_current_kg}kg (target ${goals.weight_target_kg}kg)` : null,
    fitness.race_countdown ?? null,
  ].filter(Boolean).join(', ')

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 80,
    messages: [{
      role: 'user',
      content: `Write one sentence of practical fitness commentary for Pat based on: ${context}. Be direct and specific. No generic motivational filler.`,
    }],
  })

  return response.content.find(b => b.type === 'text')?.text?.trim() ?? null
}

// ─── Opening line ─────────────────────────────────────────────────────────────

async function generateOpeningLine(
  client: Anthropic,
  briefing: Partial<BriefingData>
): Promise<string> {
  const contextParts = [
    briefing.fitness?.recovery ? `HRV ${briefing.fitness.recovery.hrv_value ?? '?'} (${briefing.fitness.recovery.hrv_status}), sleep ${briefing.fitness.recovery.sleep_duration_hr}h` : null,
    briefing.appointments?.length ? `${briefing.appointments.length} appointment${briefing.appointments.length > 1 ? 's' : ''}` : 'clear calendar',
    briefing.fitness?.planned_session ? `${briefing.fitness.planned_session.discipline} session planned` : 'rest day',
    briefing.drafts?.length ? `${briefing.drafts.length} draft${briefing.drafts.length > 1 ? 's' : ''} to approve` : null,
    briefing.fitness?.race_countdown ?? null,
    briefing.weather?.advisory ?? null,
  ].filter(Boolean).join(', ')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 80,
    system: [{ type: 'text', text: SONNET_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Write a single opening sentence for Pat's morning briefing. Ground it in real data. Be specific and warm — not generic. Start with "Good morning, Pat —"\n\nContext: ${contextParts}`,
    }],
  })

  return response.content.find(b => b.type === 'text')?.text?.trim() ?? 'Good morning, Pat.'
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

export async function handler(): Promise<void> {
  const today = new Date()
  // Use Sydney local date — Lambda runs at 7am Sydney = 9pm UTC previous day
  const dateStr = today.toLocaleDateString('en-CA')
  // News Lambda runs at 11pm Sydney (= 1pm UTC same day) — uses UTC date for its S3 key
  const newsDateStr = today.toISOString().slice(0, 10)

  console.log(`Synthesis Lambda running for ${dateStr}`)

  const anthropicKey = await getSecret('ANTHROPIC_API_KEY')
  const client = new Anthropic({ apiKey: anthropicKey })

  // Load ingest JSON, Gmail classification, and news batch result from S3
  const [ingestData, gmailThreads, newsBullets] = await Promise.all([
    getS3Json<Partial<BriefingData>>(`ingest/${dateStr}.json`),
    getS3Json<ClassifiedThread[]>(`gmail/${dateStr}.json`).catch(() => [] as ClassifiedThread[]),
    getS3Json<BriefingData['news']>(`news/${newsDateStr}.json`).catch(() => [] as BriefingData['news']),
  ])

  // Run Sonnet + Haiku tasks — suggested actions and drafts can run in parallel
  const [suggestedActions, drafts, fitnessCommentary] = await Promise.all([
    generateSuggestedActions(client, gmailThreads),
    generateDrafts(client, gmailThreads),
    ingestData.fitness ? generateFitnessCommentary(client, ingestData.fitness) : Promise.resolve(null),
  ])

  // Build context string for philosopher and opening line
  const contextLine = [
    ingestData.fitness?.recovery ? `${ingestData.fitness.recovery.hrv_status} HRV, ${ingestData.fitness.recovery.sleep_duration_hr}h sleep` : '',
    ingestData.appointments?.length ? `${ingestData.appointments.length} appointments` : 'quiet day',
    ingestData.fitness?.planned_session?.discipline ?? 'rest day',
    ingestData.fitness?.race_countdown ?? '',
  ].filter(Boolean).join(', ')

  const [philosopher, openingLine] = await Promise.all([
    generatePhilosopher(client, contextLine),
    generateOpeningLine(client, { ...ingestData, drafts }),
  ])

  // Assemble final briefing
  const briefing: BriefingData = {
    date: dateStr,
    opening_line: openingLine,
    weather: ingestData.weather ?? { periods: [], advisory: null, fetched_at: new Date().toISOString() },
    appointments: ingestData.appointments ?? [],
    birthdays: ingestData.birthdays ?? [],
    race: ingestData.race ?? null,
    parenting: ingestData.parenting ?? { is_school_day: false, is_school_holiday: false, pat_periods: [], school_holiday_flag: null, last_dropoff_flag: null },
    reminders: ingestData.reminders ?? [],
    suggested_actions: suggestedActions,
    drafts,
    fitness: {
      ...ingestData.fitness!,
      commentary: fitnessCommentary,
    },
    news: newsBullets,
    philosopher,
  }

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `briefing/${dateStr}.json`,
    Body: JSON.stringify(briefing, null, 2),
    ContentType: 'application/json',
  }))

  console.log(`Synthesis complete — written to s3://${BUCKET}/briefing/${dateStr}.json`)

  // ── Invoke Email Builder Lambda ───────────────────────────────────────────

  const emailBuilderArn = process.env.EMAIL_BUILDER_ARN!
  console.log('Invoking Email Builder Lambda...')
  const emailResult = await lambdaClient.send(new InvokeCommand({
    FunctionName: emailBuilderArn,
    InvocationType: 'RequestResponse',
  }))
  if (emailResult.FunctionError) {
    const errPayload = emailResult.Payload ? Buffer.from(emailResult.Payload).toString() : 'unknown'
    throw new Error(`Email Builder Lambda failed: ${errPayload}`)
  }
  console.log('Email Builder Lambda completed — briefing sent')
}
