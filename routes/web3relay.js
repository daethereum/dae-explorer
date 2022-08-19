#!/usr/bin/env node

/*
    Endpoint for client to talk to etc node
*/

const Web3 = require('web3');
const web3explorer = require('web3-explorer');

let web3;

const _ = require('lodash');
const BigNumber = require('bignumber.js');

const etherUnits = require(`${__lib}etherUnits.js`);

require('../db.js');
const mongoose = require('mongoose');

const Block = mongoose.model('Block');
const Transaction = mongoose.model('Transaction');
const Market = mongoose.model('Market');

const { getLatestBlocks } = require('./index');
const { filterBlocks } = require('./filters');
const { filterTrace } = require('./filters');

/*Start config for node connection and sync*/
// load config.json
const config = { nodeAddr: 'localhost', wsPort: 8546 };
try {
  var local = require('../config.json');
  _.extend(config, local);
  console.log('config.json found.');
} catch (error) {
  if (error.code === 'MODULE_NOT_FOUND') {
    var local = require('../config.example.json');
    _.extend(config, local);
    console.log('No config file found. Using default configuration... (config.example.json)');
  } else {
    throw error;
    process.exit(1);
  }
}

//Create Web3 connection
console.log(`Connecting ${config.nodeAddr}:${config.wsPort}...`);

//web3 = new Web3(new Web3.providers.WebsocketProvider());

const newProvider = () => new Web3.providers.WebsocketProvider(`ws://${config.nodeAddr}:${config.wsPort}`, {
  reconnect: {
    auto: true,
    delay: 2000, // ms
    maxAttempts: 5,
    onTimeout: false,
  },
})

web3 = new Web3(newProvider())

const checkActive = () => {
  if (!web3.currentProvider.connected) {
    web3.setProvider(newProvider())
  }
}
if (typeof window !== 'undefined') {
  setInterval(checkActive, 2000)
  window.addEventListener('focus', checkActive)
}


if (web3.eth.net.isListening()) console.log('Web3 connection established');
else throw 'No connection, please specify web3host in conf.json';

async function detectNode() {
  const nodeInfo = await web3.eth.getNodeInfo();

  if (nodeInfo.split('/')[0].toLowerCase().includes('parity')) {
    console.log('Web3 has detected parity node configuration');
    web3explorer(web3);
  }
  console.log(`Node version = ${nodeInfo}`);
}
detectNode();

