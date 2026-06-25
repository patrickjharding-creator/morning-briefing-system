import Anthropic from '@anthropic-ai/sdk'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { fetchGmailMessages } from './fetch'
import { classifyThreads } from './classify'
import type { ClassifiedThread } from './classify'

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

export async function handler(): Promise<void> {
  const today = new Date()
  // Use Sydney local date — Lambda runs at 7am Sydney = 9pm UTC previous day
  const dateStr = today.toLocaleDateString('en-CA')

  console.log(`Gmail Lambda running for ${dateStr}`)

  const [anthropicKey, gmailCredentialsRaw, briefingConfigRaw] = await Promise.all([
    getSecret('ANTHROPIC_API_KEY'),
    getSecret('GMAIL_CREDENTIALS'),
    getS3Text('personal-config/briefing-config.json'),
  ])

  const gmailCredentials = JSON.parse(gmailCredentialsRaw) as {
    client_id: string
    client_secret: string
    refresh_token: string
  }

  const briefingConfig = JSON.parse(briefingConfigRaw) as {
    messaging: { filters: { exclude_automated: boolean; exclude_group_chats: boolean; min_message_length: number; lookback_hours: number; inbox_scan_days: number } }
  }

  const client = new Anthropic({ apiKey: anthropicKey })

  // Fetch and filter messages
  const messages = await fetchGmailMessages(gmailCredentials, briefingConfig.messaging.filters)
  console.log(`Fetched ${messages.length} messages after filtering`)

  // Classify threads with Haiku — only action-needed threads pass through
  const actionThreads = await classifyThreads(client, messages)
  console.log(`${actionThreads.length} threads need action`)

  // Write to S3 for Synthesis Lambda
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `gmail/${dateStr}.json`,
    Body: JSON.stringify(actionThreads, null, 2),
    ContentType: 'application/json',
  }))

  console.log(`Gmail classification written to s3://${BUCKET}/gmail/${dateStr}.json`)
}
