'use strict';

var platform = require('os').platform();
var path = require('path');
var url = require('url');
var assert = require('assert');
var merge = require('merge');
var async = require('async');
var kad = require('kad');
var ms = require('ms');
var bitcore = require('bitcore-lib');
var constants = require('../constants');
var Message = require('bitcore-message');
var Quasar = require('kad-quasar');
var utils = require('../utils');
var KeyPair = require('../keypair');
var Manager = require('../manager');
var StorageItem = require('../storage/item');
var Protocol = require('./protocol');
var Contract = require('../contract');
var Audit = require('../audit');
var Verification = require('../verification');

var HOME = platform !== 'win32' ? process.env.HOME : process.env.USER_PROFILE;

/**
 * Storj network interface
 * @constructor
 * @param {Object} options
 * @param {KeyPair} options.keypair
 * @param {Manager} options.manager
 * @param {Number} options.loglevel
 * @param {Array} options.seeds
 * @param {String} options.datadir
 * @param {Object} options.contact
 * @param {String} options.contact.address
 * @param {Number} options.contact.port
 * @param {Boolean} options.farmer
 */
function Network(options) {
  if (!(this instanceof Network)) {
    return new Network(options);
  }

  assert(options.keypair instanceof KeyPair, 'Invalid keypair supplied');
  assert(options.manager instanceof Manager, 'Invalid manager supplied');

  this._pendingContracts = {};
  this._keypair = options.keypair;
  this._manager = options.manager;
  this._options = merge(Object.create(Network.DEFAULTS), options);
  this._logger = new kad.Logger(this._options.loglevel, 'storjnode');
  this._contact = new kad.contacts.AddressPortContact(
    merge(this._options.contact, { nodeID: this._keypair.getNodeID() })
  );
  this._transport = new kad.transports.HTTP(this._contact, {
    logger: this._logger,
    cors: true
  });
  this._router = new kad.Router({
    transport: this._transport,
    logger: this._logger
  });
  this._pubsub = new Quasar(this._router, { logger: this._logger });

  if (this._options.datadir) {
    this._storage = new kad.storage.FS(
      path.join(this._options.datadir, 'items')
    );
  } else {
    this._storage = new kad.storage.MemStore();
  }

  this._pubkeys = {};
  this._open = false;
}

Network.DEFAULTS = {
  loglevel: 3,
  seeds: [],
  datadir: path.join(HOME, '.storjnode'),
  contact: {
    address: '127.0.0.1',
    port: 4000,
  },
  farmer: false
};

/**
 * Opens the connection to the network
 * @param {Function} callback
 */
Network.prototype.join = function(callback) {
  var self = this;
  var seeds = this._options.seeds.map(this._createContact);
  var protocol = new Protocol({ network: this });

  assert(!this._open, 'Network interface already open');

  this._transport.on('error', this._handleTransportError.bind(this));
  this._transport.before('serialize', this._signMessage.bind(this));
  this._transport.before('receive', this._verifyMessage.bind(this));
  this._transport.before('receive', kad.hooks.protocol(protocol.handlers()));

  this._node = new kad.Node({
    transport: this._transport,
    router: this._router,
    storage: this._storage,
    logger: this._logger
  });

  this._open = true;

  async.each(seeds, function(contact, next) {
    self._node.connect(contact, function(err) {
      if (!err) {
        self._addPingInterval(contact, ms('1m'));
      }
    });
    next();
  }, function(err) {
    if (err) {
      return callback(err);
    }

    if (self._options.farmer) {
      self._farm();
    }

    callback(null, self);
  });
};

/**
 * Disconnects from the network
 * @param {Function} callback
 */
Network.prototype.leave = function(callback) {
  this._removePingInterval();
  this._node.disconnect(callback);
};

/**
 * Look up the storage contract by the hash to find the node who has
 * the shard. Look up the appropriate challenge and send it to the node
 * for verification. If successful, invalidate the challenge and pass,
 * otherwise, invalidate the contract.
 * @param {String} hash
 * @param {Function} callback
 */
Network.prototype.audit = function(hash, callback) {
  var self = this;

  self._manager.load(hash, function(err, item) {
    if (err) {
      return callback(err);
    }

    // TODO: Be smarter about which contract holder we choose if there is more
    // TODO: than a single farmer holding our shard.
    var farmerID = Object.keys(item.contracts)[0];

    self._router.findNode(farmerID, function(err, nodes) {
      if (err) {
        return callback(err);
      }

      var farmer = nodes.filter(function(node) {
        return node.nodeID === farmerID;
      })[0];

      if (!farmer) {
        return callback(new Error('Could not find the farmer'));
      }

      var audit = item.challenges[farmer.nodeID];
      var message = new kad.Message({
        method: 'AUDIT',
        params: {
          data_hash: hash,
          challenge: audit.challenges[0],
          contact: self._contact
        }
      });

      self._transport.send(farmer, message, function(err, response) {
        if (err) {
          return callback(err);
        }

        if (response.error) {
          return callback(new Error(response.error.message));
        }

        if (!response.result.proof) {
          return callback(new Error('Invalid proof returned'));
        }

        var verification = new Verification(response.result.proof);

        callback(null, verification.verify(audit.root, audit.depth));
      });
    });
  });
};

