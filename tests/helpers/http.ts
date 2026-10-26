import { createServer } from "node:http"
import type { RequestListener } from "node:http"
import type { AddressInfo } from "node:net"

/** Bind a real loopback server and await teardown, including connections left open by failures. */
export async function withServer<T>(
  handler: RequestListener,
  run: (origin: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  try {
    const { port } = server.address() as AddressInfo
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}
