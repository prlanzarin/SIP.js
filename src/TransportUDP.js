"use strict";
/**
 * @fileoverview Transport
 */

/**
 * @augments SIP
 * @class Transport
 * @param {SIP.UA} ua
 * @param {Object} server ws_server Object
 */
module.exports = function(SIP) {
  var Transport,
    dgram = require('dgram'),
    C = {
      // Transport status codes
      STATUS_READY: 0,
      STATUS_DISCONNECTED: 1,
      STATUS_ERROR: 2
    };

  Transport = function(ua, server) {
    this.logger = ua.getLogger('sip.transport');
    this.ua = ua;
    this.ws = null;
    this.server = server;
    this.clients = {};
    this.reconnection_attempts = 0;
    this.closed = false;
    this.connected = false;
    this.lastTransportError = {};

    this.ua.transport = this;
    this.transportType = "UDP";

    // Connect
    this.connect();
  };

  Transport.prototype = {
    fetchDestination: function(parsedMsg) {
      let host, port, callId, fromTag;
      let routeHdr = parsedMsg.getHeader('Route');

      // Route through the header instead of RURI if the Route header is present
      if(routeHdr !== undefined) {
        const route = routeHdr.replace('<', '').replace('>', '');
        const routeUri = SIP.URI.parse(route);
        host = routeUri.host;
        port = routeUri.port || 5060;
      } else {
        if (parsedMsg) {
          callId = parsedMsg.call_id;
          fromTag = parsedMsg.from_tag;
        }

        if(callId && fromTag) {
          var client = this.clients[callId + fromTag];
          if (client) {
            if (!host) {
              host = client.address;
            }

            if (!port) {
              port = client.port;
            }
          }
        }

        if (!host) {
          host = parsedMsg.ruri? parsedMsg.ruri.host : null;
        }
        if (!port) {
          port = parsedMsg.ruri? parsedMsg.ruri.port : null;
        }
      }

      if(!port && parsedMsg.from && parsedMsg.from.uri &&
        parsedMsg.from.uri.port) {
        port = parsedMsg.from.uri.port;
      }

      if(!host && parsedMsg.from && parsedMsg.from.uri &&
        parsedMsg.from.uri.host) {
        host = parsedMsg.from.uri.host;
      }

      if (!port) {
        this.logger.warn(`No inferred UDP port found, use default 5060`);
        port = 5060;
      }

      return { host, port };
    },

    /**
     * Send a message.
     * @param {SIP.OutgoingRequest|String} msg
     * @returns {Boolean}
     */
    send: function(msg) {
      let callId = null, fromTag = null, parsedMsg;

      parsedMsg = msg;

      if(typeof parsedMsg === 'string') {
        parsedMsg = SIP.Parser.parseMessage(parsedMsg, this.ua);
        if(!parsedMsg) {
          return false;
        }
      }

      const { host, port } = this.fetchDestination(parsedMsg);
      const parsedMsgToString = parsedMsg.toString();

      if (this.ua.configuration.traceSip === true) {
        this.logger.log(`Sending UDP message to ${host}:${port}\n\n` + parsedMsgToString + '\n');
      }

      var msgToSend = new Buffer(parsedMsgToString);

      this.server.send(msgToSend, 0, msgToSend.length, port, host, function(err) {
        if (err) {
          this.logger.warn(`Failed to send UPD message to ${host}:${port}, ${err.message}`);
        }
      });

      return true;
    },

    /**
     * Connect socket.
     */
    connect: function() {
      var transport = this;
      var self = this;

      this.server = dgram.createSocket('udp4');

      this.server.on('listening', function() {
        transport.connected = true;

        // Disable closed
        transport.closed = false;

        // Trigger onTransportConnected callback
        self.logger.log("UDP transport triggering connected callback");
        transport.ua.onTransportConnected(transport);
      });

      this.server.on('message', function(msg, remote) {
        transport.onMessage({
          data: msg,
          remote: remote
        });
      });

      this.logger.log("UDP transport will listen into host:" + this.ua.configuration.bindIpAddress +
        " port:" + this.ua.configuration.uri.port);
      this.server.bind(this.ua.configuration.uri.port, this.ua.configuration.bindIpAddress);

    },

    // Transport Event Handlers

    /**
     * @event
     * @param {event} e
     */
    onMessage: function(e) {
      var message, transaction,
        data = e.data,
        remote = e.remote;

      // CRLF Keep Alive response from server. Ignore it.
      if (data === '\r\n') {
        if (this.ua.configuration.traceSip === true) {
          this.logger.log('received UDP message with CRLF Keep Alive response');
        }
        return;
      } else if (typeof data !== 'string') {
        try {
          data = String.fromCharCode.apply(null, new Uint8Array(data));
        } catch (evt) {
          this.logger.warn('received UDP binary message failed to be converted into string, message discarded');
          return;
        }

        if (this.ua.configuration.traceSip === true) {
          this.logger.log('received UDP binary message:\n\n' + data + '\n');
        }
      } else {
        if (this.ua.configuration.traceSip === true) {
          this.logger.log('received UDP text message:\n\n' + data + '\n');
        }
      }

      message = SIP.Parser.parseMessage(data, this.ua);

      if (!message) {
        return;
      }

      if (this.ua.status === SIP.UA.C.STATUS_USER_CLOSED && message instanceof SIP.IncomingRequest) {
        return;
      }

      // Do some sanity check
      if (SIP.sanityCheck(message, this.ua, this)) {
        if (message instanceof SIP.IncomingRequest) {
          message.transport = this;
          switch (message.method) {
            case SIP.C.INVITE:
              var client = this.clients[message.call_id + message.from_tag];

              if (!client) {
                this.clients[message.call_id + message.from_tag] = remote;
              }
              break;
            case SIP.C.BYE:
              var client = this.clients[message.call_id + message.from_tag];

              if (client) {
                var session = this.ua.findSession(message);

                if (session) {
                  session.on('terminated', function () {
                    delete message.transport.clients[message.call_id +
                      message.from_tag];
                  });
                }
              }
              break;
            default:
              break;
          }

          this.ua.receiveRequest(message);
        } else if (message instanceof SIP.IncomingResponse) {
          /* Unike stated in 18.1.2, if a response does not match
           * any transaction, it is discarded here and no passed to the core
           * in order to be discarded there.
           */
          switch (message.method) {
            case SIP.C.INVITE:
              transaction = this.ua.transactions.ict[message.via_branch];
              if (transaction) {
                transaction.receiveResponse(message);
              }
              break;
            case SIP.C.ACK:
              // Just in case ;-)
              break;
            default:
              transaction = this.ua.transactions.nict[message.via_branch];
              if (transaction) {
                transaction.receiveResponse(message);
              }
              break;
          }
        }
      }
    },

    /**
     * Disconnect socket.
     */
    disconnect: function() {
      if (this.server) {
        this.closed = true;
        this.logger.log('closing UDP transport');
        this.server.close();
      }

      this.ua.emit('disconnected', {
        transport: this,
        code: this.lastTransportError.code,
        reason: this.lastTransportError.reason
      });
    },
  };

  Transport.C = C;
  return Transport;
};
