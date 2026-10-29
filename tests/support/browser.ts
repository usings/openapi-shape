import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { TestProject } from "vitest/node"

declare module "vitest" {
  interface ProvidedContext {
    browserBaseURL: string
  }
}

/** Real HTTP fixtures, on a different origin from Vitest's browser runner. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const closed = new Set<string>()
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.test")
    if (url.pathname !== "/blocked") response.setHeader("access-control-allow-origin", "*")
    response.setHeader("cache-control", "no-store")
    try {
      switch (url.pathname) {
        case "/redirect":
          response.writeHead(302, { location: "/data" })
          response.end()
          return
        case "/data":
        case "/allowed":
        case "/blocked":
          response.setHeader("content-type", "application/json")
          response.end('{"ok":true}')
          return
        case "/empty":
          response.setHeader("content-type", "application/json")
          response.end()
          return
        case "/events": {
          const id = url.searchParams.get("id") ?? ""
          response.on("close", () => {
            closed.add(id)
          })
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.write("data: live\n\n")
          return
        }
        case "/closed":
          response.setHeader("content-type", "application/json")
          response.end(JSON.stringify(closed.has(url.searchParams.get("id") ?? "")))
          return
        case "/echo": {
          const parts: Buffer[] = []
          for await (const chunk of request) parts.push(chunk as Buffer)
          response.setHeader("content-type", "application/json")
          response.end(
            JSON.stringify({
              body: Buffer.concat(parts).toString("utf8"),
              type: request.headers["content-type"],
            }),
          )
          return
        }
        default:
          response.writeHead(404)
          response.end()
      }
    } catch {
      response.destroy()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  project.provide("browserBaseURL", `http://127.0.0.1:${port}`)
  return async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}
