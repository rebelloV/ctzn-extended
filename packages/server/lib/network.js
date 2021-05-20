import ip from 'ip'
import { promises as dns } from 'dns'
import { domainToWsEndpoint, HYPER_KEY } from './strings.js'
import { publicDbs, publicServerDb } from '../db/index.js'
import { ConfigurationError } from './errors.js'

export function resolveDbId (dbId) {
  if (dbId === 'server' || dbId === publicServerDb.dbKey) {
    return {username: 'server', dbKey: publicServerDb.dbKey}
  }
  if (publicDbs.get(dbId)) {
    return {username: publicDbs.get(dbId).username, dbKey: publicDbs.get(dbId).dbKey}
  }
  if (HYPER_KEY.test(dbId)) {
    return {username: undefined, dbKey: dbId}
  }
  throw new Error(`Unknown database ID: ${dbId}`)
}

export async function reverseDns (client, debugHandler) {
  client.headers = client.headers || {}
  const remoteAddress = client.headers['x-forwarded-for'] || client._socket.remoteAddress

  if (ip.isPrivate(remoteAddress)) {
    if (debugHandler) {
      return debugHandler()
    }
    throw new ConfigurationError('Cannot handle reverse-DNS lookups on private IP addresses')
  }
  return dns.reverse(remoteAddress)
}

export async function connectWs (domain) {
  const ws = new WebSocketClient(domainToWsEndpoint(domain))
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
    ws.once('close', reject)
  })
  return ws
}