/**
 * Look up the storage contract by the hash to find the node who has
 * the shard, then execute a RETRIEVE RPC to the node and return the
 * data as a buffer.
 * @param {String} hash
 * @param {Function} callback
 */
Network.prototype.retrieve = function(hash, callback) {
  var self = this;

  self._manager.load(hash, function(err, item) {
    if (err) {
      return callback(err);
    }

    // TODO: Be smarter about which contract holder we choose if there is more
    // TODO: than a single farmer holding our shard.
    var farmerID = Object.keys(item.contracts)[0];

    self._router.findNode(farmerID, function(err, nodes) {
      if (err) {
        return callback(err);
      }

      var farmer = nodes.filter(function(node) {
        return node.nodeID === farmerID;
      })[0];

      if (!farmer) {
        return callback(new Error('Could not find the farmer'));
      }

      var message = new kad.Message({
        method: 'RETRIEVE',
        params: { data_hash: hash, contact: self._contact }
      });

      self._transport.send(farmer, message, function(err, response) {
        if (err) {
          return callback(err);
        }

        if (response.error) {
          return callback(new Error(response.error.message));
        }

        if (!response.result.data_shard) {
          return callback(new Error('Invalid shard returned'));
        }

        callback(null, new Buffer(response.result.data_shard, 'hex'));
      });
    });
  });
};

/**
 * Create a contract from the data and options supplied and publish it
 * on the network. Keep track of the pending contract until it becomes
 * fulfilled by an OFFER, then issue a CONSIGN RPC to the offerer and
 * callback when the data is stored.
 * @param {Buffer} data
 * @param {String} duration - String representation of time for `ms` like "2w"
 * @param {Function} callback
 */
Network.prototype.store = function(data, duration, callback) {
  assert(Buffer.isBuffer(data), 'Invalid data supplied');
  assert(typeof duration === 'string', 'Invalid duration supplied');
  assert(typeof callback === 'function', 'Callback is not a function');

  data = new Buffer(data.toString('hex'), 'hex');

  var self = this;
  var shardHash = utils.rmd160sha256(data);
  var contract = new Contract({
    renter_id: this._keypair.getNodeID(),
    data_size: data.length,
    data_hash: shardHash,
    store_begin: Date.now(),
    store_end: Date.now() + ms(duration),
    audit_count: 12 // TODO: Make this configurable
  });
  var audit = new Audit({ audits: 12, shard: data });

  // Store a reference to this contract as a function to issue a CONSIGN
  this._pendingContracts[shardHash] = function(farmer) {
    var message = new kad.Message({
      method: 'CONSIGN',
      params: {
        data_hash: contract.get('data_hash'),
        data_shard: data.toString('hex'),
        audit_tree: audit.getPublicRecord(),
        contact: self._contact
      }
    });

    self._transport.send(farmer, message, function(err, response) {
      if (err) {
        return callback(err);
      }

      if (response.error) {
        return callback(new Error(response.error.message));
      }

      self._manager.load(shardHash, function(err, item) {
        if (err) {
          item = new StorageItem({ hash: shardHash });
        }

        item.contracts[farmer.nodeID] = contract;
        item.trees[farmer.nodeID] = audit.getPublicRecord();
        item.challenges[farmer.nodeID] = audit.getPrivateRecord();
        item.meta[farmer.nodeID] = {};

        self._manager.save(item, function(err) {
          if (err) {
            return callback(err);
          }

          callback(null, shardHash);
        });
      });
    });
  };

  self._publish(Contract.DEFAULTS.type, contract);
};

/**
 * Subscribes to all storage contracts and issues offers, for now this just
 * accepts the initial offer and signs it
 */
Network.prototype._farm = function() {
  var self = this;

  // TODO: Refactor all of this.

  self._subscribe(Contract.DEFAULTS.type, function(contract) {
    contract.set('farmer_id', self._keypair.getNodeID());
    contract.set('payment_destination', self._keypair.getAddress());
    contract.sign('farmer', self._keypair.getPrivateKey());

    var final;

    self._router.findNode(contract.get('renter_id'), function(err, nodes) {
      if (err) {
        return false;
      }

      var renter = nodes.filter(function(node) {
        return node.nodeID === contract.get('renter_id');
      })[0];

      if (!renter) {
        return false;
      }

      var message = new kad.Message({
        method: 'OFFER',
        params: {
          contract: contract.toObject(),
          contact: self._contact
        }
      });

      self._transport.send(renter, message, function(err, response) {
        if (err) {
          return false;
        }

        if (response.error || !response.result.contract) {
          return false;
        }

        try {
          final = Contract.fromObject(response.result.contract);
        } catch (err) {
          return false;
        }

        if (!final.verify('renter', contract.get('renter_id'))) {
          return false;
        }

        self._manager.load(contract.get('data_hash'), function(err, item) {
          if (err) {
            item = new StorageItem({ hash: contract.get('data_hash') });
          }

          item.contracts[renter.nodeID] = contract.toObject();
          item.meta[renter.nodeID] = {};

          self._manager.save(item, function() {});
        });
      });
    });
  });
};

