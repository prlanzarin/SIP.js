"use strict";
module.exports = function (SIP) {

var RegisterContext;

RegisterContext = function (ua) {
  var params = {},
      regId = 1;

  this.registrar = ua.configuration.registrarServer;
  this.expires = ua.configuration.registerExpires;
  this.ua = ua;

  // Contact header
  this.contact = ua.contact.toString();

  if(regId) {
    this.contact += ';reg-id='+ regId;
    this.contact += ';+sip.instance="<urn:uuid:'+ ua.configuration.instanceId+'>"';
  }

  // Call-ID and CSeq values RFC3261 10.2
  this.call_id = SIP.Utils.createRandomToken(22);
  this.cseq = this.baseCseq = 80;

  this.to_uri = ua.configuration.uri;

  params.to_uri = this.to_uri;
  params.to_displayName = ua.configuration.displayName;
  params.call_id = this.call_id;
  params.cseq = this.cseq;

  this.defaultClientContext = new SIP.ClientContext(ua, 'REGISTER', this.registrar, {params: params});

  this.defaultClientContext.cseq = this.baseCseq;

  this.assignClientContextListeners(this.defaultClientContext);

  this.customClientContexts = {};

  // Set status
  this.registered = false;

  this.logger = ua.getLogger('sip.registercontext');
};

RegisterContext.prototype = Object.create(SIP.EventEmitter.prototype);

RegisterContext.prototype.assignClientContextListeners = function (context) {
  context.on('cancel', () => this.emit('cancel'));
  context.on('progress', (r, c) => this.emit('progress', r, c));
  context.on('accepted', (r, c) => this.emit('accepted', r, c));
  context.on('rejected', (r, c) => this.emit('rejected', r, c));
  context.on('failed', (r, c) => this.emit('failed', r, c));
}

RegisterContext.prototype.register = function (options = {}) {
  var self = this, extraHeaders, reqContext, registrationTag;

  // Handle Options
  const { uri, binding } = options;
  const isCustomClientContext = !(binding == null);

  if (isCustomClientContext) {
    reqContext = this.customClientContexts[binding];
    if (reqContext == null) {
      const call_id = SIP.Utils.createRandomToken(22);
      const params = {
        to_uri: uri,
        from_uri: uri,
        to_displayName: binding,
        from_displayName: binding,
        call_id,
        cseq: this.baseCseq,
      };

      reqContext = new SIP.ClientContext(this.ua, 'REGISTER', this.registrar, { params: params });

      reqContext.cseq = this.baseCseq;

      this.assignClientContextListeners(reqContext);
      this.customClientContexts[binding] = reqContext;
    }
    registrationTag = binding;
  } else {
    this.options = options;
    reqContext = this.defaultClientContext;
    registrationTag = this.ua.configuration.displayName;
  }

  extraHeaders = (options.extraHeaders || []).slice();
  extraHeaders.push('Contact: ' + this.contact + ';expires=' + this.expires);
  extraHeaders.push('Allow: ' + SIP.UA.C.ALLOWED_METHODS.toString());

  // Save original extraHeaders to be used in .close
  this.closeHeaders = options.closeWithHeaders ?
    (options.extraHeaders || []).slice() : [];

  reqContext.receiveResponse = function(response) {
    var contact, expires,
      contacts = response.getHeaders('contact').length,
      cause;

    // Discard responses to older REGISTER/un-REGISTER requests.
    if(response.cseq !== reqContext.cseq) {
      return;
    }

    // Clear registration timer
    if (reqContext.registrationTimer !== null) {
      clearTimeout(reqContext.registrationTimer);
      reqContext.registrationTimer = null;
    }

    switch(true) {
      case /^1[0-9]{2}$/.test(response.status_code):
        this.emit('progress', response);
        break;
      case /^2[0-9]{2}$/.test(response.status_code):
        this.emit('accepted', response);

        if(response.hasHeader('expires')) {
          expires = response.getHeader('expires');
        }

        if (reqContext.registrationExpiredTimer !== null) {
          clearTimeout(reqContext.registrationExpiredTimer);
          reqContext.registrationExpiredTimer = null;
        }

        // Search the Contact pointing to us and update the expires value accordingly.
        if (!contacts) {
          this.logger.warn('no Contact header in response to REGISTER, response ignored');
          break;
        }

        while(contacts--) {
          contact = response.parseHeader('contact', contacts);
          if(contact.uri.user === this.ua.contact.uri.user) {
            expires = contact.getParam('expires');
            break;
          } else {
            contact = null;
          }
        }

        if (!contact) {
          this.logger.warn('no Contact header pointing to us, response ignored');
          break;
        }

        if(!expires) {
          expires = this.expires;
        }

        // Re-Register before the expiration interval has elapsed.
        // For that, decrease the expires value. ie: 3 seconds
        reqContext.registrationTimer = setTimeout(() => {
          reqContext.registrationTimer = null;
          self.register(options);
        }, (expires * 1000) - 10000);

        reqContext.registrationExpiredTimer = setTimeout(() => {
          self.logger.warn('registration expired for');
          if (reqContext.registered) {
            self.unregistered(null, SIP.C.causes.EXPIRES, registrationTag);
          }
        }, expires * 1000);

        //Save gruu values
        if (contact.hasParam('temp-gruu')) {
          this.ua.contact.temp_gruu = SIP.URI.parse(contact.getParam('temp-gruu').replace(/"/g,''));
        }
        if (contact.hasParam('pub-gruu')) {
          this.ua.contact.pub_gruu = SIP.URI.parse(contact.getParam('pub-gruu').replace(/"/g,''));
        }

        this.registered = true;
        reqContext.registered = true;
        this.emit('registered', response || null, registrationTag);
        break;
        // Interval too brief RFC3261 10.2.8
      case /^423$/.test(response.status_code):
        if(response.hasHeader('min-expires')) {
          // Increase our registration interval to the suggested minimum
          this.expires = response.getHeader('min-expires');
          // Attempt the registration again immediately
          this.register(options);
        } else { //This response MUST contain a Min-Expires header field
          this.logger.warn('423 response received for REGISTER without Min-Expires');
          this.registrationFailure(response, SIP.C.causes.SIP_FAILURE_CODE);
        }
        break;
      default:
        cause = SIP.Utils.sipErrorCause(response.status_code);
        this.registrationFailure(response, cause);
    }
  }.bind(this);

  reqContext.onRequestTimeout = function() {
    this.registrationFailure(null, SIP.C.causes.REQUEST_TIMEOUT);
  }.bind(this);

  reqContext.onTransportError = function() {
    this.registrationFailure(null, SIP.C.causes.CONNECTION_ERROR);
  }.bind(this);

  reqContext.cseq++;
  reqContext.request.cseq = reqContext.cseq;
  reqContext.request.setHeader('cseq', reqContext.cseq + ' REGISTER');
  reqContext.request.extraHeaders = extraHeaders;
  reqContext.send();
};

RegisterContext.prototype.registrationFailure = function (response, cause) {
  this.emit('failed', response || null, cause || null);
};

RegisterContext.prototype.onTransportClosed = function() {
  this.registered_before = this.registered;

  // Clear timeouts from custom contexts
  const customContexts = Object.keys(this.customClientContexts);
  customContexts.forEach(ctb => {
    if (ctb.registrationTimer !== null) {
      clearTimeout(ctb.registrationTimer);
      ctb.registrationTimer = null;
    }

    if (ctb.registrationExpiredTimer !== null) {
      clearTimeout(ctb.registrationExpiredTimer);
      ctb.registrationExpiredTimer = null;
    }
  });

  // Clear timeouts from the default main registration context
  if (this.defaultClientContext.registrationTimer !== null) {
    clearTimeout(this.defaultClientContext.registrationTimer);
    this.defaultClientContext.registrationTimer = null;
  }

  if (this.defaultClientContext.registrationExpiredTimer !== null) {
    clearTimeout(this.defaultClientContext.registrationExpiredTimer);
    this.defaultClientContext.registrationExpiredTimer = null;
  }

  if(this.registered) {
    this.unregistered(null, SIP.C.causes.CONNECTION_ERROR, 'all');
  }
};

RegisterContext.prototype.onTransportConnected = function() {
  this.register(this.options);
};

RegisterContext.prototype.close = function() {
  var options = {
    all: false,
    extraHeaders: this.closeHeaders
  };

  this.registered_before = this.registered;
  const customContexts = Object.keys(this.customClientContexts);
  customContexts.forEach(ctb => {
    this.unregister({ ...options, binding: ctb });
  });

  this.unregister(options);
};

RegisterContext.prototype.unregister = function(options) {
  var extraHeaders, reqContext, registrationTag;

  options = options || {};

  // Handle Options
  const { binding } = options;
  const isCustomClientContext = !(binding == null);

  if (isCustomClientContext) {
    reqContext = this.customClientContexts[binding];
    registrationTag = binding;
  } else {
    reqContext = this.defaultClientContext;
    registrationTag = this.ua.configuration.displayName;
  }

  if(!reqContext.registered && !options.all) {
    this.logger.warn('already unregistered');
    return;
  }

  extraHeaders = (options.extraHeaders || []).slice();

  reqContext.registered = false;
  if (!isCustomClientContext) {
    this.registered = false;
  }

  // Clear the registration timer.
  if (reqContext.registrationTimer !== null) {
    clearTimeout(reqContext.registrationTimer);
    reqContext.registrationTimer = null;
  }

  if(options.all) {
    extraHeaders.push('Contact: *');
    extraHeaders.push('Expires: 0');
  } else {
    extraHeaders.push('Contact: '+ this.contact + ';expires=0');
  }

  reqContext.receiveResponse = function(response) {
    var cause;

    switch(true) {
      case /^1[0-9]{2}$/.test(response.status_code):
        this.emit('progress', response);
        break;
      case /^2[0-9]{2}$/.test(response.status_code):
        this.emit('accepted', response);
        if (reqContext.registrationExpiredTimer !== null) {
          clearTimeout(reqContext.registrationExpiredTimer);
          reqContext.registrationExpiredTimer = null;
        }
        this.unregistered(response, null, registrationTag);
        break;
      default:
        cause = SIP.Utils.sipErrorCause(response.status_code);
        this.unregistered(response,cause, registrationTag);
    }
  }.bind(this);

  reqContext.onRequestTimeout = function() {
    // Not actually unregistered...
    //this.unregistered(null, SIP.C.causes.REQUEST_TIMEOUT);
  }.bind(this);

  reqContext.onTransportError = function() {
    // Not actually unregistered...
    //this.unregistered(null, SIP.C.causes.CONNECTION_ERROR);
  }.bind(this);

  reqContext.cseq++;
  reqContext.request.cseq = reqContext.cseq;
  reqContext.request.setHeader('cseq', reqContext.cseq + ' REGISTER');
  reqContext.request.extraHeaders = extraHeaders;

  reqContext.send();
};

RegisterContext.prototype.unregistered = function(response, cause, registrationTag) {
  this.registered = false;
  this.emit('unregistered', response || null, cause || null, registrationTag);
  if (this.customClientContexts[registrationTag]) {
    delete this.customClientContexts[registrationTag];
  };
};

SIP.RegisterContext = RegisterContext;
};
