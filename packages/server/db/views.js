import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'
import * as db from './index.js'
import { constructUserUrl, isHyperUrl, parseEntryUrl } from '../lib/strings.js'
import * as dbGetters from './getters.js'
import * as schemas from '../lib/schemas.js'
import * as errors from '../lib/errors.js'
import { listHomeFeed } from './feed-getters.js'
import { fetchNotications, countNotications, dbGet, fetchReactions } from './util.js'

const DEFAULT_USER_AVATAR_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'static', 'img', 'default-user-avatar.jpg')
const DEFAULT_COMMUNITY_AVATAR_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'static', 'img', 'default-community-avatar.jpg')

// globals
// =

const _views = new Map()

// exported api
// =

export function getType (schemaId) {
  const view = _views.get(schemaId)
  if (!view) return undefined
  return view.schema?.schemaObject?.type
}

export async function exec (schemaId, auth, params) {
  const view = _views.get(schemaId)
  if (!view) {
    throw new Error(`View "${schemaId}" not found`)
  }
  view.validateParameters.assert(params)
  const res = await view.fn(auth, params)
  if (res) view.validateResponse.assert(res)
  return res
}

export function setup () {
  define('ctzn.network/views/avatar', async (auth, {dbId}) => {
    let userDb
    try {
      userDb = db.publicDbs.get(dbId)
      if (!userDb) throw 'Not found'
      
      const ptr = await userDb.blobs.getPointer('avatar')
      if (!ptr) throw 'Not found'

      return {
        ptr,
        etag: `W/block-${ptr.start}`,
        mimeType: ptr.mimeType,
        createStream: () => userDb.blobs.createReadStreamFromPointer(ptr)
      }
    } catch (e) {
      if (userDb?.dbType === 'ctzn.network/public-community-db') {
        return {
          ptr: null,
          etag: `W/default-community-avatar`,
          mimeType: 'image/jpeg',
          createStream: () => fs.createReadStream(DEFAULT_COMMUNITY_AVATAR_PATH)
        }
      } else {
        return {
          ptr: null,
          etag: `W/default-citizen-avatar`,
          mimeType: 'image/jpeg',
          createStream: () => fs.createReadStream(DEFAULT_USER_AVATAR_PATH)
        }
      }
    }
  })

  define('ctzn.network/views/blob', async (auth, {dbId, blobname}) => {
    const userDb = db.publicDbs.get(dbId)
    if (!userDb) throw 'Not found'
    
    const ptr = await userDb.blobs.getPointer(blobname)
    if (!ptr) throw 'Not found'

    return {
      ptr,
      etag: `W/block-${ptr.start}`,
      mimeType: ptr.mimeType,
      createStream: () => userDb.blobs.createReadStreamFromPointer(ptr)
    }
  })

  define('ctzn.network/views/comment', async (auth, {dbUrl, dbId, commentKey}) => {
    if (dbUrl) {
      let urlp = parseEntryUrl(dbUrl)
      if (urlp.schemaId !== 'ctzn.network/comment') {
        return undefined
      }
      dbId = urlp.dbKey
      commentKey = urlp.key
    }
    return dbGetters.getComment(getDb(dbId), commentKey, dbId)
  })

  define('ctzn.network/views/community-user-permission', async (auth, {communityDbId, citizenDbId, permId}) => {
    const communityDb = getDb(communityDbId)
    const memberRecord = await communityDb.members.get(citizenDbId)
    if (!memberRecord) return undefined
    if (memberRecord.value.roles?.includes('admin')) {
      return {permId: 'ctzn.network/perm-admin'}
    }
    const roleRecords = await Promise.all(memberRecord.value.roles?.map(roleId => communityDb.roles.get(roleId)) || [])
    for (let roleRecord of roleRecords) {
      const perm = roleRecord.value.permissions?.find(p => p.permId === permId)
      if (perm) return perm
    }
    return undefined
  })

  define('ctzn.network/views/community-user-permissions', async (auth, {communityDbId, citizenDbId}) => {
    const communityDb = getDb(communityDbId)
    const memberRecord = await communityDb.members.get(citizenDbId)
    if (!memberRecord) return {permissions: []}
    if (memberRecord.value.roles?.includes('admin')) {
      return {permissions: [{permId: 'ctzn.network/perm-admin'}]}
    }
    const roleRecords = await Promise.all(memberRecord.value.roles?.map(roleId => communityDb.roles.get(roleId)) || [])
    return {permissions: roleRecords.map(roleRecord => roleRecord.value.permissions || []).flat()}
  })

  define('ctzn.network/views/feed', async (auth, opts) => {
    return {feed: await listHomeFeed(opts, auth)}
  })

  define('ctzn.network/views/followers', async (auth, {dbId}) => {
    return dbGetters.listFollowers(dbId, auth)
  })

  define('ctzn.network/views/notifications', async (auth, opts) => {
    if (!auth) throw new errors.SessionError()
    return {notifications: await fetchNotications(auth, opts)}
  })

  define('ctzn.network/views/notifications-cleared-at', async (auth) => {
    if (!auth) throw new errors.SessionError()
    const accountRecord = await db.privateServerDb.accounts.get(auth.username)
    if (!accountRecord) throw new errors.NotFoundError('User account record not found')
    return {notificationsClearedAt: accountRecord.value.notificationsClearedAt || undefined}
  })

  define('ctzn.network/views/notifications-count', async (auth, opts) => {
    if (!auth) throw new errors.SessionError()
    return {count: await countNotications(auth, opts)}
  })

  define('ctzn.network/views/post', async (auth, {dbId, postKey, dbUrl}) => {
    if (dbUrl) {
      let urlp = parseEntryUrl(dbUrl)
      if (urlp.schemaId !== 'ctzn.network/post') {
        return undefined
      }
      dbId = urlp.dbKey
      postKey = urlp.key
    }
    return dbGetters.getPost(getDb(dbId), postKey, dbId, auth)
  })

  define('ctzn.network/views/posts', async (auth, opts) => {
    return {posts: await dbGetters.listPosts(getDb(opts.dbId), getListOpts(opts), opts.dbId)}
  })

  define('ctzn.network/views/profile', async (auth, {dbId}) => {
    const profileDb = getDb(dbId)
    const profileEntry = await profileDb.profile.get('self')
    if (!profileEntry) {
      throw new Error('User profile not found')
    }
    return {
      url: constructUserUrl(profileDb.username || profileDb.dbKey),
      dbKey: profileDb.dbKey,
      dbUrl: profileDb.url,
      dbType: profileDb.dbType,
      username: profileDb.username,
      value: profileEntry.value
    }
  })

  define('ctzn.network/views/reactions-to', async (auth, {dbUrl}) => {
    const subject = await dbGet(dbUrl).catch(e => undefined)
    const subjectEntry = subject ? subject.entry : {}
    if (subject) subjectEntry.author = {dbKey: subject.db.dbKey}
    subjectEntry.dbUrl = dbUrl
    const res = await fetchReactions(subjectEntry)
    return {subject: res.subject, reactions: res.reactions}
  })

  define('ctzn.network/views/thread', async (auth, {dbUrl}) => {
    return {comments: await dbGetters.getThread(dbUrl, auth)}
  })
}

