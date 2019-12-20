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
const DEFAULT_MAX_MTU = 1300;

module.exports = function(SIP) {
  const dgram = require('dgram');
  const net = require('net');
  const C = {
    // Transport status codes
    STATUS_READY: 0,
    STATUS_DISCONNECTED: 1,
    STATUS_ERROR: 2
  };

  const Transport = function(ua, server) {
    this.logger = ua.getLogger('sip.transport');
    this.ua = ua;
    this.clients = {};
    // meta server object, mixin of UDP/TCP
    this.server;
    this.reconnection_attempts = 0;
    this.closed = false;
    this.connected = false;
    this.reconnectTimer = null;
    this.lastTransportError = {};
    this.sockets = {};
    this.keepAliveInterval = ua.configuration.keepAliveInterval;
    this.keepAliveTimeout = null;
    this.keepAliveTimer = null;
    this.udpMtu = ua.configuration.udpMtu || DEFAULT_MAX_MTU;
    this.ua.transport = this;
    this.transportType = "UDP";

    // Connect
    this.connect();
  };

  Transport.prototype = {
    /**
     * Send a message.
     * @param {SIP.OutgoingRequest|String} msg
     * @returns {Boolean}
     */
    send: function (msg) {
      const message = msg.toString();
      const mbsize = Buffer.byteLength(message, 'utf8');
      if (mbsize < this.udpMtu) {
        this.logger.log(`SIP request is lower than max MTU ${this.udpMtu} with ${mbsize} bytes, send it via UDP`);
        return this.sendViaUDP(msg);
      } else {
        this.logger.log(`SIP request is greater than max MTU ${this.udpMtu} with ${mbsize} bytes, send it via TCP`);
        return this.sendViaTCP(msg);
      }
    },

    indexNewSocket: function(socket, callIndex) {
      socket.callIndex = callIndex;
      this.sockets[callIndex] = socket;
    },

    tetherToSession: function(socket, message) {
      if (!socket.isTetheredToSession) {
        let sessionToWatch = this.ua.findSession(message);
        if (sessionToWatch) {
          sessionToWatch.once('terminated', () => {
            socket.end();
          });
          socket.isTetheredToSession = true;
        }
      }
    },

    fetchUDPDestination: function(parsedMsg) {
      let host, port;
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

      return { host, port };
    },

    fetchDestination: function (parsedMsg) {
      let host, port;
      // Route through the header instead of RURI if the Route header is present
      let routeHdr = parsedMsg.getHeader('Route');
      if(routeHdr !== undefined) {
        // remove < and >
        const route = routeHdr.replace('<', '').replace('>', '');
        const routeUri = SIP.URI.parse(route);
        host = routeUri.host;
        port = routeUri.port || 5060;
      } else {
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

      return { host, port };
    },

    connectTo: function (host, port, callback) {
      const socket = net.createConnection({ host, port });
      socket.once('connect', () => {
        return callback(socket);
      });
    },

    onNewSocket: function (socket) {
      const transport = this;
      socket.pendingSegmentsBuffer = new Buffer(0);
      socket.setKeepAlive(true);
      socket.on('end', (e) => {
        if (this.sockets[socket.callIndex]) {
          this.logger.log(`TCP socket ended for connection ${socket.callIndex || 'Unknown'}`);
          transport.onClientSocketClose(socket, e);
          delete this.sockets[socket.callIndex];
        }
      });

      socket.on('close', (e) => {
        if (this.sockets[socket.callIndex]) {
          this.logger.log(`TCP socket closed for connection ${socket.callIndex || 'Unknown'}`);
          transport.onClientSocketClose(socket, e);
          delete this.sockets[socket.callIndex];
        }
      });

      const onSocketError = (e) => {
        this.logger.log("TCP socket returned error " + e + " and will close");
        if (socket.callIndex) {
          this.logger.log(`TCP socket errored for connection ${socket.callIndex}`);
          transport.onClientSocketClose(socket, e);
          socket.destroy();
          if (this.sockets[socket.callIndex]) {
            delete this.sockets[socket.callIndex];
          }
        }
      }

      socket.on('error', onSocketError.bind(this));

      socket.on('data', function(data) {
        transport.onMessage({
          data,
          socket
        });
      });
    },

    writeToSocket: function (socket, message, callback) {
      socket.write(message, (e) => {
        if (e) {
          this.logger.warn(`unable to send TCP message with error ${e}\n\n${message}`);
          return callback(error);
        }
        if (this.ua.configuration.traceSip === true) {
          this.logger.log('sent TCP message:\n\n' + message + '\n');
          return callback(null);
        }
      });
    },

    sendViaTCP: function (msg) {
      const message = msg.toString();
      const parsedMsg = SIP.Parser.parseMessage(message, this.ua);

      if (message) {
        let callId = parsedMsg.call_id;
        let callTag;
        if (msg instanceof SIP.OutgoingRequest) {
          callTag = parsedMsg.to_tag || parsedMsg.from_tag;
        } else {
          callTag = parsedMsg.from_tag;
        }
        if (callId && callTag) {
          const callIndex = `${callId}|${callTag}`;
          let socket = this.sockets[callIndex]
          if (socket) {
            this.writeToSocket(socket, message, (error) => {
              if (error) return false;
            });
            return true;
          } else {
            // Outgoing request to new TCP conn. Open it, index and send.
            if (msg instanceof SIP.OutgoingRequest) {
              let { host, port } = this.fetchDestination(parsedMsg);
              this.connectTo(host, port, (socket) => {
                this.logger.warn(`New outbound TCP connection created to ${host}:${port} with callIndex ${callIndex}`);
                this.onNewSocket(socket);
                this.indexNewSocket(socket, callIndex);
                this.tetherToSession(socket, parsedMsg);
                this.writeToSocket(socket, message, (error) => {
                  if (error) return false;
                  return true;
                });
              });
            } else {
              this.logger.warn('unable to send message, TCP socket does not exist');
              return false;
            }
          }
        } else {
          this.logger.warn(`Either callId ${callId} or callTag ${callTag} isn't here, drop message\n\n${message}`);
          return false;
        }
      } else {
        this.logger.warn(`Not a valid message, drop it\n\n${message}`);
        return false;

      }
    },

    sendViaUDP: function(msg) {
      let callId = null, fromTag = null, parsedMsg;

      parsedMsg = msg;

      if(typeof parsedMsg === 'string') {
        parsedMsg = SIP.Parser.parseMessage(parsedMsg, this.ua);
        if(!parsedMsg) {
          return false;
        }
      }

      const { host, port } = this.fetchUDPDestination(parsedMsg);
      const parsedMsgToString = parsedMsg.toString();

      if (this.ua.configuration.traceSip === true) {
        this.logger.log(`Sending UDP message to ${host}:${port}\n\n` + parsedMsgToString + '\n');
      }

      var msgToSend = new Buffer(parsedMsgToString);

      this.UDPServer.send(msgToSend, 0, msgToSend.length, port, host, function(err) {
        if (err) {
          // TODO error handling
        }
      });

      return true;
    },

    connect: function () {
      this.connectToUDP();
      this.connectToTCP();
      // meta mixed-in server
      this.server = { ...this.UDPServer, ...this.TCPServer };
    },

    /**
     * Connect the UDP side of this transport.
     */
    connectToUDP: function() {
      var transport = this;
      var self = this;

      this.UDPServer = dgram.createSocket('udp4');

      this.UDPServer.on('listening', function() {
        transport.connected = true;

        // Disable closed
        transport.closed = false;

        // Trigger onTransportConnected callback
        self.logger.log("UDP transport triggering connected callback");
        transport.ua.onTransportConnected(transport);
      });

      this.UDPServer.on('message', function(msg, remote) {
        transport.onUDPMessage({
          data: msg,
          remote: remote
        });
      });

      this.logger.log("UDP transport will listen into host:" + this.ua.configuration.bindIpAddress +
        " port:" + this.ua.configuration.uri.port);
      this.UDPServer.bind(this.ua.configuration.uri.port, this.ua.configuration.bindIpAddress);
    },

    /**
     * Connect the TCP side of this transport.
     */
    connectToTCP: function() {
      const transport = this;
      this.logger.log('connecting to TCP server');
      this.ua.onTransportConnecting(this,
        (this.reconnection_attempts === 0)?1:this.reconnection_attempts);

      this.TCPServer = net.createServer(this.onNewSocket.bind(this));

      this.TCPServer.on('listening', () => {
        transport.connected = true;
        transport.closed = false;
        transport.ua.onTransportConnected(transport);
      });

      this.logger.log("TCP transport will listen into host:" + this.ua.configuration.bindIpAddress +
        " port:" + this.ua.configuration.uri.port);
      this.TCPServer.listen(this.ua.configuration.uri.port, this.ua.configuration.bindIpAddress);
    },

    // Transport Event Handlers

    /**
     * @event
     * @param {event} e
     */
    onUDPMessage: function(e) {
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
        let client = this.clients[message.call_id + message.from_tag];
        if (!client) {
          this.clients[message.call_id + message.from_tag] = remote;
          client = remote;
        }

        if (message instanceof SIP.IncomingRequest) {
          message.transport = this;
          switch (message.method) {
            case SIP.C.INVITE:
              break;
            case SIP.C.BYE:
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
     * @event
     * @param {event} e
     */
    onTCPMessage: function(args) {
      let { data, socket } = args;
      let dataString = data.toString();
      let pendingSegments;
      var messages = [], transaction;

      // CRLFCRLF keep-alive request, send CRLF response
      if (dataString == '\r\n\r\n' || dataString == '\n\r\n\r') {
        this.logger.log('received TCP message with CRLFCRLF Keep Alive ping');
        if (socket) {
          return socket.write('\r\n', (e) => {
            if (e) {
              this.logger.warn(`unable to send keep-alive pong due to ${e}`);
            }
            if (this.ua.configuration.traceSip === true) {
              this.logger.log('sent TCP Keep Alive pong');
            }
          });
        } else {
          this.logger.warn(`unable to send keep-alive pong because there is no socket`);
          return;
        }
      }

      // CRLF Keep Alive response from server. Ignore it.
      if(dataString === '\r\n' || dataString == '\n\r') {
        SIP.Timers.clearTimeout(this.keepAliveTimeout);
        this.keepAliveTimeout = null;

        if (this.ua.configuration.traceSip === true) {
          this.logger.log('received TCP message with CRLF Keep Alive response');
        }

        return;
      }

      if (socket.pendingSegmentsBuffer.length > 0) {
        pendingSegments = Buffer.concat([socket.pendingSegmentsBuffer, data]);
      } else {
        pendingSegments = data;
      }

      socket.pendingSegmentsBuffer = pendingSegments;

      // TCP binary message.
      if (typeof pendingSegments !== 'string') {
        try {
          pendingSegments = String.fromCharCode.apply(null, new Uint8Array(pendingSegments));
        } catch(evt) {
          this.logger.warn('received TCP binary message failed to be converted into string, message discarded', evt);
          return;
        }

        if (this.ua.configuration.traceSip === true) {
          this.logger.log('received TCP binary message:\n\n' + pendingSegments + '\n');
        }
      } else {
        // TCP text message.
        if (this.ua.configuration.traceSip === true) {
          this.logger.log('received TCP text message:\n\n' + pendingSegments + '\n');
        }
      }

      let endOfStream = false;
      while (!endOfStream) {
        let fragment;
        fragment = SIP.Parser.parseMessage(pendingSegments, this.ua);

        // End of UA session. Clear segments buffer and skip
        if(this.ua.status === SIP.UA.C.STATUS_USER_CLOSED && fragment instanceof SIP.IncomingRequest) {
          socket.pendingSegmentsBuffer = new Buffer(0);
          endOfStream = true;
          return;
        }

        // Invalid/incomplete fragment which might be completed due to fragmentation.
        // Keep the pendingSegmentsBuffer as it is and skip.
        if (fragment == null && pendingSegments.length > 0) {
          endOfStream = true;
          break;
        }

        // There is a fragment (which indicates a valid SIP message), but the Content-Length
        // header does not match with the whole fragment size, so we skip and leave
        // it to reprocess when a new segment comes through the socket
        if (SIP.Utils.str_utf8_length(fragment.body) < fragment.getHeader('content-length')) {
          endOfStream = true;
          break;
        }

        if (fragment) {
          messages.push(fragment);
          pendingSegments = pendingSegments.slice(fragment.currentLength);
        }
        if (pendingSegments.length === 0) {
          endOfStream = true;
        }
      }

      if (pendingSegments.length === 0) {
        socket.pendingSegmentsBuffer = new Buffer(0);
      } else {
        socket.pendingSegmentsBuffer = Buffer.from(pendingSegments, 'utf8');
      }

      messages.forEach(message => {
        // Do some sanity check
        if(SIP.sanityCheck(message, this.ua, this)) {
          if(message instanceof SIP.IncomingRequest) {
            message.transport = this;
            switch (message.method) {
              case SIP.C.INVITE:
                if (this.sockets[message.call_id + message.from_tag] == null) {
                  const callIndex = `${message.call_id}|${message.from_tag}`;
                  this.indexNewSocket(socket, callIndex);
                  // Get that socket, hook it up to the session termination
                  // to close it. Noice.
                }
                this.tetherToSession(socket, message);
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
     * @event
     * @param {net.Socket} socket
     * @param {event} e
     */
    onClientSocketClose: function(socket, e = {}) {
      const callId = socket.callIndex? socket.callIndex.split('|')[0] : ''
      this.ua.emit('sessionTransportDisconnected', {
        transport: this,
        callId,
        code: e.code || '',
        reason: e.message || ''
      });
    },

    /**
     * Disconnect socket.
     */
    disconnect: function() {
      if (this.TCPServer) {
        // Clear reconnectTimer
        SIP.Timers.clearTimeout(this.reconnectTimer);

        this.stopSendingKeepAlives();

        this.logger.log('closing TCP socket' + this.TCPServer.tcp_uri);
        this.TCPServer.destroy();
      }

      if (this.UDPServer) {
        this.logger.log('closing UDP transport');
        this.server.close();
      }

      this.closed = true;

      if (this.reconnectTimer !== null) {
        SIP.Timers.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      this.ua.emit('disconnected', {
        transport: this,
        code: this.lastTransportError.code,
        reason: this.lastTransportError.reason
      });

    },

    /**
     * @event
     * @param {event} e
     */
    onOpen: function() {
      this.connected = true;

      this.logger.log('TCP socket ' + this.TCPServer.ws_uri + ' connected');
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
    onError: function(e) {
      this.logger.warn('UnifiedTransport connection error: ' + JSON.stringify(e));
    },
  };

  Transport.C = C;
  return Transport;
};
