/*
 * Websock: high-performance binary WebSockets
 * Copyright (C) 2019 The noVNC Authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * Websock is similar to the standard WebSocket object but with extra
 * buffer handling.
 *
 * Websock has built-in receive queue buffering; the message event
 * does not contain actual data but is simply a notification that
 * there is new data available. Several rQ* methods are available to
 * read binary data off of the receive queue.
 */

import * as Log from './util/logging.js';
import * as proto from '../message.js';

// this has performance issues in some versions Chromium, and
// doesn't gain a tremendous amount of performance increase in Firefox
// at the moment.  It may be valuable to turn it on in the future.
// Also copyWithin() for TypedArrays is not supported in IE 11 or
// Safari 13 (at the moment we want to support Safari 11).
const ENABLE_COPYWITHIN = false;
const MAX_RQ_GROW_SIZE = 40 * 1024 * 1024;  // 40 MiB

export default class Websock {
    constructor() {
        this._websocket = null;  // WebSocket object
        this._eventHandlers = {
            message: () => {},
            open: () => {},
            close: () => {},
            error: () => {}
        };
    }

    send(msg) {
        this._websocket.send(msg);
    }

    // Event Handlers
    off(evt) {
        this._eventHandlers[evt] = () => {};
    }

    on(evt, handler) {
        this._eventHandlers[evt] = handler;
    }

    init() {
        this._websocket = null;
    }

    open(uri, protocols) {
        this.init();

        this._websocket = new WebSocket(uri, protocols);

        this._websocket.onmessage = this._recv_message.bind(this);
        this._websocket.onopen = () => {
            Log.Debug('>> WebSock.onopen');
            if (this._websocket.protocol) {
                Log.Info("Server choose sub-protocol: " + this._websocket.protocol);
            }

            this._eventHandlers.open();
            Log.Debug("<< WebSock.onopen");
        };
        this._websocket.onclose = (e) => {
            Log.Debug(">> WebSock.onclose");
            this._eventHandlers.close(e);
            Log.Debug("<< WebSock.onclose");
        };
        this._websocket.onerror = (e) => {
            Log.Debug(">> WebSock.onerror: " + e);
            this._eventHandlers.error(e);
            Log.Debug("<< WebSock.onerror: " + e);
        };
    }

    close() {
        if (this._websocket) {
            if ((this._websocket.readyState === WebSocket.OPEN) ||
                    (this._websocket.readyState === WebSocket.CONNECTING)) {
                Log.Info("Closing WebSocket connection");
                this._websocket.close();
            }

            this._websocket.onmessage = () => {};
        }
    }

    _recv_message(e) {
        const u8 = new Uint8Array(e.data);
        let msg = decodeMessage(u8);
        this._eventHandlers.message();
    }
}
