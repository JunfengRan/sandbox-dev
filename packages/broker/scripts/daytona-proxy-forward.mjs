import net from 'node:net'

const targetHost = process.env.DAYTONA_PROXY_FORWARD_HOST ?? 'host.docker.internal'
const targetPort = Number(process.env.DAYTONA_PROXY_FORWARD_PORT ?? 4000)
const listenPort = Number(process.env.DAYTONA_PROXY_LISTEN_PORT ?? 4000)

const server = net.createServer((client) => {
  const upstream = net.connect(targetPort, targetHost)
  client.pipe(upstream)
  upstream.pipe(client)
  client.on('error', () => upstream.destroy())
  upstream.on('error', () => client.destroy())
})

server.listen(listenPort, '127.0.0.1', () => {
  console.log(`Daytona proxy forward 127.0.0.1:${listenPort} -> ${targetHost}:${targetPort}`)
})
