Handlers for rpc-over-ws that verify an IAP with Apple or Google and
manage a user's coin balance in Redis.

## Installation

    npm i --save rpc-virtual-bank

## Usage

    const Redis = require('ioredis')
    const redis = new Redis(process.env.REDIS_URL)

    const handlers = require('rpc-virtual-bank')({
      redis,
      products: {
        'com.foobar.product1': 100,
        'com.foobar.product2': 1000,
        ...
      },
      freeCoinsAmt: 100,
      freeCoinsAfter: 3600
    })

    require('rpc-over-ws')(handlers)

## API

    require('rpc-virtual-bank')(options)

      options
        redis: instance of ioredis.Redis
        products: keys are product ids; values are number of coins associated
        freeCoinsAmt: number of "free coins" to give out
        freeCoinsAfter: how long a user has to wait since the last time
          they collected free coins before they may collect free coins again

    verifyIAP({ platform, receipt }) -> Promise<{ balance: int }>

    getCoinStatus() -> Promise<{ balance: int, nextFreeCoinsAt: int }>

    collectFreeCoins() -> Promise<{ balance: int, nextFreeCoinsAt: int }>

      Common error: 'too soon'.

    debit({ amt: int }) -> Promise<{ balance: int }>

      Common error: 'out of coins'.

      A user's coin balance may not become negative.
