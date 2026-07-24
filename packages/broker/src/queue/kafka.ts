import type { BrokerMode, QueueMessage } from '@sandbox-dev/shared'
import { KAFKA_TOPIC_ACQUIRE } from '@sandbox-dev/shared'
import { Kafka, type Consumer, type Producer } from 'kafkajs'

export class QueueService {
  private readonly kafka: Kafka
  private producer: Producer | null = null
  private consumer: Consumer | null = null
  private onMessage: ((msg: QueueMessage) => Promise<void>) | null = null

  constructor(brokers: string[], clientId = 'sandbox-broker') {
    this.kafka = new Kafka({ clientId, brokers })
  }

  async connect(): Promise<void> {
    this.producer = this.kafka.producer()
    await this.producer.connect()

    this.consumer = this.kafka.consumer({ groupId: 'sandbox-broker-workers' })
    await this.consumer.connect()
    await this.consumer.subscribe({ topic: KAFKA_TOPIC_ACQUIRE, fromBeginning: false })
  }

  async publish(message: QueueMessage): Promise<void> {
    if (!this.producer) throw new Error('Kafka producer not connected')
    await this.producer.send({
      topic: KAFKA_TOPIC_ACQUIRE,
      messages: [{ key: message.ticketId, value: JSON.stringify(message) }],
    })
  }

  async startConsumer(handler: (msg: QueueMessage) => Promise<void>): Promise<void> {
    if (!this.consumer) throw new Error('Kafka consumer not connected')
    this.onMessage = handler
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value || !this.onMessage) return
        const parsed = JSON.parse(message.value.toString()) as QueueMessage
        await this.onMessage(parsed)
      },
    })
  }

  async disconnect(): Promise<void> {
    await this.producer?.disconnect()
    await this.consumer?.disconnect()
  }
}

export async function ensureTopic(brokers: string[]): Promise<void> {
  const kafka = new Kafka({ clientId: 'sandbox-broker-admin', brokers })
  const admin = kafka.admin()
  await admin.connect()
  const topics = await admin.listTopics()
  if (!topics.includes(KAFKA_TOPIC_ACQUIRE)) {
    await admin.createTopics({
      topics: [{ topic: KAFKA_TOPIC_ACQUIRE, numPartitions: 1, replicationFactor: 1 }],
    })
  }
  await admin.disconnect()
}

export type { BrokerMode, QueueMessage }
