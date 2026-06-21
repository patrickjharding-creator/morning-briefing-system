import * as cdk from 'aws-cdk-lib'
import { MorningBriefingStack } from './stack'

const app = new cdk.App()

new MorningBriefingStack(app, 'MorningBriefingStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'ap-southeast-2',
  },
  description: 'Morning briefing system — Lambda pipeline, S3, DynamoDB, SES, API Gateway',
})
