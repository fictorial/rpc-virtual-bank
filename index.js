const _ = require('lodash')
const iap = require('iap')
const EventEmitter = require('events')

module.exports = function ({redis, products, signupBonus, freeCoinsAmt, freeCoinsAfter, upgradeRedeemCoins}) {
  const emitter = new EventEmitter()

  redis.defineCommand('debit', {
    numberOfKeys: 1,
    lua: `
      local userKey = KEYS[1]
      local amt = tonumber(ARGV[1])

      if amt <= 0 then
        return redis.error_reply('invalid debit amount')
      end

      local balance = redis.call('hincrby', userKey, 'coins', -amt)
      if balance < 0 then
        redis.call('hincrby', userKey, 'coins', amt)
        return redis.error_reply('out of coins')
      end

      return balance
    `
  })

  function getProducts({}) {
    return new Promise((resolve, reject) => {
      resolve(products)
    })
  }

  function verifyIAP({ platform, receipt }) {
    if (!this.clientId)
      return Promise.reject('authentication required')

    return new Promise((resolve, reject) => {
      iap.verifyPayment(platform, {receipt}, (error, result) => {
        if (error) {
          emitter.emit('iap-rejected', this, platform, receipt, error)
          return reject(error)
        }

        const coinsPurchased = products[result.product_id]
        if (coinsPurchased === undefined) {
          const error = new Error('unknown product')
          emitter.emit('iap-rejected', this, platform, receipt, error)
          return reject(error)
        }

        redis.hincrby(`users/${this.clientId}`, 'coins', coinsPurchased)
          .then(balance => {
            emitter.emit('iap-verified', this, platform, product_id, coinsPurchased)
            resolve({balance})
          })
          .catch(error => reject(error))
      })
    })
  }

  function getCoinStatus() {
    if (!this.clientId)
      return Promise.reject('authentication required')

    const key = `users/${this.clientId}`
    return redis.hmget(key, 'coins', 'free')
      .then(results => {
        const epoch = _.now() / 1000 | 0

        // Auto register a user we haven't seen before.
        if (results[0] === null && results[1] === null) {
          return redis.hmset(key, { coins: signupBonus, free: epoch })
            .then(() => {
              return {
                balance: signupBonus,
                nextFreeCoinsAt: epoch + freeCoinsAfter
              }
            })
        }

        // Existing user; get coin status
        const balance = Math.max(0, parseInt(results[0], 10) || 0)
        const freeCoinsAt = Math.max(0, parseInt(results[1], 10) || 0)
        var nextFreeCoinsAt
        if (freeCoinsAt === 0 || freeCoinsAt + freeCoinsAfter <= epoch)
          nextFreeCoinsAt = epoch
        else
          nextFreeCoinsAt = freeCoinsAt + freeCoinsAfter
        return {balance, nextFreeCoinsAt}
      })
  }

  function collectFreeCoins() {
    if (!this.clientId)
      return Promise.reject('authentication required')

    const epoch = _.now() / 1000 | 0
    const key = `users/${this.clientId}`

    return redis.hget(key, 'free')
      .then(freeCoinsAt => {
        freeCoinsAt = Math.max(0, parseInt(freeCoinsAt, 10) || 0)
        if (freeCoinsAt === 0 || freeCoinsAt + freeCoinsAfter <= epoch) {
          return redis.pipeline()
            .hincrby(key, 'coins', freeCoinsAmt)
            .hset(key, 'free', epoch)
            .exec()
            .then(results => {
              const balance = +results[0][1]
              emitter.emit('free-coins-collected', this)
              return {balance, nextFreeCoinsAt: epoch + freeCoinsAfter}
            })
        }
        const error = new Error('too soon')
        emitter.emit('free-coins-error', this, error)
        throw error
      })
  }

  function debit({amt}) {
    if (!this.clientId)
      return Promise.reject('authentication required')

    return redis.debit(`users/${this.clientId}`, amt)
      .then(balance => {
        balance = +balance
        if (isNaN(balance))
          throw new Error('invalid-balance')
        emitter.emit('debit', this, amt)
        return {balance}
      })
      .catch(error => {
        emitter.emit('debit-error', this, amt, error)
        throw error
      })
  }

  // We have an old non-consumable product from an old version of the app.
  // Allow the user to redeem a purchase thereof once for some coins.
  // This happens if the user restores purchases in the latest version of the app.

  function didPreviouslyUpgrade({}) {
    if (!this.clientId)
      return Promise.reject('authentication required')

    return redis.hsetnx(`users/${this.clientId}`, 'didUpgrade', 1)
      .then(didSet => {
        if (!didSet)
          throw new Error('already-upgraded')

        return redis.hincrby(`users/${this.clientId}`, 'coins', upgradeRedeemCoins)
      })
      .then(balance => {
        balance = +balance
        if (isNaN(balance))
          throw new Error('invalid-balance')
        return {balance}
      })
  }

  return {
    getProducts,
    verifyIAP,
    getCoinStatus,
    collectFreeCoins,
    debit,
    didPreviouslyUpgrade,
    emitter
  }
}
