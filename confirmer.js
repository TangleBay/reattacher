const { asTransactionObject, asTransactionTrytes } = require('@iota/transaction-converter');
const bundleValidator = require('@iota/bundle-validator');
const { composeAPI } = require('@iota/core')
const { asciiToTrytes } = require('@iota/converter')
const zmq = require("zeromq")

const iota = composeAPI({
  provider: 'https://swarm.tanglebay.org'
})
let promoteaddress = 'CONFIRMER9CONFIRMER9CONFIRMER9CONFIRMER9CONFIRMER9CONFIRMER9CONFIRMER9CONFIRMER99'
let promotetag = 'CONFIRMER'
let promotemessage = asciiToTrytes('CONFIRMER')

//replace in original txs
//don't replace if replacetag = ''
let replacetag = 'TB9CONFIRMER'
//a random message from the array will be used, don't replace if replaymessages = []
let replaymessages = []
let transfers = [{
  value: 0,
  address: promoteaddress,
  message: promotemessage,
  tag: promotetag
}]

let tcpNodes = ["tcp://node04.iotatoken.nl:5556", "tcp://db.iota.partners:5556"]
let latestMilestone = ''
let bundles = {}
let reattachedTails = []
let reattachmentIntervall = 90000
let maxReattachTries = 10
let blockedTags = ['ANDROID9WALLET9TRANSFER9999', 'THE9IOTA9MIXER9BETA99999999', 'TANGLE9BEAT9999999999999999', 'IOTA9FAUCET9999999999999999', 'MINEIOTA9JACKPOT99999999999', 'MINEIOTADOTCOM9999999999999']
let blockedAddresses = ['KSNWNNLGLHIBVFMULCEXDQLXMGGVKLACPPDNKSQYLBPPHISXGCNDZHEGCTQII9PRMRB9TXTBZ9BZTOSGW']
let maxBundleSize = 20
let amountPromoteTxs = 14

let cacheSize = 50
let bundleCache = []

async function listen() {
  const sock = new zmq.Subscriber
  for (node of tcpNodes) {
    sock.connect(node)
  }
  sock.subscribe("lmhs")
  sock.subscribe("tx")

  for await (const msg of sock) {
    const data = msg.toString().split(' ')
    switch (
    data[0]
    ) {
      case 'lmhs': latestMilestone = data[1]
        // console.log("New milestone", latestMilestone);
        break
      case 'tx':
        if (data[6] == 0 && blockedTags.indexOf(data[12]) == -1 && blockedAddresses.indexOf(data[2]) == -1) {
          //value != 0; index == 0; bundlesize <= maxBundleSize; check if not already known
          if (data[3] != 0 && data[6] == 0 && data[7] < maxBundleSize && !(data[8] in bundles)) {
            //filter already known bundles
            if (bundleCache.indexOf(data[8]) == -1) {
              bundleCache.push(data[8])
              if (bundleCache.length > cacheSize) {
                bundleCache.shift();
              }
              checkBundleInputs(data[1])
            }
          }
        }
    }
  }
}
listen()

function sortBundle(txObjects) {
  let filtered = txObjects.filter((obj, index, self) =>
    index === self.findIndex((t) => (
      t.currentIndex === obj.currentIndex
    ))
  )
  filtered.sort((a, b) => {
    return a.currentIndex - b.currentIndex;
  });
  return filtered
}

async function checkBundleInputs(txhash) {
  try {
    //wait half a second so nodes have the time to process the tx
    await new Promise(resolve => setTimeout(resolve, 500));
    let txObject = await iota.getTransactionObjects([txhash]);
    if(txObject[0].value == 0){
      console.log(`Bundle for ${txhash} not found`);
      return
    }
    let bundleObjects = await iota.findTransactionObjects({ bundles: [txObject[0].bundle] })
    let sortedBundle = sortBundle(bundleObjects)
    //validate bundle
    if (bundleValidator.default(sortedBundle)) {
      // console.log("valid bundle", txObject[0].bundle);
    } else {
      // console.log("invalid bundle https://thetangle.org/bundle/" + txObject[0].bundle);
      return
    }
    for (let index = 0; index < sortedBundle.length; index++) {
      if (sortedBundle[index].value < 0) {
        if (blockedAddresses.indexOf(sortedBundle[index].address) != -1) {
          // console.log("Blocked address found", txhash);
          return
        }
        let { balances } = await iota.getBalances([sortedBundle[index].address], 100)
        if (Math.abs(balances[0]) < Math.abs(sortedBundle[index].value)) {
          // console.log('Balance to send: ' + sortedBundle[index].value + ', available: ' + balances[0])
          // console.log('Not enough balance at ' + sortedBundle[index].address)
          return
        }
      }
    }
    console.log("New bundle to reattach: https://thetangle.org/bundle/" + sortedBundle[0].bundle);
    let bundleTrytes = sortedBundle.map(tx => asTransactionTrytes(tx))
    bundles[sortedBundle[0].bundle] = { bundlehash: sortedBundle[0].bundle, trytes: bundleTrytes.reverse(), lastTime: 0, tries: 0 }
  } catch (err) {
    console.log("checkBundleInputs:", err);
  }
}

