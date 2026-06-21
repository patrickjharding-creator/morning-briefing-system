import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { google } from 'googleapis'
import type { DraftCorrespondence } from '@morning-briefing/shared'

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-southeast-2' })
const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ap-southeast-2' })
)

const DRAFTS_TABLE = process.env.DRAFTS_TABLE ?? 'morning-briefing-drafts'

async function getSecret(name: string): Promise<string> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: name }))
  if (!res.SecretString) throw new Error(`Secret ${name} is empty`)
  return res.SecretString
}

async function getDraft(id: string): Promise<DraftCorrespondence | null> {
  const res = await dynamo.send(new GetCommand({ TableName: DRAFTS_TABLE, Key: { id } }))
  return (res.Item as DraftCorrespondence) ?? null
}

async function updateDraftStatus(
  id: string,
  status: DraftCorrespondence['status'],
  extraFields: Record<string, string> = {}
): Promise<void> {
  const updates = { status, ...extraFields }
  const setExpr = Object.keys(updates).map(k => `#${k} = :${k}`).join(', ')
  const names = Object.fromEntries(Object.keys(updates).map(k => [`#${k}`, k]))
  const values = Object.fromEntries(Object.entries(updates).map(([k, v]) => [`:${k}`, v]))

  await dynamo.send(new UpdateCommand({
    TableName: DRAFTS_TABLE,
    Key: { id },
    UpdateExpression: `SET ${setExpr}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }))
}

async function sendViaGmail(draft: DraftCorrespondence, credentials: {
  client_id: string
  client_secret: string
  refresh_token: string
}): Promise<void> {
  const auth = new google.auth.OAuth2(credentials.client_id, credentials.client_secret)
  auth.setCredentials({ refresh_token: credentials.refresh_token })

  const gmail = google.gmail({ version: 'v1', auth })

  // Build RFC 2822 message
  const message = [
    `To: ${draft.to}`,
    `Subject: ${draft.subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    draft.body,
  ].join('\r\n')

  const encoded = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded },
  })
}

function htmlResponse(statusCode: number, html: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  }
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; text-align: center; color: #333; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    p { color: #666; font-size: 15px; line-height: 1.5; }
    .icon { font-size: 48px; margin-bottom: 16px; }
  </style>
</head>
<body>${body}</body>
</html>`
}

// ─── Lambda handler ───────────────────────────────────────────────────────────
// Routes:
//   GET /approve/{id}  → send draft via Gmail, mark sent
//   GET /reject/{id}   → mark rejected, discard

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const path = event.path ?? ''
  const match = path.match(/^\/(approve|reject)\/([a-f0-9-]+)$/)

  if (!match) {
    return htmlResponse(400, page('Bad Request', '<div class="icon">❌</div><h1>Bad Request</h1><p>Invalid link.</p>'))
  }

  const [, action, draftId] = match

  const draft = await getDraft(draftId)

  if (!draft) {
    return htmlResponse(404, page('Not Found', '<div class="icon">🔍</div><h1>Not Found</h1><p>This draft no longer exists.</p>'))
  }

  if (draft.status !== 'draft') {
    const label = draft.status === 'sent' ? 'already sent' : 'already rejected'
    return htmlResponse(200, page('Already Actioned', `<div class="icon">✓</div><h1>Already actioned</h1><p>This draft was ${label}.</p>`))
  }

  if (action === 'reject') {
    await updateDraftStatus(draftId, 'rejected')
    return htmlResponse(200, page('Rejected', '<div class="icon">🗑</div><h1>Draft rejected</h1><p>The draft has been discarded.</p>'))
  }

  // Approve: send via Gmail
  try {
    const gmailCredentialsRaw = await getSecret('GMAIL_CREDENTIALS')
    const credentials = JSON.parse(gmailCredentialsRaw) as {
      client_id: string
      client_secret: string
      refresh_token: string
    }

    await sendViaGmail(draft, credentials)
    await updateDraftStatus(draftId, 'sent', { sent_at: new Date().toISOString() })

    return htmlResponse(200, page('Sent', `
      <div class="icon">✉️</div>
      <h1>Email sent</h1>
      <p>Your reply to <strong>${draft.to}</strong> has been sent.</p>
      <p style="margin-top:24px;font-size:13px;color:#999;">Re: ${draft.subject}</p>
    `))
  } catch (err) {
    console.error('Failed to send email:', err)
    return htmlResponse(500, page('Error', '<div class="icon">⚠️</div><h1>Send failed</h1><p>Something went wrong. The draft has not been sent. Check CloudWatch logs.</p>'))
  }
}
