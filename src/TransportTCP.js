"use strict";
const net = require('net');
/**
 * @fileoverview Transport
 */

/**
 * @augments SIP
 * @class Transport
 * @param {SIP.UA} ua
 * @param {Object} server tcp_server Object
 */
module.exports = function (SIP, Socket) {
var Transport,
  C = {
    // Transport status codes
    STATUS_READY:        0,
    STATUS_DISCONNECTED: 1,
    STATUS_ERROR:        2
  };

/**
 * Compute an amount of time in seconds to wait before sending another
 * keep-alive.
 * @returns {Number}
 */
function computeKeepAliveTimeout(upperBound) {
  var lowerBound = upperBound * 0.8;
  return 1000 * (Math.random() * (upperBound - lowerBound) + lowerBound);
}

Transport = function(ua, server) {

  this.logger = ua.getLogger('sip.transport');
  this.ua = ua;
  this.tcp = null;
  this.sockets = {};
  this.server = server;
  this.reconnection_attempts = 0;
  this.closed = false;
  this.connected = false;
  this.reconnectTimer = null;
  this.lastTransportError = {};

  this.keepAliveInterval = ua.configuration.keepAliveInterval;
  this.keepAliveTimeout = null;
  this.keepAliveTimer = null;

  this.ua.transport = this;
  this.transportType = "TCP";

  // Connect
  this.connect();
};

Transport.prototype = {
  /**
   * Send a message.
   * @param {SIP.OutgoingRequest|String} msg
   * @returns {Boolean}
   */
  send: function(msg) {
    const message = msg.toString();
    const parsedMsg = SIP.Parser.parseMessage(msg, this.ua);
    if (message) {
      let callId = parsedMsg.call_id;
      let fromTag = parsedMsg.from_tag;
      if (callId && fromTag) {
        let socket = this.sockets[callId + fromTag];
        if (socket) {
          socket.write(message, (e) => {
            if (e) {
              this.logger.warn('unable to send TCP message with error', err);
              return false;
            }
            if (this.ua.configuration.traceSip === true) {
              this.logger.log('sent TCP message:\n\n' + message + '\n');
            }
          });
          return true;
        } else {
          this.logger.warn('unable to send message, TCP is not open');
          return false;
        }
      }
    }
  },

  /**
   * Send a keep-alive (a double-CRLF sequence).
   * @private
   * @returns {Boolean}
   */
  sendKeepAlive: function() {
    if(this.keepAliveTimeout) { return; }

    this.keepAliveTimeout = SIP.Timers.setTimeout(function() {
      this.ua.emit('keepAliveTimeout');
    }.bind(this), 10000);

    return this.send('\r\n\r\n');
  },

  /**
   * Start sending keep-alives.
   * @private
   */
  startSendingKeepAlives: function() {
    if (this.keepAliveInterval && !this.keepAliveTimer) {
      this.keepAliveTimer = SIP.Timers.setTimeout(function() {
        this.sendKeepAlive();
        this.keepAliveTimer = null;
        this.startSendingKeepAlives();
      }.bind(this), computeKeepAliveTimeout(this.keepAliveInterval));
    }
  },

  /**
   * Stop sending keep-alives.
   * @private
   */
  stopSendingKeepAlives: function() {
    SIP.Timers.clearTimeout(this.keepAliveTimer);
    SIP.Timers.clearTimeout(this.keepAliveTimeout);
    this.keepAliveTimer = null;
    this.keepAliveTimeout = null;
  },

  /**
  * Disconnect socket.
  */
  disconnect: function() {
    if(this.tcp) {
      // Clear reconnectTimer
      SIP.Timers.clearTimeout(this.reconnectTimer);

      this.stopSendingKeepAlives();

      this.closed = true;
      this.logger.log('closing TCP socket' + this.server.tcp_uri);
      this.tcp.destroy();
    }

    if (this.reconnectTimer !== null) {
      SIP.Timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.ua.emit('disconnected', {
        transport: this,
        code: this.lastTransportError.code,
        reason: this.lastTransportError.reason
      });
    }
  },

  /**
  * Connect socket.
  */
  connect: function() {
    var transport = this;
    this.logger.log('connecting to TCP server');
    this.ua.onTransportConnecting(this,
      (this.reconnection_attempts === 0)?1:this.reconnection_attempts);

    this.server = net.createServer((socket) => {
      socket.on('end', function() {
        transport.onClose(socket);
      });

      // TODO parse length info and compose stream if it exceeds
      socket.on('data', function(e) {
        let msg = e.toString();
        transport.onMessage({
          data: msg,
          socket
        });
      });
    });

    this.server.on('listening', () => {
      transport.connected = true;
      transport.closed = false;
      transport.ua.onTransportConnected(transport);
    });

    this.logger.log("TCP transport will listen into host:" + this.ua.configuration.uri.host +
        " port:" + this.ua.configuration.uri.port);
    this.server.listen(this.ua.configuration.uri.port, this.ua.configuration.uri.host);
  },

  // Transport Event Handlers

  /**
  * @event
  * @param {event} e
  */
  onOpen: function() {
    this.connected = true;

    this.logger.log('TCP socket ' + this.server.ws_uri + ' connected');
    // Clear reconnectTimer since we are not disconnected
    if (this.reconnectTimer !== null) {
      SIP.Timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Reset reconnection_attempts
    this.reconnection_attempts = 0;
    // Disable closed
    this.closed = false;
    // Trigger onTransportConnected callback
    this.ua.onTransportConnected(this);
    // Start sending keep-alives
    this.startSendingKeepAlives();
  },

  /**
  * @event
  * @param {event} e
  */
  onClose: function(socket) {
    this.stopSendingKeepAlives();
    if (socket.callIndex) {
      this.logger.log("TCP socket for connection", socket.callIndex, "ended");
      if (this.sockets[socket.callIndex]) {
        delete this.sockets[socket.callIndex];
      }
    }
  },

  /**
  * @event
  * @param {event} e
  */
  onMessage: function(args) {
    let { data, socket } = args;
    var messages = [], transaction;


    // CRLF Keep Alive response from server. Ignore it.
    if(data === '\r\n') {
      SIP.Timers.clearTimeout(this.keepAliveTimeout);
      this.keepAliveTimeout = null;

      if (this.ua.configuration.traceSip === true) {
        this.logger.log('received TCP message with CRLF Keep Alive response');
      }

      return;
    }

    // TCP binary message.
    else if (typeof data !== 'string') {
      try {
        data = String.fromCharCode.apply(null, new Uint8Array(data));
      } catch(evt) {
        this.logger.warn('received TCP binary message failed to be converted into string, message discarded');
        return;
      }

      if (this.ua.configuration.traceSip === true) {
        this.logger.log('received TCP binary message:\n\n' + data + '\n');
      }
    }

    // TCP text message.
    else {
      if (this.ua.configuration.traceSip === true) {
        this.logger.log('received TCP text message:\n\n' + data + '\n');
      }
    }

    let endOfStream = false;
    while (!endOfStream) {
      let fragment;
      fragment = SIP.Parser.parseMessage(data, this.ua);
      if(this.ua.status === SIP.UA.C.STATUS_USER_CLOSED && fragment instanceof SIP.IncomingRequest) {
        endOfStream = true;
        return;
      }

      if (fragment == null) {
        endOfStream = true;
        break;
      }

      if (fragment) {
        messages.push(fragment);
        data = data.slice(fragment.currentLength);
      }
      if (data.length === 0) {
        endOfStream = true;
      }
    }

    messages.forEach(message => {
      // Do some sanity check
      if(SIP.sanityCheck(message, this.ua, this)) {
        if(message instanceof SIP.IncomingRequest) {
          message.transport = this;
          switch (message.method) {
            case SIP.C.INVITE:
              if (this.sockets[message.call_id + message.from_tag] == null) {
                socket.callIndex = message.call_id + message.from_tag;
                this.sockets[message.call_id + message.from_tag] = socket;
              }
              break;
            default:
              break;
          }
          this.ua.receiveRequest(message);
        } else if(message instanceof SIP.IncomingResponse) {
          /* Unike stated in 18.1.2, if a response does not match
           * any transaction, it is discarded here and no passed to the core
           * in order to be discarded there.
           */
          switch(message.method) {
            case SIP.C.INVITE:

              transaction = this.ua.transactions.ict[message.via_branch];
              if(transaction) {
                transaction.receiveResponse(message);
              }
              break;
            case SIP.C.ACK:
              // Just in case ;-)
              break;
            default:
              transaction = this.ua.transactions.nict[message.via_branch];
              if(transaction) {
                transaction.receiveResponse(message);
              }
              break;
          }
        }
      }
    });
  },

  /**
  * @event
  * @param {event} e
  */
  onError: function(e) {
    this.logger.warn('TCP connection error: ' + JSON.stringify(e));
  },

  /**
  * Reconnection attempt logic.
  * TODO revisit this garbage
  * @private
  */
  reconnect: function() {
    var transport = this;

    //this.reconnection_attempts += 1;

    //if(this.reconnection_attempts > this.ua.configuration.wsServerMaxReconnection) {
    //  this.logger.warn('maximum reconnection attempts for TCP ' + this.server.ws_uri);
    //  this.ua.onTransportError(this);
    //} else if (this.reconnection_attempts === 1) {
    //  this.logger.log('Connection to TCP ' + this.server.ws_uri + ' severed, attempting first reconnect');
    //  transport.connect();
    //} else {
    //  this.logger.log('trying to reconnect to TCP ' + this.server.ws_uri + ' (reconnection attempt ' + this.reconnection_attempts + ')');

    //  this.reconnectTimer = SIP.Timers.setTimeout(function() {
    //    transport.connect();
    //    transport.reconnectTimer = null;
    //  }, this.ua.configuration.wsServerReconnectionTimeout * 1000);
    //}
  }
};

Transport.C = C;
return Transport;
};