async function spam() {
  while (true) {
    try {
      //await timeout so it doesn't block
      await new Promise(resolve => setTimeout(resolve, 10));
      //wait for milestone
      if (latestMilestone == '') {
        continue
      }
      for (let [bundlehash, bundle] of Object.entries(bundles)) {
        try {
          if (Date.now() - bundle.lastTime < reattachmentIntervall) {
            // console.log("don't reattach, wait");
            continue
          } {
            if (bundle.tries > maxReattachTries) {
              console.log("maxReattachTries reached for", bundlehash);
              delete bundles[bundlehash]
              continue
            }
            bundles[bundlehash].tries++
            // console.log("reattach after s:" + (Date.now() - bundle.lastTime) / 1000);
          }
          let bundleObjects = await iota.findTransactionObjects({
            bundles: [bundlehash],
          })
          let allTailTxsofBundle = bundleObjects
            .filter((tx) => tx.currentIndex == 0)
            .map((tx) => tx.hash)
          let inclusionStates = await iota.getLatestInclusion(allTailTxsofBundle)
          if (inclusionStates.indexOf(true) == -1) {
            //reattach
            let tail = await reattach(bundle.trytes)
            if(typeof tail != 'undefined'){
              await sendPromoteTxs(tail, amountPromoteTxs)
            }
            //update time
            bundles[bundlehash].lastTime = Date.now()
            //wait 1s per tx ()
            // console.log("wait seconds: " + (bundleObjects[0].lastIndex + 1));
            await new Promise(resolve => setTimeout(resolve, (bundleObjects[0].lastIndex + 1) * 1000));
          } else {
            console.log("Bundle confirmed: https://thetangle.org/bundle/" + bundlehash);
            delete bundles[bundlehash]
            console.log("Unconfirmed bundles: ", Object.keys(bundles));
          }
        } catch (e) {
          console.log('Problem with reattachment', e)
        }
      }
    } catch (e) {
      console.log("spam:", e)
    }
  }
}
spam()

async function reattach(trytes) {
  try {
    //change txs
    trytes = await trytes.map(trytes => {
      //replace tag and nonce
      if (replacetag != '') {
        let tag = (replacetag + '9'.repeat(27)).slice(0, 27)
        trytes = trytes.slice(0, 2592) + tag + trytes.slice(2619, 2646) + tag
      }
      //replace empty messages
      if (trytes.slice(0, 2187) == '9'.repeat(2187) && replaymessages.length != 0) {
        let message = asciiToTrytes(replaymessages[Math.floor(Math.random() * replaymessages.length)]) + '9'.repeat(2178)
        trytes = message.slice(0, 2187) + trytes.slice(2187, 2673)
      }
      return trytes
    })
    let attachedTrytes = await iota.attachToTangle(latestMilestone, latestMilestone, 14, trytes)
    await iota.storeAndBroadcast(attachedTrytes)
    let tailtx = attachedTrytes.map(tx => asTransactionObject(tx)).filter(t => t.currentIndex == 0)[0].hash
    reattachedTails.push(tailtx)
    if (reattachedTails.length > 2) {
      reattachedTails.shift()
    }
    console.log('Reattached tx: https://thetangle.org/transaction/' + tailtx)
    return tailtx
  } catch (e) {
    console.error("reattach", e)
  }
}

async function sendPromoteTxs(txhash, amount) {
  try {
    let trytes = await iota.prepareTransfers(promoteaddress, transfers)
    if (amount < 5) {
      if (amount % 2 == 0) {
        tips = await iota.getTransactionsToApprove(3)
        attachedTrytes = await iota.attachToTangle(txhash, tips.branchTransaction, 14, trytes)
      } else {
        attachedTrytes = await iota.attachToTangle(txhash, tips.trunkTransaction, 14, trytes)
      }
    } else {
      attachedTrytes = await iota.attachToTangle(txhash, latestMilestone, 14, trytes)
    }
    await iota.storeAndBroadcast(attachedTrytes)
    if (amount == amountPromoteTxs) {
      console.log('First promotetx: https://thetangle.org/transaction/' + asTransactionObject(attachedTrytes[0]).hash)
    }
    amount--
    if (amount > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await sendPromoteTxs(txhash, amount)
    }
  } catch (e) {
    console.log("sendPromoteTxs", e)
  }
}
