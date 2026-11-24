import amqp from "amqplib"

export const QUEUE = process.env.QUEUE ?? "orders"
const URL = process.env.AMQP_URL ?? "amqp://guest:guest@rabbitmq:5672"

export async function connectWithRetry(tag: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      const conn = await amqp.connect(URL)
      conn.on("close", () => {
        console.error(`[${tag}] conexão AMQP fechada, saindo`)
        process.exit(1)
      })
      return conn
    } catch (err) {
      if (attempt % 10 === 1)
        console.error(
          `[${tag}] aguardando RabbitMQ (${(err as Error).message})`,
        )
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}
