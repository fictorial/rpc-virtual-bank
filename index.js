const _ = require('lodash')
const iap = require('iap')

module.exports = function ({redis, products, freeCoinsAmt, freeCoinsAfter}) {
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

  return {
    verifyIAP: function ({ platform, receipt }) {
      if (!this.clientId)
        return Promise.reject('authentication required')

      return new Promise((resolve, reject) => {
        iap.verifyPayment(platform, {receipt}, (error, result) => {
          if (error)
            return reject(error)

          const coinsPurchased = products[result.product_id]
          if (coinsPurchased === undefined)
            return reject(new Error('unknown product'))

          redis.hincrby(`users/${this.clientId}`, 'coins', coinsPurchased)
            .then(balance => resolve({balance}))
            .catch(error => reject(error))
        })
      })
    },

    getCoinStatus: function () {
      if (!this.clientId)
        return Promise.reject('authentication required')

      return redis.hmget(`users/${this.clientId}`, 'coins', 'free')
        .then(results => {
          const balance = Math.max(0, parseInt(results[0], 10) || 0)
          const freeCoinsAt = Math.max(0, parseInt(results[1], 10) || 0)
          const epoch = _.now() / 1000 | 0
          var nextFreeCoinsAt
          if (freeCoinsAt === 0 || freeCoinsAt + freeCoinsAfter <= epoch)
            nextFreeCoinsAt = epoch
          else
            nextFreeCoinsAt = freeCoinsAt + freeCoinsAfter
          return {balance, nextFreeCoinsAt}
        })
    },

    collectFreeCoins: function () {
      if (!this.clientId)
        return Promise.reject('authentication required')

      const epoch = _.now() / 1000 | 0

      return redis.hget(`users/${this.clientId}`, 'free')
        .then(freeCoinsAt => {
          freeCoinsAt = Math.max(0, parseInt(freeCoinsAt, 10) || 0)
          if (freeCoinsAt === 0 || freeCoinsAt + freeCoinsAfter <= epoch) {
            redis.pipeline()
              .hincrby(key, 'coins', freeCoinsAmt)
              .hset(key, 'free', epoch)
              .exec()
              .then(results => {
                const newBal = +results[0][1]
                return {balance: newBal, nextFreeCoinsAt: epoch + freeCoinsAfter}
              })
              .catch(reject)
          } else {
            reject('too soon')
          }
        })
    },

    debit: function ({amt}) {
      if (!this.clientId)
        return Promise.reject('authentication required')

      return redis.debit(`users/${this.clientId}`, amt)
        .then(balance => {balance})
    }
  }
}
