import type { BrokerMode, IdlePolicy } from '@sandbox-dev/shared'

export interface Config {
  port: number
  redisUrl: string
  kafkaBrokers: string[]
  daytonaApiUrl: string
  daytonaApiKey: string
  daytonaTarget: string
  maxConcurrency: number
  idlePolicy: IdlePolicy
  defaultMode: BrokerMode
  jwtSecret?: string
  defaultPoolId: string
  snapshot?: string
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8080),
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map((s) => s.trim()),
    daytonaApiUrl: process.env.DAYTONA_API_URL ?? 'http://localhost:3000/api',
    daytonaApiKey: process.env.DAYTONA_API_KEY ?? '',
    daytonaTarget: process.env.DAYTONA_TARGET ?? 'us',
    maxConcurrency: Number(process.env.MAX_SANDBOX_CONCURRENCY ?? 2),
    idlePolicy: (process.env.IDLE_POLICY ?? 'stop_keep') as IdlePolicy,
    defaultMode: (process.env.DEFAULT_BROKER_MODE ?? 'exclusive') as BrokerMode,
    jwtSecret: process.env.JWT_SECRET,
    defaultPoolId: process.env.DEFAULT_POOL_ID ?? 'default',
    snapshot: process.env.DAYTONA_SNAPSHOT,
  }
}
