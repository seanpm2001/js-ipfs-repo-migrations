'use strict'

const {
  createStore,
  findLevelJs
} = require('../../src/utils')
const fromString = require('uint8arrays/from-string')
const toString = require('uint8arrays/to-string')

/**
 * @typedef {import('../../src/types').Migration} Migration
 * @typedef {import('interface-datastore').Datastore} Datastore
 * @typedef {import('../../src/types').MigrationProgressCallback} MigrationProgressCallback
 *
 * @typedef {{ type: 'del', key: string | Uint8Array } | { type: 'put', key: string | Uint8Array, value: Uint8Array }} Operation
 * @typedef {function (string, Uint8Array): Operation[]} UpgradeFunction
 * @typedef {function (Uint8Array, Uint8Array): Operation[]} DowngradeFunction
 */

 /**
  * @param {string} name
  * @param {Datastore} store
  * @param {(message: string) => void} onProgress
  */
async function keysToBinary (name, store, onProgress = () => {}) {
  let db = findLevelJs(store)

  // only interested in level-js
  if (!db) {
    onProgress(`${name} did not need an upgrade`)

    return
  }

  onProgress(`Upgrading ${name}`)

  /**
   * @type {UpgradeFunction}
   */
  const upgrade = (key, value) => {
    return [
      { type: 'del', key: key },
      { type: 'put', key: fromString(key), value: value }
    ]
  }

  await withEach(db, upgrade)
}

 /**
  * @param {string} name
  * @param {Datastore} store
  * @param {(message: string) => void} onProgress
  */
async function keysToStrings (name, store, onProgress = () => {}) {
  let db = findLevelJs(store)

  // only interested in level-js
  if (!db) {
    onProgress(`${name} did not need a downgrade`)

    return
  }

  onProgress(`Downgrading ${name}`)

  /**
   * @type {DowngradeFunction}
   */
  const downgrade = (key, value) => {
    return [
      { type: 'del', key: key },
      { type: 'put', key: toString(key), value: value }
    ]
  }

  await withEach(db, downgrade)
}

/**
 *
 * @param {string} repoPath
 * @param {any} repoOptions
 * @param {MigrationProgressCallback} onProgress
 * @param {*} fn
 */
async function process (repoPath, repoOptions, onProgress, fn) {
  const datastores = Object.keys(repoOptions.storageBackends)
    .filter(key => repoOptions.storageBackends[key].name === 'LevelDatastore')
    .map(name => ({
      name,
      store: createStore(repoPath, name, repoOptions)
    }))

  onProgress(0, `Migrating ${datastores.length} dbs`)
  let migrated = 0

  for (const { name, store } of datastores) {
    await store.open()

    try {
      /**
       * @param {string} message
       */
      const progress = (message) => {
        onProgress(Math.round((migrated / datastores.length) * 100), message)
      }

      await fn(name, store, progress)
    } finally {
      migrated++
      store.close()
    }
  }

  onProgress(100, `Migrated ${datastores.length} dbs`)
}

/** @type {Migration} */
module.exports = {
  version: 10,
  description: 'Migrates datastore-level keys to binary',
  migrate: (repoPath, repoOptions, onProgress = () => {}) => {
    return process(repoPath, repoOptions, onProgress, keysToBinary)
  },
  revert: (repoPath, repoOptions, onProgress = () => {}) => {
    return process(repoPath, repoOptions, onProgress, keysToStrings)
  }
}

/**
 * Uses the upgrade strategy from level-js@5.x.x - note we can't call the `.upgrade` command
 * directly because it will be removed in level-js@6.x.x and we can't guarantee users will
 * have migrated by then - e.g. they may jump from level-js@4.x.x straight to level-js@6.x.x
 * so we have to duplicate the code here.
 *
 * @param {any} db
 * @param {UpgradeFunction | DowngradeFunction} fn
 * @return {Promise<void>}
 */
function withEach (db, fn) {
  /**
   * @param {Operation[]} operations
   * @param {(error?: Error) => void} next
   */
  function batch (operations, next) {
    const store = db.store('readwrite')
    const transaction = store.transaction
    let index = 0
    /** @type {Error | undefined} */
    let error

    transaction.onabort = () => next(error || transaction.error || new Error('aborted by user'))
    transaction.oncomplete = () => next()

    function loop () {
      var op = operations[index++]
      var key = op.key

      try {
        var req = op.type === 'del' ? store.delete(key) : store.put(op.value, key)
      } catch (err) {
        error = err
        transaction.abort()
        return
      }

      if (index < operations.length) {
        req.onsuccess = loop
      }
    }

    loop()
  }

  return new Promise((resolve, reject) => {
    const it = db.iterator()
    // raw keys and values only
    /**
     * @template T
     * @param {T} data
     */
    const id = (data) => data
    it._deserializeKey = it._deserializeValue = id
    next()

    function next () {
      /**
       * @param {Error | undefined} err
       * @param {string | undefined} key
       * @param {Uint8Array} value
       */
      const handleNext = (err, key, value) => {
        if (err || key === undefined) {
          /**
           * @param {Error | undefined} err2
           */
          const handleEnd = (err2) => {
            if (err2) {
              reject(err2)
              return
            }

            resolve()
          }

          it.end(handleEnd)

          return
        }

        // @ts-ignore
        batch(fn(key, value), next)
      }
      it.next(handleNext)
    }
  })
}