// internal methods
// =

function define (schemaId, fn) {
  const schema = schemas.get(schemaId)
  if (!schema) throw new Error(`View schema "${schemaId}" not found`)
  const s = schema.schemaObject
  let validateParameters
  let validateResponse
  try {
    validateParameters = s.parameters ? schemas.createValidator(s.parameters) : {assert: noop}
    validateResponse = s.definition ? schemas.createValidator(s.definition) : {assert: noop}
  } catch (e) {
    console.error('Error while compiling view schema:', schemaId)
    console.error(e)
    process.exit(1)
  }
  _views.set(schemaId, {
    validateParameters,
    validateResponse,
    schema,
    fn
  })
}

function getListOpts (listOpts = {}) {
  const opts = {}
  if (listOpts.limit) opts.limit = listOpts.limit
  if (listOpts.lt) opts.lt = listOpts.lt
  if (listOpts.lte) opts.lte = listOpts.lte
  if (listOpts.gt) opts.gt = listOpts.gt
  if (listOpts.gte) opts.gte = listOpts.gte
  if (listOpts.reverse) opts.reverse = true
  return opts
}

function getDb (dbId) {
  const publicDb = db.publicDbs.get(dbId)
  if (!publicDb) throw new Error('User database not found')
  return publicDb
}

function noop () {}