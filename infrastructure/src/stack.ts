import * as cdk from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as scheduler from 'aws-cdk-lib/aws-scheduler'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as apigateway from 'aws-cdk-lib/aws-apigateway'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Construct } from 'constructs'
import * as path from 'path'

export class MorningBriefingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // ── S3 bucket — all ingest/synthesis/news data ───────────────────────────

    const bucket = new s3.Bucket(this, 'BriefingBucket', {
      bucketName: `morning-briefing-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        { expiration: cdk.Duration.days(30), prefix: 'ingest/' },
        { expiration: cdk.Duration.days(30), prefix: 'gmail/' },
        { expiration: cdk.Duration.days(30), prefix: 'news/' },
        { expiration: cdk.Duration.days(90), prefix: 'briefing/' },
      ],
    })

    // ── DynamoDB — draft correspondence ──────────────────────────────────────

    const draftsTable = new dynamodb.Table(this, 'DraftsTable', {
      tableName: 'morning-briefing-drafts',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // ── Secrets (placeholders — values set manually in AWS console) ──────────

    const secrets = {
      anthropic: secretsmanager.Secret.fromSecretNameV2(this, 'AnthropicKey', 'ANTHROPIC_API_KEY'),
      openweathermap: secretsmanager.Secret.fromSecretNameV2(this, 'OwmKey', 'OPENWEATHERMAP_API_KEY'),
      icloud: secretsmanager.Secret.fromSecretNameV2(this, 'IcloudPassword', 'ICLOUD_APP_PASSWORD'),
      garmin: secretsmanager.Secret.fromSecretNameV2(this, 'GarminCreds', 'GARMIN_CREDENTIALS'),
      gmail: secretsmanager.Secret.fromSecretNameV2(this, 'GmailCreds', 'GMAIL_CREDENTIALS'),
    }

    // ── Shared Lambda environment ─────────────────────────────────────────────

    const sharedEnv = {
      AWS_ACCOUNT_ID: this.account,
      S3_BUCKET: bucket.bucketName,
      DRAFTS_TABLE: draftsTable.tableName,
      NODE_OPTIONS: '--enable-source-maps',
      TZ: 'Australia/Sydney',
    }

    // ── Lambda defaults ───────────────────────────────────────────────────────

    // Helper to build Lambda from a package
    const makeLambda = (id: string, pkg: string, entryFile = 'index.ts', overrides: Partial<NodejsFunctionProps> = {}) =>
      new NodejsFunction(this, id, {
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: cdk.Duration.minutes(5),
        environment: sharedEnv,
        functionName: `morning-briefing-${pkg}`,
        entry: path.join(__dirname, `../../packages/${pkg}/src/${entryFile}`),
        handler: 'handler',
        bundling: {
          externalModules: ['@aws-sdk/*'],
          sourceMap: true,
        },
        ...overrides,
      })

    // ── Lambda functions ──────────────────────────────────────────────────────

    const ingestFn = makeLambda('IngestLambda', 'ingest', 'index.ts', {
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
    })

    const gmailFn = makeLambda('GmailLambda', 'gmail', 'index.ts', {
      timeout: cdk.Duration.minutes(10),
    })

    const synthesisFn = makeLambda('SynthesisLambda', 'synthesis', 'index.ts', {
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
    })

    const newsFn = makeLambda('NewsLambda', 'news', 'index.ts', {
      timeout: cdk.Duration.minutes(15),  // Batch API polling
    })

    const emailBuilderFn = makeLambda('EmailBuilderLambda', 'email-builder', 'handler.ts', {
      environment: {
        ...sharedEnv,
        FROM_ADDRESS: 'patrick.j.harding@gmail.com',
        TO_ADDRESS: 'patrick.j.harding@gmail.com',
      },
    })

    const approvalFn = makeLambda('ApprovalLambda', 'approval-api', 'index.ts', {
      timeout: cdk.Duration.seconds(30),
    })

    // ── Grant permissions ─────────────────────────────────────────────────────

    bucket.grantReadWrite(ingestFn)
    bucket.grantReadWrite(gmailFn)
    bucket.grantReadWrite(synthesisFn)
    bucket.grantReadWrite(newsFn)
    bucket.grantRead(emailBuilderFn)

    draftsTable.grantWriteData(synthesisFn)
    draftsTable.grantReadWriteData(approvalFn)

    for (const fn of [ingestFn, gmailFn, synthesisFn, newsFn, approvalFn]) {
      Object.values(secrets).forEach(s => s.grantRead(fn))
    }

    // Email builder needs SES to send
    emailBuilderFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }))

    // ── Step Function / chained invocations via EventBridge pipes ─────────────
    // Ingest → Gmail → Synthesis → EmailBuilder — each triggered by the previous
    // completing. For simplicity in v1, Synthesis invokes EmailBuilder directly.
    // We model this as Lambda-to-Lambda via SDK calls, chained in Synthesis.
    // The EMAIL_BUILDER_ARN env var tells Synthesis where to invoke.
    synthesisFn.addEnvironment('EMAIL_BUILDER_ARN', emailBuilderFn.functionArn)
    emailBuilderFn.grantInvoke(synthesisFn)

    // Ingest triggers Gmail and Synthesis in sequence — pass ARNs
    ingestFn.addEnvironment('GMAIL_LAMBDA_ARN', gmailFn.functionArn)
    ingestFn.addEnvironment('SYNTHESIS_LAMBDA_ARN', synthesisFn.functionArn)
    gmailFn.grantInvoke(ingestFn)
    synthesisFn.grantInvoke(ingestFn)

    // ── Schedules ─────────────────────────────────────────────────────────────

    // Morning trigger — EventBridge Scheduler with Australia/Sydney timezone
    // handles AEST/AEDT (daylight saving) automatically. No manual UTC adjustments needed.
    const schedulerRole = new iam.Role(this, 'SchedulerInvokeRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    })
    ingestFn.grantInvoke(schedulerRole)
    newsFn.grantInvoke(schedulerRole)

    new scheduler.CfnSchedule(this, 'MorningTrigger', {
      name: 'morning-briefing-7am',
      description: 'Triggers ingest Lambda at 7:00am Sydney time (timezone-aware, handles DST)',
      scheduleExpression: 'cron(0 7 * * ? *)',
      scheduleExpressionTimezone: 'Australia/Sydney',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: ingestFn.functionArn,
        roleArn: schedulerRole.roleArn,
      },
    })

    new scheduler.CfnSchedule(this, 'NewsBatchTrigger', {
      name: 'morning-briefing-news-11pm',
      description: 'Triggers news Lambda at 11:00pm Sydney time (timezone-aware, handles DST)',
      scheduleExpression: 'cron(0 23 * * ? *)',
      scheduleExpressionTimezone: 'Australia/Sydney',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: newsFn.functionArn,
        roleArn: schedulerRole.roleArn,
      },
    })

    // ── API Gateway — approval/reject endpoints ───────────────────────────────

    const api = new apigateway.RestApi(this, 'ApprovalApi', {
      restApiName: 'morning-briefing-approval',
      description: 'Approve or reject morning briefing draft correspondence',
      defaultCorsPreflightOptions: undefined,
    })

    const approvalIntegration = new apigateway.LambdaIntegration(approvalFn)

    const approveResource = api.root.addResource('approve').addResource('{id}')
    approveResource.addMethod('GET', approvalIntegration)

    const rejectResource = api.root.addResource('reject').addResource('{id}')
    rejectResource.addMethod('GET', approvalIntegration)

    // Pass API URL to synthesis so it can embed approve/reject links in emails
    synthesisFn.addEnvironment('APPROVAL_API_URL', api.url)
    emailBuilderFn.addEnvironment('APPROVAL_API_URL', api.url)

    // ── Outputs ───────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName })
    new cdk.CfnOutput(this, 'ApprovalApiUrl', { value: api.url })
    new cdk.CfnOutput(this, 'DraftsTableName', { value: draftsTable.tableName })
  }
}
