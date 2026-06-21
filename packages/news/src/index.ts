import Anthropic from '@anthropic-ai/sdk'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import type { NewsBullet } from '@morning-briefing/shared'

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-southeast-2' })
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-southeast-2' })
const BUCKET = process.env.S3_BUCKET!

async function getSecret(name: string): Promise<string> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: name }))
  if (!res.SecretString) throw new Error(`Secret ${name} is empty`)
  return res.SecretString
}

async function getS3Text(key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  return await res.Body!.transformToString()
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a news summariser. Your job is to find and report one significant news story from the last 24 hours for a given topic.

Rules:
- Report only stories published in the last 24 hours
- Prefer these sources: Reuters, AP, BBC, The Guardian, ABC Australia, SMH, Financial Times
- Write exactly one sentence of maximum 25 words
- Be factual and specific — include names, numbers, or locations where relevant
- Do not editoralise or add opinion
- If no significant story exists in the last 24 hours, respond with: NO_STORY

Respond with ONLY the one-sentence summary. Nothing else.`

function buildUserPrompt(topic: string, trustedSources: string[]): string {
  return `Find the single most significant ${topic} news story from the last 24 hours. Prefer sources: ${trustedSources.join(', ')}. Write one sentence of max 25 words.`
}

// ─── Batch API ────────────────────────────────────────────────────────────────

async function runBatchJob(
  client: Anthropic,
  topicBuckets: string[],
  trustedSources: string[]
): Promise<NewsBullet[]> {
  const requests: Anthropic.Messages.MessageCreateParamsNonStreaming[] = topicBuckets.map((topic, i) => ({
    model: 'claude-sonnet-4-6',
    max_tokens: 100,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(topic, trustedSources) }],
    tools: [{
      type: 'web_search_20260209' as const,
      name: 'web_search',
      max_uses: 1,
    }],
  }))

  // Submit batch
  const batch = await client.messages.batches.create({
    requests: requests.map((req, i) => ({
      custom_id: topicBuckets[i],
      params: req,
    })),
  })

  console.log(`Batch submitted: ${batch.id}`)

  // Poll until complete (max 10 min — well within Lambda timeout for the 11pm job)
  const pollInterval = 15_000
  const maxWait = 10 * 60 * 1000
  const deadline = Date.now() + maxWait

  let result = batch
  while (result.processing_status !== 'ended') {
    if (Date.now() > deadline) throw new Error('Batch timed out after 10 minutes')
    await new Promise(r => setTimeout(r, pollInterval))
    result = await client.messages.batches.retrieve(batch.id)
    console.log(`Batch status: ${result.processing_status} — ${result.request_counts.processing} processing, ${result.request_counts.succeeded} succeeded`)
  }

  // Collect results
  const bullets: NewsBullet[] = []

  for await (const item of await client.messages.batches.results(batch.id)) {
    if (item.result.type !== 'succeeded') {
      console.warn(`Batch item ${item.custom_id} failed: ${item.result.type}`)
      continue
    }

    const message = item.result.message
    const textBlock = message.content.find(b => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') continue

    const headline = textBlock.text.trim()
    if (headline === 'NO_STORY' || !headline) continue

    // Truncate to 25 words if model exceeded the limit
    const words = headline.split(/\s+/)
    const truncated = words.length > 25 ? words.slice(0, 25).join(' ') + '…' : headline

    bullets.push({
      topic: item.custom_id,
      headline: truncated,
      source: 'web_search',
    })
  }

  // Preserve topic bucket order
  return topicBuckets
    .map(t => bullets.find(b => b.topic === t))
    .filter((b): b is NewsBullet => b !== undefined)
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

export async function handler(): Promise<void> {
  const today = new Date()
  const dateStr = today.toISOString().slice(0, 10)

  console.log(`News batch Lambda running for ${dateStr}`)

  const [anthropicKey, briefingConfigRaw] = await Promise.all([
    getSecret('ANTHROPIC_API_KEY'),
    getS3Text('personal-config/briefing-config.json'),
  ])

  const briefingConfig = JSON.parse(briefingConfigRaw) as {
    news: { topic_buckets: string[]; trusted_sources: string[] }
  }

  const client = new Anthropic({ apiKey: anthropicKey })

  const bullets = await runBatchJob(
    client,
    briefingConfig.news.topic_buckets,
    briefingConfig.news.trusted_sources
  )

  console.log(`Got ${bullets.length} news bullets`)

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `news/${dateStr}.json`,
    Body: JSON.stringify(bullets, null, 2),
    ContentType: 'application/json',
  }))

  console.log(`News written to s3://${BUCKET}/news/${dateStr}.json`)
}
