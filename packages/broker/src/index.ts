import { Redis } from 'ioredis'
import { loadConfig } from './config.js'
import { createSandboxProvider } from './providers/index.js'
import { LeaseManager } from './state/lease-manager.js'
import { QueueService, ensureTopic } from './queue/kafka.js'
import { BrokerService } from './api/broker-service.js'
import { createApp } from './api/routes.js'

async function main() {
  const config = loadConfig()
  if (config.sandboxProvider === 'daytona' && !config.daytonaApiKey) {
    console.warn('WARNING: DAYTONA_API_KEY is not set')
  }

  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null })
  redis.on('error', (err: Error) => console.error('Redis error:', err))

  await ensureTopic(config.kafkaBrokers).catch((err) => {
    console.warn('Kafka topic setup skipped:', err.message)
  })

  const queue = new QueueService(config.kafkaBrokers)
  await queue.connect()

  const leases = new LeaseManager(redis, config.maxConcurrency, config.idlePolicy)
  const provider = createSandboxProvider(config)
  const broker = new BrokerService(config, leases, provider, queue)

  await queue.startConsumer(async (msg) => {
    await broker.processQueueMessage(msg)
  })

  if (config.leaseTtlMs > 0 && config.leaseSweepIntervalMs > 0) {
    setInterval(() => {
      broker.sweepExpiredLeases().catch((err) => console.error('lease sweep error:', err))
    }, config.leaseSweepIntervalMs).unref()
  }

  const app = createApp(config, broker)
  app.listen(config.port, () => {
    console.log(`Sandbox broker listening on :${config.port}`)
    console.log(
      `provider=${config.sandboxProvider} maxConcurrency=${config.maxConcurrency} idlePolicy=${config.idlePolicy}`,
    )
  })

  const shutdown = async () => {
    await queue.disconnect()
    redis.disconnect()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
