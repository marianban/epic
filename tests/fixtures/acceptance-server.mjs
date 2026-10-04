import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const port = Number(process.argv[2])
if (!Number.isInteger(port) || port <= 0)
  throw new Error('Explicit port required.')
const server = createServer(async (request, response) => {
  if (request.url === '/favicon.ico') {
    response.writeHead(204).end()
    return
  }
  try {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(await readFile('counter.html'))
  } catch (error) {
    response.writeHead(500).end(String(error))
  }
})
server.listen(port, '127.0.0.1')
process.on('SIGTERM', () => server.close())