/**
 * Publishes a contract to the network
 * @private
 * @param {String} identifier
 * @param {Contract} contract
 */
Network.prototype._publish = function(identifier, contract) {
  assert(contract instanceof Contract, 'Invalid contract supplied');
  return this._pubsub.publish(identifier, contract.toObject());
};

/**
 * Subscribes to a contract identifier on the network
 * @private
 * @param {String} identifier
 * @param {Function} handler
 */
Network.prototype._subscribe = function(identifier, handler) {
  return this._pubsub.subscribe(identifier, function(contract) {
    var contractObj;

    try {
      contractObj = Contract.fromObject(contract);
    } catch (err) {
      return false; // If the contract is invalid just drop it
    }

    handler(contractObj);
  });
};

/**
 * Connects to the node at the given URI
 * @private
 * @param {String} uri
 * @param {Function} callback
 */
Network.prototype._connect = function(uri, callback) {
  return this._node.connect(this._createContact(uri), callback);
};

/**
 * Returns a Storj contact from the URI
 * @private
 * @param {String} uri
 */
Network.prototype._createContact = function(uri) {
  var parsed = url.parse(uri);

  return new kad.contacts.AddressPortContact({
    address: parsed.hostname,
    port: Number(parsed.port),
    nodeID: parsed.path.substr(1)
  });
};

/**
 * Signs an outgoing message
 * @private
 * @param {kad.Message} message
 * @param {Function} callback
 */
Network.prototype._signMessage = function(message, callback) {
  var nonce = Date.now();
  var target = message.id + nonce;
  var signature = Message(target).sign(this._keypair._privkey);

  if (kad.Message.isRequest(message)) {
    message.params.__nonce = nonce;
    message.params.__signature = signature;
  } else {
    message.result.__nonce = nonce;
    message.result.__signature = signature;
  }

  callback();
};

/**
 * Verifies an incoming message
 * @private
 * @param {kad.Message} message
 * @param {Contact} contact
 * @param {Function} callback
 */
Network.prototype._verifyMessage = function(message, contact, callback) {
  var nonce, signature;

  if (kad.Message.isRequest(message)) {
    nonce = message.params.__nonce;
    signature = message.params.__signature;
  } else {
    nonce = message.result.__nonce;
    signature = message.result.__signature;
  }

  if (Date.now() > (constants.NONCE_EXPIRE + nonce)) {
    return callback(new Error('Message signature expired'));
  }

  var target = message.id + nonce;
  var addr = bitcore.Address.fromPublicKeyHash(Buffer(contact.nodeID, 'hex'));
  var compactSig = new Buffer(signature, 'base64');
  var signobj = bitcore.crypto.Signature.fromCompact(compactSig);
  var signedmsg = Message(target);
  var ecdsa = new bitcore.crypto.ECDSA();

  ecdsa.hashbuf = signedmsg.magicHash();
  ecdsa.sig = signobj;

  this._pubkeys[contact.nodeID] = ecdsa.toPublicKey();

  if (!signedmsg.verify(addr, signature)) {
    return callback(new Error('Signature verification failed'));
  }

  callback();
};

/**
 * Proxies error events from the underlying transport adapter
 * @private
 * @param {Error} error
 */
Network.prototype._handleTransportError = function(error) {
  this._logger.error(error.message);
};

/**
 * Setup a PING message to the given contact on an interval
 * @private
 * @param {Contact} contact
 * @param {Number} interval
 */
Network.prototype._addPingInterval = function(contact, interval) {
  assert(typeof interval === 'number', 'Invalid interval supplied');

  var self = this;

  if (!this._pingSeeds) {
    this._pingSeeds = {};
  }

  function pingSeed() {
    self._transport.send(contact, new kad.Message({
      method: 'PING',
      params: { contact: self._node._self }
    }));
  }

  this._pingSeeds[contact.nodeID] = setInterval(pingSeed, interval);
};

/**
 * Stop sending PING message to the given contact
 * @private
 * @param {Contact} contact
 */
Network.prototype._removePingInterval = function(contact) {
  if (!contact) {
    for (var nodeID in this._pingSeeds) {
      clearInterval(this._pingSeeds[nodeID]);
    }
  } else {
    clearInterval(this._pingSeeds[contact.nodeID]);
  }
};

module.exports = Network;