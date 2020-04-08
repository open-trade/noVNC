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

export default class Websock {
    constructor() {
        this._websocket = null;  // WebSocket object
        this._eventHandlers = {
            message: (msg) => {},
            open: () => {},
            close: () => {},
            error: () => {}
        };
        this._next_yuv = null;
    }

    send(msg) {
        if (msg instanceof Object) msg = proto.encodeMessage(msg);
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
        this._websocket.binaryType = 'arraybuffer';
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
        if (e.data instanceof window.ArrayBuffer) {
            const bytes = new Uint8Array(e.data);
            if (this._next_yuv) {
                const yuv = this._next_yuv;
                if (!yuv.y) {
                    yuv.y = { bytes, stride: yuv.format.stride };
                } else if (!yuv.u) {
                    yuv.u = { bytes, stride: yuv.format.stride >> 1 };
                } else {
                    yuv.v = { bytes, stride: yuv.format.stride >> 1 };
                    delete yuv.format.stride;
                    this._eventHandlers.message({ video_frame: { yuv } });
                    this._next_yuv = null;
                }
            } else {
                const msg = proto.decodeMessage(bytes);
                if (msg.video_frame && msg.video_frame.yuv) {
                    this._next_yuv = { format: msg.video_frame.yuv };
                    return;
                } else {
                    this._eventHandlers.message(msg);
                }
            }
        }
    }
}
