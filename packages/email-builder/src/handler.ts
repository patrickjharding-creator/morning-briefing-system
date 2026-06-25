import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import type { BriefingData } from '@morning-briefing/shared'
import { buildEmail } from './index'

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-southeast-2' })
const ses = new SESClient({ region: process.env.AWS_REGION ?? 'ap-southeast-2' })

const BUCKET = process.env.S3_BUCKET!
const TO_ADDRESS = process.env.TO_ADDRESS ?? 'patrick.j.harding@gmail.com'
const FROM_ADDRESS = process.env.FROM_ADDRESS ?? 'briefing@morningbriefing.au'
const APPROVAL_API_URL = process.env.APPROVAL_API_URL ?? ''

export async function handler(): Promise<void> {
  const today = new Date()
  // Use Sydney local date — Lambda runs at 7am Sydney = 9pm UTC previous day
  const dateStr = today.toLocaleDateString('en-CA')

  console.log(`Email Builder Lambda running for ${dateStr}`)

  const res = await s3.send(new GetObjectCommand({
    Bucket: BUCKET,
    Key: `briefing/${dateStr}.json`,
  }))

  const briefing = JSON.parse(await res.Body!.transformToString()) as BriefingData
  const html = buildEmail(briefing, APPROVAL_API_URL)

  await ses.send(new SendEmailCommand({
    Source: FROM_ADDRESS,
    Destination: { ToAddresses: [TO_ADDRESS] },
    Message: {
      Subject: {
        Data: `Morning Briefing — ${new Date(briefing.date).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })}`,
        Charset: 'UTF-8',
      },
      Body: {
        Html: { Data: html, Charset: 'UTF-8' },
      },
    },
  }))

  console.log(`Email sent to ${TO_ADDRESS}`)
}