exports.data = async (req, res) => {
  console.log(req.body);

  if ('tx' in req.body) {
    var txHash = req.body.tx.toLowerCase();
    if (!web3.currentProvider.connected) {
      web3.setProvider(newProvider())
    }
    Transaction.findOne({ hash: txHash }).lean(true).exec(async (err, doc) => {
      if (err || !doc) {
        web3.eth.getTransaction(txHash, (err, tx) => {
          if (err || !tx) {
            console.error(`TxWeb3 error :${err}`);
            if (!tx) {
              web3.eth.getBlock(txHash, (err, block) => {
                if (err || !block) {
                  console.error(`BlockWeb3 error :${err}`);
                  res.write(JSON.stringify({ 'error': true }));
                } else {
                  console.log(`BlockWeb3 found: ${txHash}`);
                  res.write(JSON.stringify({ 'error': true, 'isBlock': true }));
                }
                res.end();
              });
            } else {
              res.write(JSON.stringify({ 'error': true }));
              res.end();
            }
          } else {
            const ttx = tx;
            ttx.value = etherUnits.toEther(new BigNumber(tx.value), 'wei');
            //get TxReceipt status & gasUsed
            web3.eth.getTransactionReceipt(txHash, (err, receipt) => {
              if (err) {
                console.error(err);
                return;
              }
              ttx.gasUsed = receipt.gasUsed;
              if (receipt.status) {
                ttx.status = receipt.status;
              }
              if (!tx.to && !tx.creates) {
                if (receipt && receipt.contractAddress) {
                  ttx.creates = receipt.contractAddress;
                }
              }
            });
            //get timestamp from block
            const block = web3.eth.getBlock(tx.blockNumber, (err, block) => {
              if (!err && block) ttx.timestamp = block.timestamp;
              ttx.isTrace = (ttx.input != '0x');
              txResponse = ttx;
            });
          }
        });
      } else {
        txResponse = doc;
      }

      const latestBlock = await web3.eth.getBlockNumber() + 1;

      txResponse.confirmations = latestBlock - txResponse.blockNumber;

      if (txResponse.confirmations === latestBlock) {
        txResponse.confirmation = 0;
      }
      txResponse.gasPriceGwei = etherUnits.toGwei(new BigNumber(txResponse.gasPrice), 'wei');
      txResponse.gasPriceEther = etherUnits.toEther(new BigNumber(txResponse.gasPrice), 'wei');
      txResponse.txFee = txResponse.gasPriceEther * txResponse.gasUsed;

      if (config.settings.useFiat) {
        const latestPrice = await Market.findOne().sort({ timestamp: -1 });
        txResponse.txFeeUSD = txResponse.txFee * latestPrice.quoteUSD;
        txResponse.valueUSD = txResponse.value * latestPrice.quoteUSD;
      }

      res.write(JSON.stringify(txResponse));
      res.end();
    });
  } else if ('tx_send' in req.body) {
    let rawTx = req.body.tx_send.toLowerCase();
    rawTx = rawTx.substring(0, 2) === '0x' ? rawTx : `0x${rawTx}`;
    web3.eth.sendSignedTransaction(rawTx.toString('hex'))
      .on('transactionHash', (hash) => {
        res.json({
          success: true,
          hash,
        });
      })
      .on('error', (error) => {
        const stringError = String(error);
        let reason = '';
        if (stringError.includes('invalid argument')) {
          reason = 'Error: Returned error: invalid argument 0: json: cannot unmarshal invalid hex string into Go value of type hexutil.Bytes'
        } else if (stringError.includes('invalid sender')) {
          reason = 'Error: Returned error: invalid sender'
        }
        res.json({
          success: false,
          reason,
        });
      });

  } else if ('tx_trace' in req.body) {
    var txHash = req.body.tx_trace.toLowerCase();

    web3.trace.transaction(txHash, (err, tx) => {
      if (err || !tx) {
        console.error(`TraceWeb3 error :${err}`);
        res.write(JSON.stringify({ 'error': true }));
      } else {
        res.write(JSON.stringify(filterTrace(tx)));
      }
      res.end();
    });
  } else if ('addr_trace' in req.body) {
    var addr = req.body.addr_trace.toLowerCase();
    // need to filter both to and from
    // from block to end block, paging "toAddress":[addr],
    // start from creation block to speed things up
    // TODO: store creation block
    const filter = { 'fromBlock': '0x1d4c00', 'toAddress': [addr] };
    web3.trace.filter(filter, (err, tx) => {
      if (err || !tx) {
        console.error(`TraceWeb3 error :${err}`);
        res.write(JSON.stringify({ 'error': true }));
      } else {
        res.write(JSON.stringify(filterTrace(tx)));
      }
      res.end();
    });
  } else if ('addr' in req.body) {
    var addr = req.body.addr.toLowerCase();
    const { options } = req.body;

    let addrData = {};

    if (options.indexOf('balance') > -1) {
      try {
        addrData['balance'] = await web3.eth.getBalance(addr);
        addrData['balance'] = etherUnits.toEther(addrData['balance'], 'wei');
      } catch (err) {
        console.error(`AddrWeb3 error :${err}`);
        addrData = { 'error': true };
      }
    }
    if (options.indexOf('count') > -1) {
      try {
        addrData['count'] = await web3.eth.getTransactionCount(addr);
      } catch (err) {
        console.error(`AddrWeb3 error :${err}`);
        addrData = { 'error': true };
      }
    }
    if (options.indexOf('bytecode') > -1) {
      try {
        addrData['bytecode'] = await web3.eth.getCode(addr);
        if (addrData['bytecode'].length > 2) addrData['isContract'] = true;
        else addrData['isContract'] = false;
      } catch (err) {
        console.error(`AddrWeb3 error :${err}`);
        addrData = { 'error': true };
      }
    }

    if (config.settings.useFiat) {
      const latestPrice = await Market.findOne().sort({ timestamp: -1 });
      addrData['balanceUSD'] = addrData.balance * latestPrice.quoteUSD;
    }

    res.write(JSON.stringify(addrData));
    res.end();
  } else if ('block' in req.body) {
    var blockNumOrHash;
    if (/^(0x)?[0-9a-f]{64}$/i.test(req.body.block.trim())) {
      blockNumOrHash = req.body.block.toLowerCase();
    } else {
      blockNumOrHash = parseInt(req.body.block);
    }

    Block.findOne({ $or: [{ hash: blockNumOrHash }, { number: blockNumOrHash }] },
      { '_id': 0 }).lean(true).exec('findOne', (err, doc) => {
      if (err || !doc) {
        if (!web3.currentProvider.connected) {
          web3.setProvider(newProvider())
        }
        web3.eth.getBlock(blockNumOrHash, (err, block) => {
          if (err || !block) {
            if (!web3.currentProvider.connected) {
              web3.setProvider(newProvider())
            }
            web3.eth.getBlock(blockNumOrHash, (err, block) => {
              if (err || !block) {

                console.error(`BlockWeb3 error :${err}`);
                res.write(JSON.stringify({ 'error': true }));
              } else {
                res.write(JSON.stringify(filterBlocks(block)));
              }
              res.end();
            });
          } else {
            res.write(JSON.stringify(filterBlocks(block)));
          }
          res.end();
        });
      } else {
        Transaction.find({ blockNumber: doc.number }).distinct('hash', (err, txs) => {
          doc['transactions'] = txs;
          res.write(JSON.stringify(filterBlocks(doc)));
          res.end();
        });
      }
    });

    /*
    / TODO: Refactor, "block" / "uncle" determinations should likely come later
    / Can parse out the request once and then determine the path.
    */
  } else if ('uncle' in req.body) {
    const uncle = req.body.uncle.trim();
    const arr = uncle.split('/');
    var blockNumOrHash; // Ugly, does the same as blockNumOrHash above
    const uncleIdx = parseInt(arr[1]) || 0;

    if (/^(?:0x)?[0-9a-f]{64}$/i.test(arr[0])) {
      blockNumOrHash = arr[0].toLowerCase();
      console.log(blockNumOrHash);
    } else {
      blockNumOrHash = parseInt(arr[0]);
    }

    if (typeof blockNumOrHash === 'undefined') {
      console.error(`UncleWeb3 error :${err}`);
      res.write(JSON.stringify({ 'error': true }));
      res.end();
      return;
    }

    web3.eth.getBlock(blockNumOrHash, uncleIdx, (err, uncle) => {
      if (err || !uncle) {
        console.error(`UncleWeb3 error :${err}`);
        res.write(JSON.stringify({ 'error': true }));
      } else {
        res.write(JSON.stringify(filterBlocks(uncle)));
      }
      res.end();
    });

  } else if ('action' in req.body) {
    if (req.body.action == 'hashrate') {
      web3.eth.getBlock('latest', (err, latest) => {
        if (err || !latest) {
          if (!web3.currentProvider.connected) {
             web3.setProvider(newProvider())
          }
          web3.eth.getBlock('latest', (err, latest) => {
            if (err || !latest) {
              console.error(`StatsWeb3 error :${err}`);
              res.write(JSON.stringify({ 'error': true }));
              res.end();
            } else {
              console.log(`StatsWeb3: latest block 2: ${latest.number}`);
              let checknum = latest.number - 100;
              if (checknum < 0) checknum = 0;
              const nblock = latest.number - checknum;
              web3.eth.getBlock(checknum, (err, block) => {
                if (err || !block) {
                  console.error(`StatsWeb3 error 2 :${err}`);
                  res.write(JSON.stringify({
                    'blockHeight': latest.number, 'difficulty': latest.difficulty, 'blockTime': 0, 'hashrate': 0,
                  }));
                } else {
                  console.log(`StatsWeb3: check block 2: ${block.number}`);
                  const blocktime = (latest.timestamp - block.timestamp) / nblock;
                  const hashrate = latest.difficulty / blocktime;
                  res.write(JSON.stringify({
                    'blockHeight': latest.number, 'difficulty': latest.difficulty, 'blockTime': blocktime, 'hashrate': hashrate,
                  }));
                }
                res.end();
              });
            }
          });
        } else {
          console.log(`StatsWeb3: latest block: ${latest.number}`);
          let checknum = latest.number - 100;
          if (checknum < 0) checknum = 0;
          const nblock = latest.number - checknum;
          web3.eth.getBlock(checknum, (err, block) => {
            if (err || !block) {
              console.error(`StatsWeb3 error :${err}`);
              res.write(JSON.stringify({
                'blockHeight': latest.number, 'difficulty': latest.difficulty, 'blockTime': 0, 'hashrate': 0,
              }));
            } else {
              console.log(`StatsWeb3: check block: ${block.number}`);
              const blocktime = (latest.timestamp - block.timestamp) / nblock;
              const hashrate = latest.difficulty / blocktime;
              res.write(JSON.stringify({
                'blockHeight': latest.number, 'difficulty': latest.difficulty, 'blockTime': blocktime, 'hashrate': hashrate,
              }));
            }
            res.end();
          });
        }
      });
    } else {
      console.error(`Invalid Request: ${action}`);
      res.status(400).send();
    }
  } else {
    console.error(`Invalid Request: ${action}`);
    res.status(400).send();
  }

};

exports.eth = web3.eth;
